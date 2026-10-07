import AppKit
import CryptoKit
import Foundation
import Network
import Security

enum DesktopJSON: Codable, Sendable, Equatable {
  case object([String: DesktopJSON])
  case array([DesktopJSON])
  case string(String)
  case number(Double)
  case bool(Bool)
  case null
  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let v = try? c.decode(Bool.self) {
      self = .bool(v)
    } else if let v = try? c.decode(String.self) {
      self = .string(v)
    } else if let v = try? c.decode(Double.self), v.isFinite {
      self = .number(v)
    } else if let v = try? c.decode([String: DesktopJSON].self) {
      self = .object(v)
    } else {
      self = .array(try c.decode([DesktopJSON].self))
    }
  }
  func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .object(let v): try c.encode(v)
    case .array(let v): try c.encode(v)
    case .string(let v): try c.encode(v)
    case .number(let v): try c.encode(v)
    case .bool(let v): try c.encode(v)
    case .null: try c.encodeNil()
    }
  }
  subscript(_ key: String) -> DesktopJSON {
    if case .object(let v) = self { return v[key] ?? .null }
    return .null
  }
  var string: String? {
    if case .string(let v) = self { return v }
    return nil
  }
  var bool: Bool? {
    if case .bool(let v) = self { return v }
    return nil
  }
  var number: Double? {
    if case .number(let v) = self { return v }
    return nil
  }
  var array: [DesktopJSON] {
    if case .array(let v) = self { return v }
    return []
  }
}

struct DesktopPublicConfiguration: Codable, Sendable {
  let backendBaseURL: String
  let firebaseAPIKey: String
  let firebaseProjectID: String
  let googleDesktopClientID: String?
  enum CodingKeys: String, CodingKey {
    case backendBaseURL = "backend_base_url"
    case firebaseAPIKey = "firebase_api_key"
    case firebaseProjectID = "firebase_project_id"
    case googleDesktopClientID = "google_desktop_client_id"
  }
  func validate() throws {
    guard let url = URL(string: backendBaseURL), url.scheme == "https", url.host != nil,
      url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
      url.path.isEmpty || url.path == "/", firebaseAPIKey.count >= 20, firebaseAPIKey.count <= 200,
      firebaseAPIKey.allSatisfy({
        $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-")
      }),
      firebaseProjectID.range(of: "^[a-z][a-z0-9-]{4,62}$", options: .regularExpression) != nil,
      googleDesktopClientID.map({
        $0.range(
          of: "^[0-9]+-[A-Za-z0-9_-]+\\.apps\\.googleusercontent\\.com$",
          options: .regularExpression) != nil
      }) != false
    else { throw DesktopAuthFailure.configuration }
  }
  static func load(resources: URL?) throws -> Self {
    guard let resources else { throw DesktopAuthFailure.configuration }
    let data = try Data(contentsOf: resources.appendingPathComponent("desktop-public-config.json"))
    guard data.count <= 16_384 else { throw DesktopAuthFailure.configuration }
    let config = try JSONDecoder().decode(Self.self, from: data)
    try config.validate()
    return config
  }
}

enum DesktopAuthFailure: Error, Equatable {
  case configuration, sessionChanged, credentialsUnavailable, malformedResponse, cancelled
  case service(String)
  var signInJournalCode: String? {
    if self == .cancelled { return nil }
    let allowed = Set([
      "GOOGLE_SIGN_IN_TIMEOUT", "GOOGLE_TOKEN_INVALID_CLIENT", "GOOGLE_TOKEN_INVALID_GRANT",
      "GOOGLE_TOKEN_INVALID_REQUEST", "GOOGLE_TOKEN_REDIRECT_MISMATCH", "GOOGLE_TOKEN_UNAVAILABLE",
      "GOOGLE_CLIENT_SECRET_REQUIRED", "GOOGLE_TOKEN_EXCHANGE_FAILED",
    ])
    return allowed.contains(code) ? code : "AUTH_SIGN_IN_FAILED"
  }
  var requiresRuntimePreparation: Bool {
    switch self {
    case .service("APP_RUNTIME_NOT_PREPARED"), .service("APP_RUNTIME_INCOMPATIBLE"): true
    default: false
    }
  }
  var code: String {
    switch self {
    case .configuration: "DESKTOP_ACCOUNT_CONFIGURATION_REQUIRED"
    case .sessionChanged: "ACCOUNT_SESSION_CHANGED"
    case .credentialsUnavailable: "KEYCHAIN_UNAVAILABLE"
    case .malformedResponse: "INVALID_ACCOUNT_RESPONSE"
    case .cancelled: "SIGN_IN_CANCELLED"
    case .service(let value): safeIdentifier(value) ? value : "ACCOUNT_REQUEST_FAILED"
    }
  }
  var message: String {
    switch self {
    case .configuration:
      "Account services need a public desktop configuration. Local YouTube processing remains available."
    case .credentialsUnavailable:
      "MusicMute could not securely access macOS Keychain. No credentials were saved to disk."
    case .sessionChanged: "Your account changed. Sign in again to continue."
    case .cancelled: "Google sign-in was cancelled."
    case .malformedResponse: "The account service returned an invalid response."
    case .service(let code):
      switch code {
      case "INVALID_LOGIN_CREDENTIALS", "INVALID_PASSWORD", "EMAIL_NOT_FOUND":
        "The email or password is incorrect."
      case "EMAIL_EXISTS": "An account already uses this email. Try signing in."
      case "USER_DISABLED", "ACCOUNT_DISABLED": "This account is disabled."
      case "ACCOUNT_DELETION_PENDING":
        "Account deletion is pending. You can request recovery during the recovery period."
      case "RATE_LIMITED", "TOO_MANY_ATTEMPTS_TRY_LATER":
        "Too many attempts. Please try again later."
      case "CREDENTIAL_TOO_OLD_LOGIN_AGAIN", "FRESH_AUTH_REQUIRED":
        "Sign in again before changing account security."
      case "NETWORK_UNAVAILABLE": "You are offline. Your local voice library remains available."
      case "UPDATE_INSTALLING":
        "MusicMute is installing an update. Wait for the app to restart, then try again."
      case "UPDATE_LOCK_UNSAFE":
        "MusicMute could not safely coordinate this update. Restart the app and check its local setup."
      case "APP_RUNTIME_NOT_PREPARED":
        "Open Setup and choose Prepare my Mac before using local processing."
      case "APP_RUNTIME_INCOMPATIBLE":
        "This app version needs its matching processing tools. Open Setup and prepare this version."
      case "SOURCE_BOT_CHALLENGE", "ACQUISITION_RATE_LIMITED", "ACQUISITION_COOLDOWN":
        "YouTube refused this guest request or limited access. Wait for the cooldown, use a saved voice, or explicitly choose MusicMute cloud. Signing in to Chrome does not sign in the local downloader."
      case "SOURCE_TOKEN_REQUIRED":
        "YouTube requires a valid playback token. Open Setup to check the included token provider, or check for an app update. Cloud processing is an optional account choice."
      case "SOURCE_CHALLENGE_FAILED", "YT_DLP_EJS_MISSING", "YT_DLP_JS_CHALLENGE",
        "JAVASCRIPT_RUNTIME_UNAVAILABLE", "JAVASCRIPT_RUNTIME_INVALID", "EJS_UNAVAILABLE",
        "DENO_MISSING", "DENO_VERSION_INVALID":
        "The YouTube JavaScript challenge could not be solved. Open Setup to check Deno and the challenge solver, then check for an app update."
      case "TOKEN_PROVIDER_UNAVAILABLE", "TOKEN_PROVIDER_INVALID", "TOKEN_PROVIDER_TIMEOUT",
        "TOKEN_PROVIDER_FAILED", "PO_TOKEN_PROVIDER_MISSING", "PO_TOKEN_PROVIDER_INVALID",
        "PO_TOKEN_PROVIDER_UNAVAILABLE":
        "The playback token provider could not complete. Open Setup to check the included tools. Local files and saved voices remain available."
      case "PROCESSING_ALLOWANCE_EXHAUSTED", "PROCESSING_QUOTA_EXCEEDED",
        "PROCESSING_ALLOWANCE_EXCEEDED", "PROCESSING_USAGE_EXCEEDED", "PROCESSING_LIMIT_REACHED":
        "Your cloud processing allowance is exhausted. Review your account allowance and reset date, or process locally when available."
      case "RETAINED_STORAGE_LIMIT_REACHED":
        "Your account storage allowance is full. Review your account storage before saving another result."
      case "UPLOAD_GRANT_LIMIT_REACHED", "UPLOAD_BYTE_LIMIT_REACHED",
        "DOWNLOAD_GRANT_LIMIT_REACHED", "DOWNLOAD_BYTE_LIMIT_REACHED",
        "SERVICE_BANDWIDTH_LIMIT_REACHED":
        "The account transfer allowance is unavailable. Review your allowance and reset date. Your saved local voices remain available."
      case "SOURCE_ACCESS_RESTRICTED", "SOURCE_AUTH_REQUIRED", "SOURCE_HTTP_FORBIDDEN",
        "SOURCE_HTTP_UNAUTHORIZED", "SOURCE_AGE_RESTRICTED", "SOURCE_UNAVAILABLE":
        "This video is unavailable to the guest downloader. Use audio you can access and have permission to process."
      case "INSUFFICIENT_DISK_SPACE", "ENOSPC":
        "There is not enough free space. Free space on your Mac, then retry. Saved voices remain available."
      case "GOOGLE_SIGN_IN_TIMEOUT":
        "Google sign-in timed out. Start again and complete the sign-in in your browser."
      case "GOOGLE_TOKEN_INVALID_CLIENT", "GOOGLE_TOKEN_REDIRECT_MISMATCH",
        "GOOGLE_CLIENT_SECRET_REQUIRED":
        "Google sign-in needs an updated desktop app configuration. Local processing remains available."
      case "GOOGLE_TOKEN_INVALID_GRANT":
        "Google sign-in expired or could not be verified. Start again in your browser."
      case "GOOGLE_TOKEN_UNAVAILABLE":
        "Google sign-in is temporarily unavailable. Try again shortly."
      case "GOOGLE_TOKEN_INVALID_REQUEST", "GOOGLE_TOKEN_EXCHANGE_FAILED":
        "Google sign-in could not complete. Start again in your browser."
      default:
        "The account action could not finish (\(safeIdentifier(code) ? code : "ACCOUNT_REQUEST_FAILED"))."
      }
    }
  }
}

