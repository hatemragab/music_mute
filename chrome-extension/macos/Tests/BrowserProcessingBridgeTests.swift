import Darwin
import Foundation

private enum BrowserBridgeTestFailure: Error { case failed(String) }
private func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
  if try !condition() { throw BrowserBridgeTestFailure.failed(message) }
}
@MainActor private final class BrowserBridgeVault: DesktopCredentialVault {
  var credential: DesktopCredential?
  var saves = 0
  var onLoad: (() -> Void)?
  func load() async throws -> DesktopCredential? {
    onLoad?()
    return credential
  }
  func save(_ value: DesktopCredential) throws {
    saves += 1
    credential = value
  }
  func remove() throws {
    throw BrowserBridgeTestFailure.failed("Broker must never remove credentials")
  }
}
private actor BrowserBridgeTransport: DesktopHTTPTransport {
  let reply: DesktopJSON
  let pause: Bool
  var count = 0
  private var blocked: CheckedContinuation<Void, Never>?
  private var started: CheckedContinuation<Void, Never>?
  init(reply: DesktopJSON = .null, pause: Bool = false) {
    self.reply = reply
    self.pause = pause
  }
  func send(_ request: URLRequest) async throws -> (Data, Int) {
    count += 1
    try require(
      request.url?.host == "securetoken.googleapis.com" && request.httpMethod == "POST",
      "Broker authorization may refresh credentials but must not bootstrap or publish cloud work")
    if pause {
      await withCheckedContinuation { continuation in
        blocked = continuation
        started?.resume()
        started = nil
      }
    }
    return (try JSONEncoder().encode(reply), 200)
  }
  func waitUntilBlocked() async {
    if blocked == nil { await withCheckedContinuation { started = $0 } }
  }
  func release() {
    blocked?.resume()
    blocked = nil
  }
}
@MainActor private final class BrowserBridgeScope {
  var current: DesktopSessionScope?
  init(_ scope: DesktopSessionScope) { current = scope }
  func verify(_ scope: DesktopSessionScope) throws {
    guard current == scope else { throw DesktopAuthFailure.sessionChanged }
  }
}

