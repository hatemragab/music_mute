import Darwin
import Foundation

/// This bridge is native IPC only. Its bearer reply never enters Chrome messages,
/// preferences, account-state, diagnostics or command-line arguments.
enum BrowserProcessingBridge {
  static let preferenceSuite = "com.hatem.musicmute.local"
  static let requestLimit = 4096
  static let responseLimit = 32_768

  static func processingMode(preferences: UserDefaults) -> String {
    DesktopPreferenceNormalizer.normalize(
      preferences.string(forKey: DesktopPreferenceKey.processingMode) ?? "",
      fallback:
        DesktopProcessingPreference.local
    ).rawValue
  }

  static func preferences(bundleIdentifier: String? = Bundle.main.bundleIdentifier) -> UserDefaults?
  {
    bundleIdentifier == preferenceSuite ? .standard : UserDefaults(suiteName: preferenceSuite)
  }

  static func scope(uid: String, generation: String) throws -> DesktopSessionScope {
    guard uid.range(of: #"\A[A-Za-z0-9_.:@+-]{1,128}\z"#, options: .regularExpression) != nil,
      generation.range(
        of: #"\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z"#,
        options: .regularExpression) != nil,
      let uuid = UUID(uuidString: generation)
    else { throw DesktopAuthFailure.service("INVALID_BRIDGE_REQUEST") }
    return DesktopSessionScope(firebaseUid: uid, generation: uuid)
  }

  @MainActor static func execute(
    _ data: Data, preferences: UserDefaults,
    session: (DesktopSessionScope) async throws -> DesktopJSON
  ) async throws -> DesktopJSON {
    guard data.count <= requestLimit,
      let raw = try? JSONDecoder().decode(DesktopJSON.self, from: data),
      case .object(let values) = raw, let operation = values["operation"]?.string
    else { throw DesktopAuthFailure.service("INVALID_BRIDGE_REQUEST") }
    if operation == "settings" {
      guard Set(values.keys) == ["operation"] else {
        throw DesktopAuthFailure.service("INVALID_BRIDGE_REQUEST")
      }
      return .object(["processing_mode": .string(processingMode(preferences: preferences))])
    }
    guard operation == "session",
      Set(values.keys) == ["operation", "firebase_uid", "session_generation"],
      let uid = values["firebase_uid"]?.string,
      let generation = values["session_generation"]?.string
    else { throw DesktopAuthFailure.service("INVALID_BRIDGE_REQUEST") }
    return try await session(scope(uid: uid, generation: generation))
  }

  @MainActor static func authorizedSession(
    account: DesktopAccountModel, scope: DesktopSessionScope,
    verifyScope: @escaping @MainActor () throws -> Void
  ) async throws -> DesktopJSON {
    try await account.restoreForBrowserBridge(scope, verifyScope: verifyScope)
    let session = try await account.authorizedSession()
    try Task.checkCancellation()
    try verifyScope()
    guard session["firebase_uid"].string == scope.firebaseUid,
      session["session_generation"].string == scope.generation.uuidString.lowercased(),
      let token = session["id_token"].string,
      token.utf8.count <= 8192,
      token.range(
        of: #"\A[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\z"#,
        options: .regularExpression) != nil
    else { throw DesktopAuthFailure.sessionChanged }
    return .object([
      "firebase_uid": .string(scope.firebaseUid),
      "session_generation": .string(scope.generation.uuidString.lowercased()),
      "installation_id": .string(account.installationId), "id_token": .string(token),
    ])
  }

  static func verify(scope: DesktopSessionScope, support: URL) throws {
    let directory = open(support.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard directory >= 0 else { throw DesktopAuthFailure.service("ACCOUNT_STATE_UNSAFE") }
    defer { _ = close(directory) }
    var parent = stat()
    var namedParent = stat()
    guard support.path.hasPrefix("/"), fstat(directory, &parent) == 0,
      lstat(support.path, &namedParent) == 0,
      namedParent.st_ino == parent.st_ino, namedParent.st_dev == parent.st_dev,
      parent.st_mode & S_IFMT == S_IFDIR, parent.st_uid == geteuid(), parent.st_mode & 0o077 == 0
    else { throw DesktopAuthFailure.service("ACCOUNT_STATE_UNSAFE") }
    let descriptor = openat(directory, "account-state.json", O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else { throw DesktopAuthFailure.sessionChanged }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    defer { try? handle.close() }
    var before = stat()
    var named = stat()
    guard fstat(descriptor, &before) == 0,
      fstatat(directory, "account-state.json", &named, AT_SYMLINK_NOFOLLOW) == 0,
      before.st_mode & S_IFMT == S_IFREG, before.st_uid == geteuid(),
      before.st_nlink == 1, before.st_mode & 0o077 == 0,
      before.st_size > 0, before.st_size <= requestLimit,
      named.st_mode & S_IFMT == S_IFREG, named.st_ino == before.st_ino,
      named.st_dev == before.st_dev
    else { throw DesktopAuthFailure.service("ACCOUNT_STATE_UNSAFE") }
    var data = Data()
    while let chunk = try handle.read(upToCount: requestLimit + 1 - data.count), !chunk.isEmpty {
      data.append(chunk)
      if data.count > requestLimit { throw DesktopAuthFailure.service("ACCOUNT_STATE_UNSAFE") }
    }
    var after = stat()
    var namedAfter = stat()
    guard fstat(descriptor, &after) == 0,
      lstat(support.path, &namedParent) == 0,
      namedParent.st_mode & S_IFMT == S_IFDIR,
      namedParent.st_ino == parent.st_ino, namedParent.st_dev == parent.st_dev,
      namedParent.st_uid == geteuid(), namedParent.st_mode & 0o077 == 0,
      fstatat(directory, "account-state.json", &namedAfter, AT_SYMLINK_NOFOLLOW) == 0,
      before.st_size == after.st_size,
      before.st_mode == after.st_mode, before.st_uid == after.st_uid,
      after.st_nlink == 1,
      before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
      before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
      namedAfter.st_mode & S_IFMT == S_IFREG, namedAfter.st_ino == before.st_ino,
      namedAfter.st_dev == before.st_dev,
      let value = try? JSONDecoder().decode(DesktopJSON.self, from: data),
      case .object(let fields) = value,
      Set(fields.keys) == ["version", "firebase_uid", "session_generation"],
      fields["version"] == .number(1), fields["firebase_uid"]?.string == scope.firebaseUid,
      fields["session_generation"]?.string == scope.generation.uuidString.lowercased()
    else { throw DesktopAuthFailure.sessionChanged }
  }

  static func errorReply(_ error: Error) -> DesktopJSON {
    let code: String
    if error is CancellationError {
      code = "ACCOUNT_SESSION_CHANGED"
    } else if let failure = error as? DesktopAuthFailure {
      let allowed = Set([
        "INVALID_BRIDGE_REQUEST", "ACCOUNT_STATE_UNSAFE", "ACCOUNT_SESSION_CHANGED",
        "KEYCHAIN_UNAVAILABLE", "DESKTOP_ACCOUNT_CONFIGURATION_REQUIRED",
        "INVALID_ACCOUNT_RESPONSE",
        "SIGN_IN_CANCELLED", "ACCOUNT_REQUEST_FAILED", "INVALID_REFRESH_TOKEN", "TOKEN_EXPIRED",
        "USER_DISABLED", "USER_NOT_FOUND", "INVALID_GRANT", "INVALID_API_KEY", "PROJECT_NOT_FOUND",
        "RATE_LIMITED", "TOO_MANY_ATTEMPTS_TRY_LATER", "NETWORK_UNAVAILABLE",
      ])
      code = allowed.contains(failure.code) ? failure.code : "ACCOUNT_REQUEST_FAILED"
    } else {
      code = "ACCOUNT_REQUEST_FAILED"
    }
    return .object(["error_code": .string(code)])
  }

  @MainActor static func session(
    scope: DesktopSessionScope, preferences: UserDefaults, environment: [String: String]
  ) async throws -> DesktopJSON {
    let support =
      environment["MUSICMUTE_LOCAL_ROOT"].map { URL(fileURLWithPath: $0) }
      ?? LocalPaths.support
    try verify(scope: scope, support: support)
    let resources =
      environment["MUSICMUTE_LOCAL_APP_RESOURCES"].map { URL(fileURLWithPath: $0) }
      ?? Bundle.main.resourceURL
    let config: DesktopPublicConfiguration
    do { config = try DesktopPublicConfiguration.load(resources: resources) } catch {
      throw DesktopAuthFailure.configuration
    }
    guard let installation = preferences.string(forKey: "desktop.installationId"),
      let uuid = UUID(uuidString: installation),
      uuid.uuidString.lowercased() == installation
    else { throw DesktopAuthFailure.sessionChanged }
    let account = DesktopAccountModel(
      configuration: config,
      vault: DesktopKeychainVault(
        service: "com.hatem.musicmute.local.auth.\(config.firebaseProjectID)"),
      installationId: installation, preferences: preferences)
    return try await authorizedSession(account: account, scope: scope) {
      try verify(scope: scope, support: support)
    }
  }
  @MainActor static func run(expectedArguments: [String] = []) async {
    let reply: DesktopJSON
    do {
      let preferences = BrowserProcessingBridge.preferences()
      guard Array(CommandLine.arguments.dropFirst()) == expectedArguments, let preferences else {
        throw DesktopAuthFailure.service("INVALID_BRIDGE_REQUEST")
      }
      var data = Data()
      while let chunk = try FileHandle.standardInput.read(
        upToCount: BrowserProcessingBridge.requestLimit + 1 - data.count), !chunk.isEmpty
      {
        data.append(chunk)
        if data.count > BrowserProcessingBridge.requestLimit {
          throw DesktopAuthFailure.service("INVALID_BRIDGE_REQUEST")
        }
      }
      reply = try await BrowserProcessingBridge.execute(data, preferences: preferences) { scope in
        try await BrowserProcessingBridge.session(
          scope: scope, preferences: preferences, environment: ProcessInfo.processInfo.environment
        )
      }
    } catch { reply = BrowserProcessingBridge.errorReply(error) }
    do {
      let output = try JSONEncoder().encode(reply)
      guard output.count <= BrowserProcessingBridge.responseLimit else {
        throw DesktopAuthFailure.malformedResponse
      }
      try FileHandle.standardOutput.write(contentsOf: output + Data("\n".utf8))
    } catch {
      // stdout is the only response channel. Never include raw errors or stderr.
      try? FileHandle.standardOutput.write(
        contentsOf: Data("{\"error_code\":\"ACCOUNT_REQUEST_FAILED\"}\n".utf8))
    }
  }
}

#if MUSICMUTE_BROWSER_BRIDGE
  @main enum BrowserProcessingBridgeCommand {
    @MainActor static func main() async { await BrowserProcessingBridge.run() }
  }
#endif