struct DesktopUser: Codable, Sendable, Equatable {
  let id: String
  let displayName: String
  let email: String?
  let emailVerified: Bool
  let providers: [String]
  var workerRegistrationAllowed = false
  enum CodingKeys: String, CodingKey {
    case id, email, providers
    case displayName = "display_name"
    case emailVerified = "email_verified"
    case workerRegistrationAllowed = "worker_registration_allowed"
  }
  init(
    id: String, displayName: String, email: String?, emailVerified: Bool, providers: [String],
    workerRegistrationAllowed: Bool = false
  ) {
    self.id = id
    self.displayName = displayName
    self.email = email
    self.emailVerified = emailVerified
    self.providers = providers
    self.workerRegistrationAllowed = workerRegistrationAllowed
  }
  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    id = try values.decode(String.self, forKey: .id)
    displayName = try values.decode(String.self, forKey: .displayName)
    email = try values.decodeIfPresent(String.self, forKey: .email)
    emailVerified = try values.decode(Bool.self, forKey: .emailVerified)
    providers = try values.decode([String].self, forKey: .providers)
    workerRegistrationAllowed =
      try values.decodeIfPresent(Bool.self, forKey: .workerRegistrationAllowed) ?? false
  }
}
struct DesktopCredential: Codable, Sendable {
  let firebaseUid: String
  let idToken: String
  let refreshToken: String
  let expiresAt: Date
  var user: DesktopUser?
}
struct DesktopSessionScope: Sendable, Equatable {
  let firebaseUid: String
  let generation: UUID
}
@MainActor protocol DesktopCredentialVault {
  func load() async throws -> DesktopCredential?
  func save(_ credential: DesktopCredential) throws
  func remove() throws
}
@MainActor final class DesktopKeychainVault: DesktopCredentialVault {
  private let service: String
  init(service: String = "com.hatem.musicmute.local.auth") { self.service = service }
  private var query: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: "firebase-session", kSecAttrSynchronizable as String: false,
    ]
  }
  func load() async throws -> DesktopCredential? {
    let service = service
    return try await Task.detached(priority: .utility) { try Self.load(service: service) }.value
  }
  nonisolated private static func load(service: String) throws -> DesktopCredential? {
    let lookup: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: "firebase-session", kSecAttrSynchronizable as String: false,
      kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(lookup as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data, data.count <= 32_768,
      let value = try? JSONDecoder().decode(DesktopCredential.self, from: data)
    else { throw DesktopAuthFailure.credentialsUnavailable }
    return value
  }
  func save(_ credential: DesktopCredential) throws {
    let data = try JSONEncoder().encode(credential)
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      guard
        SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
          == errSecSuccess
      else { throw DesktopAuthFailure.credentialsUnavailable }
    } else if status != errSecSuccess {
      throw DesktopAuthFailure.credentialsUnavailable
    }
  }
  func remove() throws {
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw DesktopAuthFailure.credentialsUnavailable
    }
  }
}

protocol DesktopHTTPTransport: Sendable {
  func send(_ request: URLRequest) async throws -> (Data, Int)
}
private final class DesktopBoundedResponse: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private let limit: Int
  private var finished = false
  private var continuation: CheckedContinuation<(Data, Int), Error>?
  private var session: URLSession?
  private var task: URLSessionDataTask?
  private var data = Data()
  private var status: Int?
  init(limit: Int) { self.limit = limit }
  func send(_ request: URLRequest, configuration: URLSessionConfiguration) async throws -> (
    Data, Int
  ) {
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        lock.lock()
        guard !finished else {
          lock.unlock()
          continuation.resume(throwing: DesktopAuthFailure.cancelled)
          return
        }
        self.continuation = continuation
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        self.session = session
        let task = session.dataTask(with: request)
        self.task = task
        task.resume()
        lock.unlock()
      }
    } onCancel: {
      self.finish(.failure(DesktopAuthFailure.cancelled))
    }
  }
  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    guard let http = response as? HTTPURLResponse else {
      finish(.failure(DesktopAuthFailure.malformedResponse))
      completionHandler(.cancel)
      return
    }
    let lengthHeader = http.value(forHTTPHeaderField: "Content-Length")
    let declaredLength = lengthHeader.flatMap(Int64.init)
    guard response.expectedContentLength <= Int64(limit),
      lengthHeader == nil || declaredLength.map({ $0 >= 0 && $0 <= Int64(limit) }) == true
    else {
      finish(.failure(DesktopAuthFailure.malformedResponse))
      completionHandler(.cancel)
      return
    }
    lock.lock()
    let active = !finished
    if active { status = http.statusCode }
    lock.unlock()
    completionHandler(active ? .allow : .cancel)
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
    lock.lock()
    guard !finished else {
      lock.unlock()
      return
    }
    let oversized = chunk.count > limit - data.count
    if !oversized { data.append(chunk) }
    lock.unlock()
    if oversized { finish(.failure(DesktopAuthFailure.malformedResponse)) }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if let error {
      let failure: DesktopAuthFailure =
        (error as? URLError)?.code == .cancelled ? .cancelled : .service("NETWORK_UNAVAILABLE")
      finish(.failure(failure))
      return
    }
    lock.lock()
    let result: Swift.Result<(Data, Int), Error> =
      status.map { .success((data, $0)) } ?? .failure(DesktopAuthFailure.malformedResponse)
    lock.unlock()
    finish(result)
  }
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) { completionHandler(nil) }
  private func finish(_ result: Swift.Result<(Data, Int), Error>) {
    lock.lock()
    guard !finished else {
      lock.unlock()
      return
    }
    finished = true
    let continuation = self.continuation
    let task = self.task
    let session = self.session
    self.continuation = nil
    self.task = nil
    self.session = nil
    data = Data()
    lock.unlock()
    task?.cancel()
    session?.invalidateAndCancel()
    continuation?.resume(with: result)
  }
}
final class DesktopURLSessionTransport: DesktopHTTPTransport, @unchecked Sendable {
  private let configuration: URLSessionConfiguration
  init(configuration: URLSessionConfiguration = .ephemeral) {
    let config = configuration.copy() as? URLSessionConfiguration ?? .ephemeral
    config.httpShouldSetCookies = false
    config.httpCookieStorage = nil
    config.urlCredentialStorage = nil
    config.urlCache = nil
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    config.timeoutIntervalForRequest = 30
    config.timeoutIntervalForResource = 45
    self.configuration = config
  }
  func send(_ request: URLRequest) async throws -> (Data, Int) {
    let limit =
      request.url?.path == "/auth/desktop-google-token-exchanges" ? 32_768 : 2 * 1024 * 1024
    let response = DesktopBoundedResponse(limit: limit)
    return try await response.send(request, configuration: configuration)
  }
}

struct DesktopInstallationMetadata: Codable, Equatable, Sendable {
  let appVersion: String
  let buildNumber: Int
  let osVersion: String
  let deviceModel: String