@main enum BrowserProcessingBridgeTests {
  static let uid = "fixture-browser-owner"
  static let project = "fixture-musicmute"
  static let installation = "00000000-0000-4000-8000-000000000042"
  @MainActor static var suites: [String] = []
  @MainActor static func preferences() -> UserDefaults {
    let name = "musicmute-browser-bridge-tests.\(UUID())"
    suites.append(name)
    return UserDefaults(suiteName: name)!
  }
  @MainActor static func token(uid: String = Self.uid, project: String = Self.project) throws
    -> String
  {
    let data = try JSONEncoder().encode(
      DesktopJSON.object([
        "sub": .string(uid), "aud": .string(project),
        "iss": .string("https://securetoken.google.com/\(project)"),
      ]))
    return "fixture.\(DesktopGoogleOAuth.base64URL(data)).fixture-signature"
  }
  @MainActor static func credential(expired: Bool = false, uid: String = Self.uid) throws
    -> DesktopCredential
  {
    DesktopCredential(
      firebaseUid: uid, idToken: try token(uid: uid),
      refreshToken: String(repeating: "r", count: 30),
      expiresAt: Date().addingTimeInterval(expired ? -60 : 3600), user: nil)
  }
  @MainActor static func refreshed(uid: String = Self.uid) throws -> DesktopJSON {
    .object([
      "user_id": .string(uid), "id_token": .string(try token(uid: uid)),
      "refresh_token": .string(String(repeating: "r", count: 30)), "expires_in": .string("3600"),
    ])
  }
  @MainActor private static func account(
    vault: BrowserBridgeVault, transport: BrowserBridgeTransport, preferences: UserDefaults
  ) -> DesktopAccountModel {
    DesktopAccountModel(
      configuration: DesktopPublicConfiguration(
        backendBaseURL: "https://api.example.invalid",
        firebaseAPIKey: String(repeating: "A", count: 39),
        firebaseProjectID: project, googleDesktopClientID: nil),
      vault: vault, transport: transport, installationId: installation, preferences: preferences)
  }
  @MainActor static func main() async throws {
    defer {
      for name in suites { UserDefaults(suiteName: name)?.removePersistentDomain(forName: name) }
    }
    try await settingsChecks()
    try await sessionChecks()
    try await refreshChecks()
    try await refreshFenceChecks()
    try stateChecks()
    try require(
      BrowserProcessingBridge.errorReply(NSError(domain: "fixture-private-error", code: 42))[
        "error_code"
      ]
      .string == "ACCOUNT_REQUEST_FAILED",
      "Raw errors must be reduced to a fixed safe code")
    try require(
      BrowserProcessingBridge.errorReply(DesktopAuthFailure.service("fixture-private-server-text"))[
        "error_code"
      ].string == "ACCOUNT_REQUEST_FAILED",
      "Unknown service text must never become a bridge reply")
    print(
      "Native browser bridge checks passed: persisted settings, bounded exact commands, app installation identity, owner/project/generation fences, refresh cancellation and revocation, private account-state permissions and symlink rejection."
    )
  }
  @MainActor static func settingsChecks() async throws {
    try require(
      BrowserProcessingBridge.preferences(
        bundleIdentifier: BrowserProcessingBridge.preferenceSuite) === UserDefaults.standard,
      "The packaged app must use its standard defaults instead of reopening its own suite")
    try require(
      BrowserProcessingBridge.preferences(bundleIdentifier: "fixture.browser.bridge")
        !== UserDefaults.standard,
      "The standalone helper must keep reading the app's shared preference suite")
    let defaults = preferences()
    try require(
      BrowserProcessingBridge.processingMode(preferences: defaults) == "local",
      "Missing processing preference must remain local")
    for malformed in ["", "Cloud", "automatic"] {
      defaults.set(malformed, forKey: DesktopPreferenceKey.processingMode)
      try require(
        BrowserProcessingBridge.processingMode(preferences: defaults) == "local",
        "Invalid processing preference must remain local")
    }
    defaults.set(42, forKey: DesktopPreferenceKey.processingMode)
    try require(
      BrowserProcessingBridge.processingMode(preferences: defaults) == "local",
      "Non-string processing preference must remain local")
    for mode in ["cloud", "local"] {
      defaults.set(mode, forKey: DesktopPreferenceKey.processingMode)
      let reply = try await BrowserProcessingBridge.execute(
        Data(#"{"operation":"settings"}"#.utf8), preferences: defaults
      ) { _ in
        throw BrowserBridgeTestFailure.failed("Settings must not access credentials or network")
      }
      try require(
        reply == .object(["processing_mode": .string(mode)]), "Saved mode must round-trip")
    }
    for raw in [
      #"{"operation":"settings","id_token":"private"}"#,
      #"{"operation":"session","firebase_uid":"fixture","session_generation":"invalid"}"#,
      #"{"operation":"session"}"#, #"{"operation":"unknown"}"#, "[]", "null", "invalid",
      String(repeating: "x", count: BrowserProcessingBridge.requestLimit + 1),
    ] {
      do {
        _ = try await BrowserProcessingBridge.execute(Data(raw.utf8), preferences: defaults) { _ in
          throw BrowserBridgeTestFailure.failed(
            "Malformed commands must not reach session retrieval")
        }
        throw BrowserBridgeTestFailure.failed("Malformed bridge input must be rejected")
      } catch let failure as DesktopAuthFailure {
        try require(
          failure.code == "INVALID_BRIDGE_REQUEST", "Malformed requests need a fixed code")
      }
    }
    let scope = DesktopSessionScope(firebaseUid: uid, generation: UUID())
    let request = try JSONEncoder().encode(
      DesktopJSON.object([
        "operation": .string("session"), "firebase_uid": .string(uid),
        "session_generation": .string(scope.generation.uuidString.lowercased()),
      ]))
    _ = try await BrowserProcessingBridge.execute(request, preferences: defaults) { received in
      try require(received == scope, "Validated commands must preserve authoritative scope")
      return .null
    }
  }
  @MainActor static func sessionChecks() async throws {
    let defaults = preferences()
    let vault = BrowserBridgeVault()
    vault.credential = try credential()
    let transport = BrowserBridgeTransport()
    let scope = DesktopSessionScope(firebaseUid: uid, generation: UUID())
    let authority = BrowserBridgeScope(scope)
    let model = account(vault: vault, transport: transport, preferences: defaults)
    var publications = 0
    model.onSessionChanged = { _ in publications += 1 }
    let reply = try await BrowserProcessingBridge.authorizedSession(account: model, scope: scope) {
      try authority.verify(scope)
    }
    try require(
      reply["firebase_uid"].string == uid
        && reply["session_generation"].string == scope.generation.uuidString.lowercased()
        && reply["installation_id"].string == installation
        && reply["id_token"].string == vault.credential?.idToken,
      "Native reply must use the existing app account, generation and installation")
    try require(
      model.scope == scope && publications == 0 && vault.saves == 0,
      "Restore must not rotate or publish")
    let requests = await transport.count
    try require(requests == 0, "A valid stored token must not cause network requests")
    try require(
      defaults.object(forKey: "desktop.installationId") == nil
        && defaults.object(forKey: "desktop.signedOut.\(project)") == nil,
      "Broker retrieval must not overwrite app installation or sign-out preferences")

    for change in ["missing", "owner", "project", "load-revocation", "signed-out"] {
      let nextVault = BrowserBridgeVault()
      nextVault.credential = try credential()
      let nextPreferences = preferences()
      let nextAuthority = BrowserBridgeScope(scope)
      switch change {
      case "missing": nextVault.credential = nil
      case "owner": nextVault.credential = try credential(uid: "another-owner")
      case "project":
        nextVault.credential = DesktopCredential(
          firebaseUid: uid, idToken: try token(project: "another-project"),
          refreshToken: String(repeating: "r", count: 30),
          expiresAt: Date().addingTimeInterval(3600),
          user: nil)
      case "load-revocation": nextVault.onLoad = { nextAuthority.current = nil }
      default: nextPreferences.set(true, forKey: "desktop.signedOut.\(project)")
      }
      let next = account(
        vault: nextVault, transport: BrowserBridgeTransport(), preferences: nextPreferences)
      do {
        _ = try await BrowserProcessingBridge.authorizedSession(account: next, scope: scope) {
          try nextAuthority.verify(scope)
        }
        throw BrowserBridgeTestFailure.failed("Revoked or mismatched credentials must be rejected")
      } catch let failure as DesktopAuthFailure {
        try require(failure == .sessionChanged, "Credential fences must report session changed")
      }
      try require(nextVault.saves == 0, "Rejected restore must not write credentials")
    }
  }
  @MainActor static func refreshChecks() async throws {
    let defaults = preferences()
    let vault = BrowserBridgeVault()
    vault.credential = try credential(expired: true)
    let transport = BrowserBridgeTransport(reply: try refreshed())
    let scope = DesktopSessionScope(firebaseUid: uid, generation: UUID())
    let model = account(vault: vault, transport: transport, preferences: defaults)
    let reply = try await BrowserProcessingBridge.authorizedSession(account: model, scope: scope) {}
    let requests = await transport.count
    try require(
      reply["id_token"].string == vault.credential?.idToken && requests == 1 && vault.saves == 1
        && model.scope == scope,
      "Expired credentials must refresh once through the existing account authorization flow")
    try require(
      defaults.object(forKey: "desktop.signedOut.\(project)") == nil,
      "Broker refresh must not clear the app sign-out preference")
  }
  @MainActor static func refreshFenceChecks() async throws {
    for change in ["revoked", "generation", "signed-out", "cancelled", "owner"] {
      let defaults = preferences()
      let vault = BrowserBridgeVault()
      vault.credential = try credential(expired: true)
      let transport = BrowserBridgeTransport(
        reply: try refreshed(uid: change == "owner" ? "another-owner" : uid), pause: true)
      let scope = DesktopSessionScope(firebaseUid: uid, generation: UUID())
      let authority = BrowserBridgeScope(scope)
      let model = account(vault: vault, transport: transport, preferences: defaults)
      let operation = Task { @MainActor in
        try await BrowserProcessingBridge.authorizedSession(account: model, scope: scope) {
          try authority.verify(scope)
        }
      }
      await transport.waitUntilBlocked()
      switch change {
      case "revoked": authority.current = nil
      case "generation":
        authority.current = DesktopSessionScope(firebaseUid: uid, generation: UUID())
      case "signed-out": defaults.set(true, forKey: "desktop.signedOut.\(project)")
      case "cancelled": operation.cancel()
      default: break
      }
      await transport.release()
      do {
        _ = try await operation.value
        throw BrowserBridgeTestFailure.failed(
          "Stale or cancelled refresh must never expose a token")
      } catch is DesktopAuthFailure {} catch is CancellationError {}
      try require(vault.saves == 0, "Stale refresh must not recreate revoked Keychain credentials")
    }
  }
  static func stateChecks() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "musicmute-browser-state-\(UUID())", isDirectory: true)
    try FileManager.default.createDirectory(
      at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: root) }
    let store = DesktopAccountStateStore(support: root)
    let scope = DesktopSessionScope(firebaseUid: uid, generation: UUID())
    let path = root.appendingPathComponent("account-state.json")
    try store.publish(scope)
    try BrowserProcessingBridge.verify(scope: scope, support: root)
    for candidate in [
      DesktopSessionScope(firebaseUid: "another-owner", generation: scope.generation),
      DesktopSessionScope(firebaseUid: uid, generation: UUID()),
    ] {
      try rejectedState(scope: candidate, support: root)
    }
    try store.publish(nil)
    try rejectedState(scope: scope, support: root)
    try store.publish(scope)
    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: path.path)
    try rejectedState(scope: scope, support: root)
    try store.publish(scope)
    let alias = root.appendingPathComponent("state-alias.json")
    try FileManager.default.linkItem(at: path, to: alias)
    try rejectedState(scope: scope, support: root)
    try FileManager.default.removeItem(at: alias)
    try FileManager.default.moveItem(at: path, to: alias)
    try FileManager.default.createSymbolicLink(at: path, withDestinationURL: alias)
    try rejectedState(scope: scope, support: root)
    try FileManager.default.removeItem(at: path)
    try store.publish(scope)
    try Data(String(repeating: "x", count: BrowserProcessingBridge.requestLimit + 1).utf8).write(
      to: path)
    try rejectedState(scope: scope, support: root)
    try store.publish(scope)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.path)
    try rejectedState(scope: scope, support: root)
  }
  static func rejectedState(scope: DesktopSessionScope, support: URL) throws {
    do {
      try BrowserProcessingBridge.verify(scope: scope, support: support)
      throw BrowserBridgeTestFailure.failed("Unsafe or mismatched authority must be rejected")
    } catch is DesktopAuthFailure {}
  }
}