  static var current: Self {
    Self(
      appVersion:
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        ?? "0.1.0",
      buildNumber: Int(
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1")
        ?? 1,
      osVersion: ProcessInfo.processInfo.operatingSystemVersionString,
      deviceModel: "Apple Silicon Mac")
  }

  var isValid: Bool {
    func text(_ value: String, limit: Int) -> Bool {
      (1...limit).contains(value.count)
        && value.rangeOfCharacter(from: .controlCharacters) == nil
    }
    return text(appVersion, limit: 32) && (1...Int(Int32.max)).contains(buildNumber)
      && text(osVersion, limit: 64) && text(deviceModel, limit: 100)
  }
}

private struct DesktopInstallationReport: Codable {
  static let maximumRevision: Int64 = 9_007_199_254_740_991
  let installationId: String
  let metadata: DesktopInstallationMetadata
  var revision: Int64
  var body: DesktopJSON {
    .object([
      "installation_id": .string(installationId), "platform": .string("macos"),
      "app_version": .string(metadata.appVersion),
      "build_number": .number(Double(metadata.buildNumber)),
      "metadata_revision": .number(Double(revision)), "os_version": .string(metadata.osVersion),
      "device_model": .string(metadata.deviceModel),
    ])
  }
}

private enum DesktopBootstrapFailure: Error { case deviceReportConflict }

@MainActor final class DesktopAccountModel: ObservableObject {
  @Published private(set) var user: DesktopUser?
  @Published private(set) var firebaseUid: String?
  @Published private(set) var generation = UUID()
  @Published private(set) var busy = false
  @Published private(set) var online = false
  @Published private(set) var deletionPending = false
  @Published var failure: DesktopAuthFailure?
  @Published var notice: String?
  @Published private(set) var access = DesktopJSON.null
  @Published private(set) var policy = DesktopJSON.null
  @Published private(set) var devices: [DesktopJSON] = []
  @Published private(set) var recovery = DesktopJSON.null
  @Published private(set) var verificationRetryAt: Date?
  @Published private(set) var resetRetryAt: Date?
  // A saved profile is not current registration authorization. Only fresh backend replies set this.
  @Published private(set) var workerRegistrationPermission: Bool?
  let configuration: DesktopPublicConfiguration?
  let installationId: String
  private let vault: any DesktopCredentialVault
  private let transport: any DesktopHTTPTransport
  private let preferences: UserDefaults
  private let installationMetadata: DesktopInstallationMetadata?
  private var installationReportKey: String { "desktop.installationReport.\(installationId)" }
  private let stateStore: DesktopAccountStateStore?
  private let googleBrowserDeadline: Duration
  private let openGoogleBrowser: @MainActor (URL) -> Bool
  private var signedOutKey: String {
    "desktop.signedOut.\(configuration?.firebaseProjectID ?? "unconfigured")"
  }
  private var credential: DesktopCredential?
  @Published private(set) var restoring = false
  private var refreshTask: Task<DesktopCredential, Error>?
  // Native browser requests reuse the app's published scope without publishing
  // or rotating it. Recheck that authority before refreshed credentials are saved.
  private var browserScopeFence: (@MainActor () throws -> Void)?
  private var google: DesktopGoogleOAuth?
  private struct GoogleAttempt {
    let id = UUID()
    let generation: UUID
    var cancelled = false
  }
  private var googleAttempt: GoogleAttempt?
  private var cancelGoogleRequest: (@MainActor () -> Void)?
  private let journal: UIJournal?
  var onSessionChanged: ((DesktopSessionScope?) -> Void)?
  var scope: DesktopSessionScope? {
    firebaseUid.map { DesktopSessionScope(firebaseUid: $0, generation: generation) }
  }
  var signedIn: Bool { credential != nil }
  var googleConfigured: Bool { configuration?.googleDesktopClientID != nil }
  var googleSignInActive: Bool { googleAttempt != nil }
  var currentSignInProvider: String? {
    credential.flatMap { Self.tokenClaims($0.idToken)?["firebase"]["sign_in_provider"].string }
  }
  func receiveWorkerRegistration(_ value: Bool?, scope: DesktopSessionScope) {
    guard self.scope == scope else { return }
    workerRegistrationPermission = value
  }
  var authenticating: Bool {
    busy || restoring || googleAttempt != nil || refreshTask != nil
  }
  var requiredBuild: Int? {
    guard let value = policy["platforms"]["macos"]["minimum_build"].number,
      value.rounded() == value, value >= 1, value <= 2_147_483_647
    else { return nil }
    return Int(value)
  }
  var updateRequired: Bool {
    let build =
      Int(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1") ?? 1
    return requiredBuild.map { build < $0 } ?? false
  }
  func receivePolicy(_ value: DesktopJSON) { policy = value }
  func loadPublicPolicy() async {
    guard configuration != nil else { return }
    do { policy = try await api("GET", "/app-policy", authenticated: false) } catch {
      // A missing network response is not an invented update requirement.
    }
  }

  init(
    configuration: DesktopPublicConfiguration? = nil,
    vault: (any DesktopCredentialVault)? = nil,
    transport: any DesktopHTTPTransport = DesktopURLSessionTransport(),
    installationId: String? = nil, installationMetadata: DesktopInstallationMetadata? = nil,
    preferences: UserDefaults = .standard,
    stateStore: DesktopAccountStateStore? = nil, journal: UIJournal? = nil,
    googleBrowserDeadline: Duration = DesktopGoogleOAuth.browserWaitLimit,
    openGoogleBrowser: @escaping @MainActor (URL) -> Bool = { NSWorkspace.shared.open($0) }
  ) {
    self.configuration = configuration
    self.journal = journal
    self.googleBrowserDeadline = googleBrowserDeadline
    self.openGoogleBrowser = openGoogleBrowser
    self.vault =
      vault
      ?? DesktopKeychainVault(
        service:
          "com.hatem.musicmute.local.auth.\(configuration?.firebaseProjectID ?? "unconfigured")")
    self.transport = transport
    self.preferences = preferences
    self.installationMetadata = installationMetadata
    self.stateStore = stateStore ?? (vault == nil ? DesktopAccountStateStore() : nil)
    let stored = preferences.string(forKey: "desktop.installationId")
    let selected = installationId ?? stored ?? UUID().uuidString.lowercased()
    self.installationId =
      UUID(uuidString: selected)?.uuidString.lowercased() ?? UUID().uuidString.lowercased()
    if installationId == nil {
      preferences.set(self.installationId, forKey: "desktop.installationId")
    }
    if preferences.bool(forKey: signedOutKey) {
      preferences.set(
        DesktopProcessingPreference.local.rawValue,
        forKey: DesktopPreferenceKey.processingMode)
    }
  }
  func restore() async {
    guard !restoring, restoreIsCurrent(generation) else { return }
    restoring = true
    defer { restoring = false }
    let epoch = generation
    try? stateStore?.publish(nil)
    let loaded: DesktopCredential?
    do { loaded = try await vault.load() } catch {
      guard restoreIsCurrent(epoch) else { return }
      failure = authFailure(error)
      return
    }
    guard restoreIsCurrent(epoch) else { return }
    guard let stored = loaded else {
      preferences.set(
        DesktopProcessingPreference.local.rawValue,
        forKey: DesktopPreferenceKey.processingMode)
      return
    }
    do {
      guard let config = configuration,
        Self.belongsToProject(
          stored.idToken, project: config.firebaseProjectID, uid: stored.firebaseUid)
      else { throw DesktopAuthFailure.sessionChanged }
      credential = stored
      firebaseUid = stored.firebaseUid
      user = stored.user
      generation = UUID()
      try stateStore?.publish(scope)
      onSessionChanged?(scope)
      await perform { try await self.bootstrap() }
    } catch { failure = authFailure(error) }
  }
  private func restoreIsCurrent(_ epoch: UUID) -> Bool {
    generation == epoch && !busy && credential == nil && !preferences.bool(forKey: signedOutKey)
      && !Task.isCancelled
  }
  func restoreForBrowserBridge(
    _ expected: DesktopSessionScope, verifyScope: @escaping @MainActor () throws -> Void
  ) async throws {
    guard credential == nil, !restoring, !busy,
      !preferences.bool(forKey: signedOutKey), let config = configuration
    else { throw DesktopAuthFailure.sessionChanged }
    try config.validate()
    try Task.checkCancellation()
    try verifyScope()
    let stored = try await vault.load()
    try Task.checkCancellation()
    try verifyScope()
    guard !preferences.bool(forKey: signedOutKey), let stored,
      stored.firebaseUid == expected.firebaseUid,
      stored.idToken.utf8.count <= 8192,
      stored.refreshToken.utf8.count >= 20, stored.refreshToken.utf8.count <= 16_384,
      Self.belongsToProject(
        stored.idToken, project: config.firebaseProjectID, uid: expected.firebaseUid)
    else { throw DesktopAuthFailure.sessionChanged }
    browserScopeFence = verifyScope
    credential = stored
    firebaseUid = expected.firebaseUid
    generation = expected.generation
    user = stored.user
  }
  private func verifyBrowserScope() throws {
    guard let browserScopeFence else { return }
    try Task.checkCancellation()
    guard !preferences.bool(forKey: signedOutKey) else {
      throw DesktopAuthFailure.sessionChanged
    }
    try browserScopeFence()
  }
  func signIn(email: String, password: String) async {
    await signInOperation("signInWithPassword", email: email, password: password, name: nil)
  }
  func register(name: String, email: String, password: String, confirmation: String) async {
    guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      name.count <= 100, password == confirmation, password.count >= 6
    else {
      failure = .service("INVALID_INPUT")
      return
    }
    await signInOperation("signUp", email: email, password: password, name: name)
  }
  private func signInOperation(_ endpoint: String, email: String, password: String, name: String?)
    async
  {
    guard credential == nil else { return }
    await perform(authenticating: true) {
      guard email.count <= 254, email.contains("@"), !password.isEmpty, password.count <= 4096
      else {
        throw DesktopAuthFailure.service("INVALID_INPUT")
      }
      let epoch = self.generation
      var value = try await self.firebase(
        endpoint,
        body: .object([
          "email": .string(email.trimmingCharacters(in: .whitespacesAndNewlines)),
          "password": .string(password), "returnSecureToken": .bool(true),
        ]))
      if let name {
        value = try await self.firebase(
          "update",
          body: .object([
            "idToken": value["idToken"],
            "displayName": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)),
            "returnSecureToken": .bool(true),
          ]))
      }
      guard self.generation == epoch else { throw DesktopAuthFailure.sessionChanged }
      try self.accept(self.parseCredential(value))
      try await self.bootstrap()
    }
  }
  func signInGoogle(link: Bool = false) async {
    await perform(authenticating: true) {
      guard let config = self.configuration, let client = config.googleDesktopClientID else {
        throw DesktopAuthFailure.configuration
      }
      let epoch = self.generation
      let attempt = GoogleAttempt(generation: epoch)
      self.googleAttempt = attempt
      defer { self.finishGoogleAttempt(attempt) }
      let existing = link ? try await self.authorization() : nil
      try self.checkGoogleAttempt(attempt)
      guard link || self.credential == nil else { throw DesktopAuthFailure.sessionChanged }
      let flow = self.googleFlow(clientID: client, attempt: attempt)
      self.google = flow
      let result = try await self.googleAttemptResult(attempt) { try await flow.signIn() }
      try self.checkGoogleAttempt(attempt)
      let value = try await self.googleAttemptResult(attempt) {
        try await self.firebase(
          "signInWithIdp", body: Self.googleCredentialBody(result.idToken, linking: existing))
      }
      var token = try self.parseCredential(value)
      if link && token.firebaseUid != self.firebaseUid { throw DesktopAuthFailure.sessionChanged }
      let session = try await self.googleAttemptResult(attempt) {
        try await self.bootstrapRequest(bearer: token.idToken) {
          try self.checkGoogleAttempt(attempt)
        }
      }
      token.user = try self.parseUser(session["user"])
      try self.checkGoogleAttempt(attempt)
      try self.accept(token, rotate: !link)
      self.user = token.user
      self.workerRegistrationPermission = token.user?.workerRegistrationAllowed
      self.applyBootstrap(session)
    }
  }
  func cancelSignIn() {
    googleAttempt?.cancelled = true
    cancelGoogleRequest?()
    google?.cancel()
  }
  private func checkGoogleAttempt(_ attempt: GoogleAttempt) throws {
    guard generation == attempt.generation else { throw DesktopAuthFailure.sessionChanged }
    guard googleAttempt?.id == attempt.id, googleAttempt?.cancelled == false, !Task.isCancelled
    else {
      throw DesktopAuthFailure.cancelled
    }
  }
  private func finishGoogleAttempt(_ attempt: GoogleAttempt) {
    if googleAttempt?.id == attempt.id {
      googleAttempt = nil
      google = nil
      cancelGoogleRequest = nil
    }
  }
  private func googleAttemptResult<T: Sendable>(
    _ attempt: GoogleAttempt, _ operation: @escaping @MainActor () async throws -> T
  ) async throws -> T {
    try checkGoogleAttempt(attempt)
    let request = Task { @MainActor in try await operation() }
    let previousCancellation = cancelGoogleRequest
    cancelGoogleRequest = { request.cancel() }
    defer { cancelGoogleRequest = previousCancellation }
    do {
      let result = try await request.value
      try checkGoogleAttempt(attempt)
      return result
    } catch {
      try checkGoogleAttempt(attempt)
      throw error
    }
  }
  func resetPassword(email: String) async {
    guard resetRetryAt?.timeIntervalSinceNow ?? 0 <= 0 else { return }
    await perform {
      guard email.contains("@"), email.count <= 254 else {
        throw DesktopAuthFailure.service("INVALID_INPUT")
      }
      _ = try await self.api(
        "POST", "/auth/password-reset-requests", body: .object(["email": .string(email)]),
        authenticated: false)
      self.notice = "If this email has an account, a password reset link has been sent."
      self.resetRetryAt = Date().addingTimeInterval(30)
    }
  }
  func sendVerification() async {
    guard verificationRetryAt?.timeIntervalSinceNow ?? 0 <= 0 else { return }
    await perform {
      _ = try await self.api("POST", "/auth/verification-emails", body: .object([:]))
      self.notice = "Check your inbox for the verification link."
      self.verificationRetryAt = Date().addingTimeInterval(60)
    }
  }
  func recheckVerification() async {
    await perform {
      _ = try await self.authorization(forceRefresh: true)
      let value = try await self.api("POST", "/auth/profile-synchronizations", body: .object([:]))
      try self.setUser(value["user"])
      self.notice =
        self.user?.emailVerified == true ? "Email verified." : "Email is not verified yet."
    }
  }
  func reauthenticate(password: String) async throws {
    guard let expected = scope else { throw DesktopAuthFailure.sessionChanged }
    let value: DesktopJSON
    if password.isEmpty, user?.providers.contains("google.com") == true {
      guard let client = configuration?.googleDesktopClientID else {
        throw DesktopAuthFailure.configuration
      }
      let attempt = GoogleAttempt(generation: expected.generation)
      googleAttempt = attempt
      defer { finishGoogleAttempt(attempt) }
      let flow = googleFlow(clientID: client, attempt: attempt)
      google = flow
      let result = try await googleAttemptResult(attempt) { try await flow.signIn() }
      value = try await googleAttemptResult(attempt) {
        try await self.firebase("signInWithIdp", body: Self.googleCredentialBody(result.idToken))
      }
      let refreshed = try parseCredential(value)
      guard scope == expected, refreshed.firebaseUid == expected.firebaseUid else {
        throw DesktopAuthFailure.sessionChanged
      }
      try checkGoogleAttempt(attempt)
      try accept(refreshed, rotate: false)
      return
    } else {
      guard let email = user?.email, !password.isEmpty else {
        throw DesktopAuthFailure.service("FRESH_AUTH_REQUIRED")
      }
      value = try await firebase(
        "signInWithPassword",
        body: .object([
          "email": .string(email), "password": .string(password), "returnSecureToken": .bool(true),
        ]))
    }
    let refreshed = try parseCredential(value)
    guard scope == expected, refreshed.firebaseUid == expected.firebaseUid else {
      throw DesktopAuthFailure.sessionChanged
    }
    try accept(refreshed, rotate: false)
  }
  func linkPassword(_ password: String, confirmation: String) async {
    await perform {
      guard password == confirmation, password.count >= 6, password.count <= 4096,
        let email = self.user?.email
      else { throw DesktopAuthFailure.service("INVALID_INPUT") }
      let fence = self.scope
      let token = try await self.authorization()
      let value = try await self.firebase(
        "update",
        body: .object([
          "idToken": .string(token), "email": .string(email), "password": .string(password),
          "returnSecureToken": .bool(true),
        ]))
      guard self.scope == fence else { throw DesktopAuthFailure.sessionChanged }
      try self.accept(self.parseCredential(value), rotate: false)
      try await self.bootstrap()
    }
  }
  func unlink(_ provider: String, password: String) async {
    await perform {
      guard ["google.com", "password"].contains(provider), let user = self.user,
        user.providers.count > 1, user.providers.contains(provider)
      else { throw DesktopAuthFailure.service("LAST_SIGN_IN_METHOD") }
      try await self.reauthenticate(password: password)
      let fence = self.scope
      let token = try await self.authorization()
      let value = try await self.firebase(
        "update",
        body: .object([
          "idToken": .string(token), "deleteProvider": .array([.string(provider)]),
          "returnSecureToken": .bool(true),
        ]))
      guard self.scope == fence else { throw DesktopAuthFailure.sessionChanged }
      try self.accept(self.parseCredential(value), rotate: false)
      try await self.bootstrap()
    }
  }
  func logout(all: Bool = false) async {
    if all {
      await perform {
        _ = try await self.api("POST", "/auth/session-revocations", body: .object([:]))
        try self.clearSession()
      }
    } else {
      do { try clearSession() } catch { failure = authFailure(error) }
    }
  }
  private func clearSession() throws {
    // Fence before any asynchronous or fallible credential cleanup.
    generation = UUID()
    preferences.set(true, forKey: signedOutKey)
    preferences.set(
      DesktopProcessingPreference.local.rawValue,
      forKey: DesktopPreferenceKey.processingMode)
    refreshTask?.cancel()
    refreshTask = nil
    google?.cancel()
    cancelGoogleRequest?()
    google = nil
    googleAttempt = nil
    cancelGoogleRequest = nil
    credential = nil
    firebaseUid = nil
    user = nil
    workerRegistrationPermission = nil
    online = false
    deletionPending = false
    devices = []
    access = .null
    recovery = .null
    onSessionChanged?(nil)
    try stateStore?.publish(nil)
    try vault.remove()
  }
  func loadAccountDetails() async {
    await perform {
      let result = try await self.api("GET", "/users/me/devices?limit=20")
      self.devices = result["items"].array
    }
  }
  func hideDevice(_ id: String) async {
    await perform {
      guard UUID(uuidString: id) != nil else { throw DesktopAuthFailure.service("INVALID_INPUT") }
      _ = try await self.api("DELETE", "/users/me/devices/\(id)")
      self.devices.removeAll { $0["installation_id"].string == id }
    }
  }
  func deleteAccount(password: String) async {
    await perform {
      try await self.reauthenticate(password: password)
      let receipt = try await self.api("DELETE", "/users/me")
      guard receipt["status"].string == "accepted" else {
        throw DesktopAuthFailure.malformedResponse
      }
      self.online = false
      self.deletionPending = true
      self.generation = UUID()
      try self.stateStore?.publish(nil)
      self.onSessionChanged?(nil)
      self.notice =
        "Account deletion requested. Recovery may be requested until \(receipt["recover_until"].string ?? "the recovery deadline")."
      self.recovery = try await self.api("GET", "/users/me/account-recovery")
    }
  }
  func loadRecovery() async {
    await perform { self.recovery = try await self.api("GET", "/users/me/account-recovery") }
  }
  func requestRecovery() async {
    await perform {
      _ = try await self.api("POST", "/users/me/account-recovery", body: .object([:]))
      self.recovery = try await self.api("GET", "/users/me/account-recovery")
      self.notice = "Account recovery requested."
    }
  }
  func reconnect() async { await perform { try await self.bootstrap() } }
  private func bootstrap() async throws {
    let fence = scope
    let bearer = try await authorization()
    let value = try await bootstrapRequest(bearer: bearer) {
      guard self.scope == fence else { throw DesktopAuthFailure.sessionChanged }
      guard !Task.isCancelled else { throw DesktopAuthFailure.cancelled }
    }
    guard scope == fence else { throw DesktopAuthFailure.sessionChanged }
    try setUser(value["user"])
    applyBootstrap(value)
  }
  private func installationReport() throws -> DesktopInstallationReport {
    let metadata = installationMetadata ?? .current
    guard metadata.isValid else { throw DesktopAuthFailure.configuration }
    var previous: DesktopInstallationReport?
    if let data = preferences.data(forKey: installationReportKey) {
      guard data.count <= 16_384,
        let stored = try? JSONDecoder().decode(DesktopInstallationReport.self, from: data),
        stored.installationId == installationId, stored.metadata.isValid,
        (1...DesktopInstallationReport.maximumRevision).contains(stored.revision)
      else { throw DesktopAuthFailure.configuration }
      previous = stored
    }
    if let previous, previous.metadata == metadata { return previous }
    guard previous?.revision != DesktopInstallationReport.maximumRevision else {
      throw DesktopAuthFailure.configuration
    }
    let report = DesktopInstallationReport(
      installationId: installationId, metadata: metadata, revision: (previous?.revision ?? 0) + 1)
    try persistInstallationReport(report)
    return report
  }
  private func persistInstallationReport(_ report: DesktopInstallationReport) throws {
    // This global installation snapshot contains metadata only, never account or worker credentials.
    preferences.set(try JSONEncoder().encode(report), forKey: installationReportKey)
  }
  private func bootstrapRequest(bearer: String, checkSession: @MainActor () throws -> Void)
    async throws -> DesktopJSON
  {
    try checkSession()
    var report = try installationReport()
    do {
      return try await prospectiveAPI(
        "POST", "/auth/sessions", body: report.body, bearer: bearer,
        recognizeDeviceConflict: true, checkSession: checkSession)
    } catch DesktopBootstrapFailure.deviceReportConflict {
      // The owner-scoped read must use the same prospective bearer, before Google credentials are saved.
      guard
        let serverRevision = try await ownedInstallationRevision(
          bearer: bearer, checkSession: checkSession)
      else { throw DesktopAuthFailure.service("DEVICE_REPORT_CONFLICT") }
      try checkSession()
      let revision = max(report.revision, serverRevision)
      guard revision < DesktopInstallationReport.maximumRevision else {
        throw DesktopAuthFailure.service("DEVICE_REPORT_CONFLICT")
      }
      report.revision = revision + 1
      try persistInstallationReport(report)
      // One retry only. A second conflict retains the backend's ownership/platform protection.
      return try await prospectiveAPI(
        "POST", "/auth/sessions", body: report.body, bearer: bearer, checkSession: checkSession)
    }
  }
  private func ownedInstallationRevision(
    bearer: String, checkSession: @MainActor () throws -> Void
  ) async throws -> Int64? {
    var cursor: String?
    var seen = Set<String>()
    for _ in 0..<5 {
      var query = URLComponents()
      query.queryItems = [URLQueryItem(name: "limit", value: "50")]
      if let cursor { query.queryItems?.append(URLQueryItem(name: "before", value: cursor)) }
      let page = try await prospectiveAPI(
        "GET", "/users/me/devices?\(query.percentEncodedQuery ?? "")", bearer: bearer,
        checkSession: checkSession)
      guard case .array(let items) = page["items"], items.count <= 50 else {
        throw DesktopAuthFailure.malformedResponse
      }
      if let device = items.first(where: { $0["installation_id"].string == installationId }) {
        guard device["platform"].string == "macos",
          let revision = device["metadata_revision"].number,
          revision.isFinite, revision.rounded() == revision, revision >= 1,
          revision <= Double(DesktopInstallationReport.maximumRevision)
        else { throw DesktopAuthFailure.service("DEVICE_REPORT_CONFLICT") }
        return Int64(revision)
      }
      if page["next_cursor"] == .null { return nil }
      guard let next = page["next_cursor"].string,
        next.range(of: "^[a-f0-9]{24}$", options: .regularExpression) != nil,
        seen.insert(next).inserted
      else { throw DesktopAuthFailure.service("DEVICE_REPORT_CONFLICT") }
      cursor = next
    }
    return nil
  }
  private func prospectiveAPI(
    _ method: String, _ path: String, body: DesktopJSON? = nil, bearer: String,
    recognizeDeviceConflict: Bool = false, checkSession: @MainActor () throws -> Void
  ) async throws -> DesktopJSON {
    try checkSession()
    var request = try await backendRequest(
      method, path, body: body, authenticated: false)
    try checkSession()
    request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
    do {
      let value = try await send(request, recognizeDeviceConflict: recognizeDeviceConflict)
      try checkSession()
      return value
    } catch {
      try checkSession()
      throw error
    }
  }
  private func applyBootstrap(_ value: DesktopJSON) {
    access = value["access"]
    policy = value["policy"]
    online = true
    deletionPending = false
  }
  private func setUser(_ value: DesktopJSON) throws {
    let decoded = try parseUser(value)
    user = decoded
    workerRegistrationPermission = decoded.workerRegistrationAllowed
    if var credential {
      credential.user = decoded
      try vault.save(credential)
      self.credential = credential
    }
  }
  private func parseUser(_ value: DesktopJSON) throws -> DesktopUser {
    let decoded = try JSONDecoder().decode(DesktopUser.self, from: JSONEncoder().encode(value))
    guard !decoded.id.isEmpty, decoded.id.count <= 128, decoded.displayName.count <= 200,
      decoded.providers.count <= 10
    else { throw DesktopAuthFailure.malformedResponse }
    return decoded
  }
  private func accept(_ value: DesktopCredential, rotate: Bool = true) throws {
    var value = value
    if !rotate && value.user == nil { value.user = user }
    try verifyBrowserScope()
    try vault.save(value)
    if browserScopeFence == nil { preferences.set(false, forKey: signedOutKey) }
    credential = value
    firebaseUid = value.firebaseUid
    if rotate {
      generation = UUID()
      user = nil
      workerRegistrationPermission = nil
      try stateStore?.publish(scope)
      onSessionChanged?(scope)
    }
  }
  private func parseCredential(_ value: DesktopJSON) throws -> DesktopCredential {
    guard let uid = value["localId"].string ?? value["user_id"].string,
      let token = value["idToken"].string ?? value["id_token"].string,
      let refresh = value["refreshToken"].string ?? value["refresh_token"].string,
      let raw = value["expiresIn"].string ?? value["expires_in"].string,
      let seconds = TimeInterval(raw), (1...86_400).contains(seconds),
      !uid.isEmpty, uid.count <= 128, token.count >= 20, token.count <= 16_384,
      refresh.count >= 20, refresh.count <= 16_384,
      let config = configuration,
      Self.belongsToProject(token, project: config.firebaseProjectID, uid: uid)
    else { throw DesktopAuthFailure.malformedResponse }
    return DesktopCredential(
      firebaseUid: uid, idToken: token, refreshToken: refresh,
      expiresAt: Date().addingTimeInterval(seconds), user: nil)
  }
  func authorization(forceRefresh: Bool = false) async throws -> String {
    try verifyBrowserScope()
    guard let current = credential, let fence = scope else {
      throw DesktopAuthFailure.sessionChanged
    }
    if !forceRefresh && current.expiresAt.timeIntervalSinceNow > 120 { return current.idToken }
    if refreshTask == nil {
      refreshTask = Task { @MainActor in
        guard let config = self.configuration else { throw DesktopAuthFailure.configuration }
        let url = URL(
          string: "https://securetoken.googleapis.com/v1/token?key=\(config.firebaseAPIKey)")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(
          Self.form(["grant_type": "refresh_token", "refresh_token": current.refreshToken]).utf8)
        let value = try await self.send(request)
        return try self.parseCredential(value)
      }
    }
    guard let task = refreshTask else { throw DesktopAuthFailure.sessionChanged }
    do {
      let refreshed = try await task.value
      guard scope == fence, refreshed.firebaseUid == fence.firebaseUid else {
        throw DesktopAuthFailure.sessionChanged
      }
      try accept(refreshed, rotate: false)
      try verifyBrowserScope()
      refreshTask = nil
      return refreshed.idToken
    } catch {
      if scope == fence { refreshTask = nil }
      throw error
    }
  }
  func authorizedSession() async throws -> DesktopJSON {
    guard let fence = scope else { throw DesktopAuthFailure.sessionChanged }
    let token = try await authorization()
    guard scope == fence else { throw DesktopAuthFailure.sessionChanged }
    return .object([
      "firebase_uid": .string(fence.firebaseUid),
      "session_generation": .string(fence.generation.uuidString.lowercased()),
      "id_token": .string(token),
    ])
  }
  func localSession() -> DesktopJSON? {
    guard let scope else { return nil }
    var fields: [String: DesktopJSON] = [
      "firebase_uid": .string(scope.firebaseUid),
      "session_generation": .string(scope.generation.uuidString.lowercased()),
      "installation_id": .string(installationId),
    ]
    // Reuse an authorized account result when possible, without blocking local work on refresh.
    if let credential, credential.expiresAt.timeIntervalSinceNow > 60 {
      fields["id_token"] = .string(credential.idToken)
    }
    return .object(fields)
  }
  private func backendRequest(
    _ method: String, _ path: String, body: DesktopJSON? = nil, authenticated: Bool = true
  ) async throws -> URLRequest {
    guard let config = configuration, path.hasPrefix("/"), !path.hasPrefix("//"),
      !path.contains("#"),
      let origin = URL(string: config.backendBaseURL),
      let url = URL(string: path, relativeTo: origin)?.absoluteURL,
      url.scheme == origin.scheme, url.host == origin.host, url.port == origin.port
    else { throw DesktopAuthFailure.configuration }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue(installationId, forHTTPHeaderField: "X-Installation-Id")
    if authenticated {
      request.setValue("Bearer \(try await authorization())", forHTTPHeaderField: "Authorization")
    }
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONEncoder().encode(body)
    }
    return request
  }
  func api(_ method: String, _ path: String, body: DesktopJSON? = nil, authenticated: Bool = true)
    async throws -> DesktopJSON
  {
    let fence = scope
    var request = try await backendRequest(method, path, body: body, authenticated: authenticated)
    let value: DesktopJSON
    do { value = try await send(request) } catch let failure as DesktopAuthFailure {
      // Only explicit reads can replay. Mutations may already have committed.
      if authenticated, method == "GET", failure == .service("UNAUTHENTICATED") {
        guard scope == fence else { throw DesktopAuthFailure.sessionChanged }
        request.setValue(
          "Bearer \(try await authorization(forceRefresh: true))",
          forHTTPHeaderField: "Authorization")
        guard scope == fence else { throw DesktopAuthFailure.sessionChanged }
        value = try await send(request)
      } else {
        throw failure
      }
    }
    guard !authenticated || scope == fence else { throw DesktopAuthFailure.sessionChanged }
    return value
  }
  private func googleFlow(clientID: String, attempt: GoogleAttempt) -> DesktopGoogleOAuth {
    DesktopGoogleOAuth(
      clientID: clientID,
      exchangeCode: { [weak self] code, verifier, redirectURI in
        guard let self else { throw DesktopAuthFailure.sessionChanged }
        return try await self.googleAttemptResult(attempt) {
          try await self.exchangeGoogleCode(
            code, verifier: verifier, redirectURI: redirectURI, generation: attempt.generation)
        }
      },
      browserDeadline: googleBrowserDeadline, openBrowser: openGoogleBrowser)
  }
  private func exchangeGoogleCode(
    _ code: String, verifier: String, redirectURI: String, generation: UUID
  ) async throws -> String {
    guard self.generation == generation else { throw DesktopAuthFailure.sessionChanged }
    let request = try await backendRequest(
      "POST", "/auth/desktop-google-token-exchanges",
      body: .object([
        "authorization_code": .string(code), "code_verifier": .string(verifier),
        "redirect_uri": .string(redirectURI),
      ]), authenticated: false)
    let data: Data
    let status: Int
    do {
      (data, status) = try await transport.send(request)
    } catch {
      guard self.generation == generation else { throw DesktopAuthFailure.sessionChanged }
      throw DesktopAuthFailure.service("GOOGLE_TOKEN_UNAVAILABLE")
    }
    guard self.generation == generation else { throw DesktopAuthFailure.sessionChanged }
    guard data.count <= 32_768 else {
      throw DesktopAuthFailure.service("GOOGLE_TOKEN_EXCHANGE_FAILED")
    }
    let value = (try? JSONDecoder().decode(DesktopJSON.self, from: data)) ?? .null
    guard status == 200 else {
      throw DesktopGoogleOAuth.tokenExchangeFailure(status: status, response: value)
    }
    guard let token = value["google_id_token"].string, token.count >= 20, token.count <= 16_384,
      token.utf8.allSatisfy({ $0 > 32 && $0 < 127 })
    else { throw DesktopAuthFailure.service("GOOGLE_TOKEN_EXCHANGE_FAILED") }
    return token
  }
  private func firebase(_ endpoint: String, body: DesktopJSON) async throws -> DesktopJSON {
    guard let config = configuration else { throw DesktopAuthFailure.configuration }
    let allowed = ["signUp", "signInWithPassword", "signInWithIdp", "update", "lookup"]
    guard allowed.contains(endpoint) else { throw DesktopAuthFailure.configuration }
    var request = URLRequest(
      url: URL(
        string:
          "https://identitytoolkit.googleapis.com/v1/accounts:\(endpoint)?key=\(config.firebaseAPIKey)"
      )!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(body)
    return try await send(request)
  }
  private func send(_ request: URLRequest, recognizeDeviceConflict: Bool = false) async throws
    -> DesktopJSON
  {
    let (data, status) = try await transport.send(request)
    let value =
      data.isEmpty ? DesktopJSON.null : try JSONDecoder().decode(DesktopJSON.self, from: data)
    guard (200..<300).contains(status) else {
      let code =
        value["code"].string ?? value["error"]["message"].string?.components(separatedBy: " : ")
        .first ?? "ACCOUNT_REQUEST_FAILED"
      if recognizeDeviceConflict, status == 409, code == "DEVICE_REPORT_CONFLICT" {
        throw DesktopBootstrapFailure.deviceReportConflict
      }
      throw DesktopAuthFailure.service(safeIdentifier(code) ? code : "ACCOUNT_REQUEST_FAILED")
    }
    return value
  }
  private func perform(authenticating: Bool = false, _ operation: () async throws -> Void) async {
    guard !busy else { return }
    busy = true
    failure = nil
    notice = nil
    defer { busy = false }
    do { try await operation() } catch {
      failure = authFailure(error)
      if authenticating || failure == .service("GOOGLE_SIGN_IN_TIMEOUT"),
        let code = failure?.signInJournalCode
      {
        journal?.record(.appOperationError, code: code)
      }
      if failure == .service("NETWORK_UNAVAILABLE") { online = false }
      if failure == .service("ACCOUNT_DELETION_PENDING") {
        deletionPending = true
        online = false
        try? stateStore?.publish(nil)
        onSessionChanged?(nil)
      }
    }
  }
  private func authFailure(_ error: Error) -> DesktopAuthFailure {
    error as? DesktopAuthFailure ?? .malformedResponse
  }
  static func form(_ values: [String: String]) -> String {
    var components = URLComponents()
    components.queryItems = values.sorted(by: { $0.key < $1.key }).map {
      URLQueryItem(name: $0.key, value: $0.value)
    }
    return (components.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
  }
  static func googleCredentialBody(_ token: String, linking firebaseToken: String? = nil)
    -> DesktopJSON
  {
    // This is manual IdP credential exchange, after Google's exact loopback PKCE flow has completed.
    // Firebase documents this logical URI independently of the Google OAuth callback URI.
    // https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/accounts/signInWithIdp
    var fields: [String: DesktopJSON] = [
      "postBody": .string(form(["id_token": token, "providerId": "google.com"])),
      "requestUri": .string("http://localhost"), "returnSecureToken": .bool(true),
    ]
    if let firebaseToken { fields["idToken"] = .string(firebaseToken) }
    return .object(fields)
  }
  // This is a project/identity mix-up fence, not signature verification. The API verifies Firebase signatures.
  static func belongsToProject(_ token: String, project: String, uid: String) -> Bool {
    guard let claims = tokenClaims(token) else { return false }
    return claims["aud"].string == project
      && claims["iss"].string == "https://securetoken.google.com/\(project)"
      && claims["sub"].string == uid
  }
  private static func tokenClaims(_ token: String) -> DesktopJSON? {
    let parts = token.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 3, parts[1].count <= 16_384 else { return nil }
    var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(
      of: "_", with: "/")
    payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
    guard let data = Data(base64Encoded: payload),
      let claims = try? JSONDecoder().decode(DesktopJSON.self, from: data)
    else { return nil }
    return claims
  }
}

/// Installed-app PKCE uses a fresh loopback listener and the system browser. No Google client secret is bundled.
@MainActor final class DesktopGoogleOAuth {
  static let browserWaitLimit: Duration = .seconds(600)
  struct Result: Sendable {
    let idToken: String
    let redirectURI: String
  }
  private let clientID: String
  private let exchangeCode: @MainActor (String, String, String) async throws -> String
  private let browserDeadline: Duration
  private let openBrowser: @MainActor (URL) -> Bool
  private var listener: NWListener?
  private var continuation: CheckedContinuation<(String, String), Error>?
  private var redirectURI: String?
  private var timeout: Task<Void, Never>?
  private var activeConnections: [NWConnection] = []
  private var completingCallback = false
  private var cancelled = false
  init(
    clientID: String,
    exchangeCode: @escaping @MainActor (String, String, String) async throws -> String,
    browserDeadline: Duration = DesktopGoogleOAuth.browserWaitLimit,
    openBrowser: @escaping @MainActor (URL) -> Bool = { NSWorkspace.shared.open($0) }
  ) {
    self.clientID = clientID
    self.exchangeCode = exchangeCode
    self.browserDeadline = browserDeadline
    self.openBrowser = openBrowser
  }
  static func random() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
      throw DesktopAuthFailure.credentialsUnavailable
    }
    return base64URL(Data(bytes))
  }
  static func base64URL(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(
      of: "/", with: "_"
    ).replacingOccurrences(of: "=", with: "")
  }
  static func callback(_ target: String, state: String) throws -> String {
    guard target.count <= 8192, let components = URLComponents(string: target),
      components.path == "/oauth2callback",
      components.fragment == nil, components.scheme == nil, components.host == nil,
      let items = components.queryItems, items.filter({ $0.name == "state" }).count == 1,
      items.first(where: { $0.name == "state" })?.value == state
    else { throw DesktopAuthFailure.service("OAUTH_STATE_MISMATCH") }
    if items.contains(where: { $0.name == "error" }) { throw DesktopAuthFailure.cancelled }
    guard items.filter({ $0.name == "code" }).count == 1,
      let code = items.first(where: { $0.name == "code" })?.value,
      !code.isEmpty, code.count <= 4096
    else { throw DesktopAuthFailure.malformedResponse }
    return code
  }
  static func tokenExchangeFailure(status: Int, response: DesktopJSON) -> DesktopAuthFailure {
    if (status == 429 && response["code"].string == "RATE_LIMITED")
      || (status == 503 && response["code"].string == "SERVICE_UNAVAILABLE")
    {
      return .service("GOOGLE_TOKEN_UNAVAILABLE")
    }
    if status == 400 && response["code"].string == "GOOGLE_TOKEN_INVALID_GRANT" {
      return .service("GOOGLE_TOKEN_INVALID_GRANT")
    }
    return .service("GOOGLE_TOKEN_EXCHANGE_FAILED")
  }
  /// This page acknowledges only the browser callback; account verification still happens in the app.
  static func callbackResponse(
    cancelled: Bool = false, language: String? = nil, bundle: Bundle = .main
  ) -> String {
    let preference = language ?? UserDefaults.standard.string(forKey: DesktopPreferenceKey.language)
    let resolvedLanguage =
      preference == "ar"
        || (preference != "en" && Locale.preferredLanguages.first?.hasPrefix("ar") == true)
      ? "ar" : "en"
    let localizedBundle =
      bundle.path(forResource: resolvedLanguage, ofType: "lproj")
      .flatMap { Bundle(path: $0) } ?? bundle
    func text(_ key: String) -> String {
      localizedBundle.localizedString(forKey: key, value: key, table: nil)
        .replacingOccurrences(of: "&", with: "&amp;")
        .replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;")
        .replacingOccurrences(of: "\"", with: "&quot;")
        .replacingOccurrences(of: "'", with: "&#39;")
    }
    let title = cancelled ? "Sign-in cancelled" : "Continue in MusicMute"
    let description =
      cancelled
      ? "Google sign-in was cancelled. Open MusicMute to try again when you’re ready."
      : "Your Google sign-in was received. Open MusicMute to finish signing in."
    let status = cancelled ? "Sign-in cancelled" : "Browser step complete"
    let symbol = cancelled ? "M12 8v5m0 3h.01" : "m7 12 3.5 3.5L17 9"
    let style = """
      :root { color-scheme: dark; --background: #101217; --surface: #191b21; --text: #f5f5f7;
        --muted: #b5b8c4; --border: #30333d; --accent: #ff814a; --status: #96e6c7; --status-bg: #123c37; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; min-height: 100svh; display: grid; place-items: center;
        padding: 32px 20px; background: radial-gradient(ellipse at 50% 0%, #ff814a0c, transparent 60%),
        var(--background); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        line-height: 1.6; }
      main { width: 100%; max-width: 480px; text-align: center; }
      .brand { display: inline-flex; align-items: center; gap: 10px; margin-bottom: 28px;
        font-size: 18px; font-weight: 650; letter-spacing: -.4px; }
      .brand svg { color: var(--accent); }
      .card { padding: 40px 32px 32px; background: var(--surface); border: 1px solid var(--border);
        border-radius: 24px; box-shadow: 0 24px 80px #00000024; }
      .status-icon { display: grid; place-items: center; width: 72px; height: 72px; margin: 0 auto 20px;
        border-radius: 50%; color: var(--status); background: var(--status-bg); }
      .cancelled { --status: #ffd18b; --status-bg: #3a2b1c; }
      .eyebrow { margin: 0 0 12px; color: var(--status); font-size: 12px; font-weight: 650;
        letter-spacing: 1.2px; text-transform: uppercase; }
      h1 { margin: 0 0 12px; font-size: clamp(26px, 5vw, 32px); line-height: 1.2; letter-spacing: -.8px; }
      .description { margin: 0 auto 28px; max-width: 350px; color: var(--muted); font-size: 16px; }
      .open-app { display: flex; align-items: center; justify-content: center; gap: 10px; min-height: 52px;
        padding: 12px 20px; border-radius: 12px; background: var(--accent); color: #1b100a;
        font-size: 16px; font-weight: 700; text-decoration: none; }
      .open-app:hover { filter: brightness(1.08); }
      .open-app:focus-visible { outline: 3px solid var(--text); outline-offset: 5px; }
      .hint { margin: 16px 0 0; color: var(--muted); font-size: 13px; }
      footer { margin: 24px 12px 0; color: var(--muted); font-size: 13px; }
      [dir="rtl"] .eyebrow, [dir="rtl"] h1 { letter-spacing: normal; }
      @media (prefers-color-scheme: light) {
        :root { color-scheme: light; --background: #f2f3f6; --surface: #ffffff; --text: #191b21;
          --muted: #5c6170; --border: #e1e3e9; --status: #087c65; --status-bg: #e1f4ee; }
        .cancelled { --status: #8a4a00; --status-bg: #fff1d9; }
      }
      @media (max-width: 380px) { .card { padding: 32px 22px 26px; } }
      @media (forced-colors: active) { .open-app { border: 2px solid ButtonText; } }
      """
    // Remove the authorization code and state from the address bar without another callback request.
    let script = "history.replaceState(null, '', '/oauth2callback');"
    let body = """
      <!doctype html>
      <html lang="\(resolvedLanguage)" dir="\(resolvedLanguage == "ar" ? "rtl" : "ltr")">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="robots" content="noindex, nofollow">
        <title>\(text(title)) · MusicMute</title>
        <link rel="icon" href="data:,">
        <style>\(style)</style>
      </head>
      <body>
        <main>
          <div class="brand"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M4 10v4m4-7v10m4-14v18m4-14v10m4-7v4"/></svg>MusicMute</div>
          <section class="card\(cancelled ? " cancelled" : "")" aria-labelledby="title">
            <div class="status-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
              aria-hidden="true"><path d="\(symbol)"/></svg></div>
            <p class="eyebrow">\(text(status))</p>
            <h1 id="title">\(text(title))</h1>
            <p class="description">\(text(description))</p>
            <a class="open-app" href="musicmute-local://account">\(text("Open MusicMute"))
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>
              </svg>
            </a>
            <p class="hint">\(text("If your browser asks, allow it to open MusicMute."))</p>
          </section>
          <footer>\(text("You can close this tab after returning to the app."))<br>
            \(text("App didn’t open? Select MusicMute in your Dock."))</footer>
        </main>
        <script>\(script)</script>
      </body>
      </html>
      """
    func hash(_ value: String) -> String {
      Data(SHA256.hash(data: Data(value.utf8))).base64EncodedString()
    }
    let policy =
      "default-src 'none'; style-src 'sha256-\(hash(style))'; script-src 'sha256-\(hash(script))'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    return
      "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Security-Policy: \(policy)\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
  }
  func signIn() async throws -> Result {
    guard !cancelled, !Task.isCancelled else { throw DesktopAuthFailure.cancelled }
    let verifier = try Self.random()
    let state = try Self.random()
    let challenge = Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
    let listener = try NWListener(using: parameters)
    self.listener = listener
    defer { cancel() }
    let (code, redirectURI): (String, String) = try await withCheckedThrowingContinuation {
      result in
      self.continuation = result
      listener.stateUpdateHandler = { stateUpdate in
        Task { @MainActor in
          switch stateUpdate {
          case .ready:
            guard self.redirectURI == nil, self.continuation != nil, let port = listener.port else {
              return
            }
            let redirect = "http://127.0.0.1:\(port.rawValue)/oauth2callback"
            self.redirectURI = redirect
            var components = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
            components.queryItems = [
              "client_id": self.clientID, "redirect_uri": redirect, "response_type": "code",
              "scope": "openid email profile", "code_challenge": challenge,
              "code_challenge_method": "S256", "state": state,
              "prompt": "select_account",
            ].sorted(by: { $0.key < $1.key }).map { URLQueryItem(name: $0.key, value: $0.value) }
            guard let url = components.url, self.openBrowser(url) else {
              self.finish(.failure(DesktopAuthFailure.service("BROWSER_OPEN_FAILED")))
              return
            }
            self.timeout = Task { @MainActor in
              do { try await Task.sleep(for: self.browserDeadline) } catch { return }
              self.finish(.failure(DesktopAuthFailure.service("GOOGLE_SIGN_IN_TIMEOUT")))
            }
          case .failed:
            self.finish(.failure(DesktopAuthFailure.service("OAUTH_CALLBACK_UNAVAILABLE")))
          default: break
          }
        }
      }
      listener.newConnectionHandler = { connection in
        Task { @MainActor in
          guard self.continuation != nil, self.listener === listener,
            self.activeConnections.count < 8
          else {
            connection.cancel()
            return
          }
          self.activeConnections.append(connection)
          connection.start(queue: .main)
          self.read(connection, state: state, received: Data())
        }
      }
      listener.start(queue: .main)
    }
    guard !cancelled, !Task.isCancelled else { throw DesktopAuthFailure.cancelled }
    let token: String
    do {
      token = try await exchangeCode(code, verifier, redirectURI)
    } catch {
      if error as? DesktopAuthFailure == .sessionChanged { throw error }
      guard !cancelled, !Task.isCancelled else { throw DesktopAuthFailure.cancelled }
      throw error
    }
    guard !cancelled, !Task.isCancelled else { throw DesktopAuthFailure.cancelled }
    return Result(idToken: token, redirectURI: redirectURI)
  }
  private func read(_ connection: NWConnection, state: String, received: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 8192 - received.count) {
      data, _, complete, error in
      Task { @MainActor in
        guard self.continuation != nil, !self.completingCallback else {
          connection.cancel()
          return
        }
        var combined = received
        if let data { combined.append(data) }
        guard combined.count <= 8192, error == nil else {
          connection.cancel()
          return
        }
        guard let text = String(data: combined, encoding: .utf8) else {
          connection.cancel()
          return
        }
        if !text.contains("\r\n\r\n") {
          if complete || combined.count == 8192 {
            connection.cancel()
          } else {
            self.read(connection, state: state, received: combined)
          }
          return
        }
        let parts = (text.components(separatedBy: "\r\n").first ?? "").split(separator: " ")
        guard parts.count == 3, parts[0] == "GET", parts[2] == "HTTP/1.1" else {
          connection.cancel()
          return
        }
        let expectedHost = URLComponents(string: self.redirectURI ?? "").flatMap { value in
          value.port.map { "127.0.0.1:\($0)" }
        }
        let hosts = text.components(separatedBy: "\r\n").filter {
          $0.lowercased().hasPrefix("host:")
        }
        guard hosts.count == 1,
          hosts[0].dropFirst(5).trimmingCharacters(in: .whitespaces) == expectedHost
        else {
          connection.cancel()
          return
        }
        do {
          let code = try Self.callback(String(parts[1]), state: state)
          self.sendCallbackPage(connection, outcome: .success(code))
        } catch let error as DesktopAuthFailure {
          if error == .cancelled {
            self.sendCallbackPage(connection, outcome: .failure(error))
          } else {
            connection.cancel()
          }
        } catch { connection.cancel() }
      }
    }
  }
  private func sendCallbackPage(_ connection: NWConnection, outcome: Swift.Result<String, Error>) {
    completingCallback = true
    let wasCancelled: Bool
    switch outcome {
    case .success: wasCancelled = false
    case .failure: wasCancelled = true
    }
    connection.send(
      content: Data(Self.callbackResponse(cancelled: wasCancelled).utf8),
      completion: .contentProcessed { _ in
        Task { @MainActor in
          connection.cancel()
          // Drain the HTML before token exchange or cleanup can close its connection.
          self.finish(outcome)
        }
      })
  }
  private func finish(_ outcome: Swift.Result<String, Error>) {
    guard let result = continuation else { return }
    continuation = nil
    timeout?.cancel()
    timeout = nil
    listener?.cancel()
    listener = nil
    switch outcome {
    case .success(let code):
      if let redirectURI {
        result.resume(returning: (code, redirectURI))
      } else {
        result.resume(throwing: DesktopAuthFailure.malformedResponse)
      }
    case .failure(let error): result.resume(throwing: error)
    }
  }
  func cancel() {
    cancelled = true
    finish(.failure(DesktopAuthFailure.cancelled))
    timeout?.cancel()
    timeout = nil
    listener?.cancel()
    listener = nil
    for connection in activeConnections { connection.cancel() }
    activeConnections = []
  }
}
