import Foundation

/// Match Android and the companion's inclusive 20-minute processing ceiling.
enum DesktopMediaLimits {
  static let maxDurationSeconds = 1_200
}

enum AppCommand: String, Sendable { case status, setup, snapshot, export }

struct BundledControlLaunch {
  let executable: URL
  let arguments: [String]
  static func command(resources: URL, runtime: URL, arguments: [String]) -> Self? {
    let node = runtime.appendingPathComponent("runtime/node/bin/node")
    let python = runtime.appendingPathComponent("runtime/python/bin/python3")
    let wrapper = resources.appendingPathComponent("scripts/update-lock.py")
    if FileManager.default.isExecutableFile(atPath: node.path),
      FileManager.default.isExecutableFile(atPath: python.path),
      FileManager.default.fileExists(atPath: wrapper.path)
    {
      return Self(
        executable: python,
        arguments: ["-I", "-B", "-S", wrapper.path, "--run", node.path] + arguments)
    }
    #if MUSICMUTE_NATIVE_TESTS
      // Isolated bridge fixtures intentionally contain only a synthetic executable.
      if FileManager.default.isExecutableFile(atPath: node.path) {
        return Self(executable: node, arguments: arguments)
      }
      return nil
    #else
      return nil
    #endif
  }
}

/// Recorder identity is independent of historical events and model verification.
struct DiagnosticIdentity: Codable, Equatable, Sendable {
  enum RuntimeScope: String, Codable, Sendable {
    case packagedApp = "PACKAGED_APP"
    case development = "DEVELOPMENT"
  }
  let softwareVersion: String
  let runtimeScope: RuntimeScope
  let expectedModelSha256: String
  let packageInventorySha256: String?

  init(
    softwareVersion: String, runtimeScope: RuntimeScope, expectedModelSha256: String,
    packageInventorySha256: String? = nil
  ) {
    self.softwareVersion = softwareVersion
    self.runtimeScope = runtimeScope
    self.expectedModelSha256 = expectedModelSha256
    self.packageInventorySha256 = packageInventorySha256
  }

  private struct Field: CodingKey {
    let stringValue: String
    let intValue: Int? = nil
    init(_ value: String) { stringValue = value }
    init?(stringValue: String) { self.init(stringValue) }
    init?(intValue: Int) { return nil }
  }
  // Native replies use convertFromSnakeCase; journal files use the wire keys directly.
  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: Field.self)
    func key(_ camel: String, _ wire: String) -> Field {
      values.contains(Field(camel)) ? Field(camel) : Field(wire)
    }
    softwareVersion = try values.decode(
      String.self, forKey: key("softwareVersion", "software_version"))
    runtimeScope = try values.decode(
      RuntimeScope.self, forKey: key("runtimeScope", "runtime_scope"))
    expectedModelSha256 = try values.decode(
      String.self, forKey: key("expectedModelSha256", "expected_model_sha256"))
    packageInventorySha256 = try values.decodeIfPresent(
      String.self, forKey: key("packageInventorySha256", "package_inventory_sha256"))
    guard Self.validVersion(softwareVersion), Self.validDigest(expectedModelSha256),
      packageInventorySha256.map(Self.validDigest) != false
    else { throw AppValidation.invalidMessage }
  }
  func encode(to encoder: Encoder) throws {
    var values = encoder.container(keyedBy: Field.self)
    try values.encode(softwareVersion, forKey: Field("software_version"))
    try values.encode(runtimeScope, forKey: Field("runtime_scope"))
    try values.encode(expectedModelSha256, forKey: Field("expected_model_sha256"))
    try values.encodeIfPresent(packageInventorySha256, forKey: Field("package_inventory_sha256"))
  }
  static func validVersion(_ value: String) -> Bool {
    value.count <= 64
      && value.range(
        of: #"\A[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9._-]+)?\z"#, options: .regularExpression)
        != nil
  }
  static func validDigest(_ value: String) -> Bool {
    value.utf8.count == 64
      && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
  }
  var recorderLabel: String {
    "Report recorder · v\(softwareVersion) · \(runtimeScope == .packagedApp ? "Packaged app" : "Development")"
  }
  var inventoryLabel: String {
    packageInventorySha256.map { "Package inventory · \($0.prefix(12))" }
      ?? "Package inventory unavailable"
  }
}

struct CompanionStatus: Decodable, Sendable {
  let ready: Bool
  let platform: String
  let arch: String
  let version: String
  let runtimeReady: Bool
  let modelReady: Bool
  let extensionRegistered: Bool
  let extensionPath: String
  let modelBytes: Int64
  let cacheBytes: Int64
  let diagnosticMode: String
  let maxDurationSeconds: Int
  let downloaderReady: Bool?
  let javascriptReady: Bool?
  let tokenProviderReady: Bool?
  let youtubeReady: Bool?
  let localProcessingReady: Bool?
  let components: [SetupComponentStatus]?

  var supported: Bool { platform == "darwin" && arch == "arm64" && diagnosticMode == "LOCAL_ONLY" }
  var complete: Bool { ready && supported && runtimeReady && modelReady && extensionRegistered }
}

struct SetupComponentStatus: Decodable, Sendable {
  let component: String
  let state: String
  let errorCode: String?
  var valid: Bool {
    ["engine", "model", "downloader", "javascript", "token_provider", "chrome"].contains(component)
      && ["ready", "missing", "invalid"].contains(state)
      && (errorCode == nil || safeIdentifier(errorCode!))
  }
}

struct ControlEvent: Decodable, Sendable {
  let type: String
  let protocolVersion: Int?
  let phase: String?
  let percent: Double?
  let label: String?
  let status: CompanionStatus?
  let report: LocalReport?
  let path: String?
  let errorCode: String?
  let action: String?

  static func decode(_ data: Data, command: AppCommand) throws -> ControlEvent {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    let event = try decoder.decode(ControlEvent.self, from: data)
    guard event.protocolVersion == nil || event.protocolVersion == 1 else {
      throw AppValidation.invalidMessage
    }
    switch event.type {
    case "progress":
      guard command == .setup, let phase = event.phase, phase.count <= 80,
        let percent = event.percent, percent.isFinite, (0...100).contains(percent),
        let label = event.label, label.count <= 240
      else { throw AppValidation.invalidMessage }
    case "result":
      if command == .status || command == .setup {
        guard let status = event.status, status.version.count <= 64,
          status.extensionPath.count <= 4096, status.modelBytes >= 0,
          status.cacheBytes >= 0, (1...86_400).contains(status.maxDurationSeconds),
          (status.components?.count ?? 0) <= 6,
          status.components?.allSatisfy(\.valid) != false,
          Set((status.components ?? []).map(\.component)).count == (status.components?.count ?? 0)
        else { throw AppValidation.invalidMessage }
      } else {
        guard let report = event.report, report.schemaVersion == 1,
          ["available", "closed", "diagnostics_unavailable"].contains(report.availability ?? ""),
          (report.recentEvents?.count ?? 0) <= 500, (report.jobs?.count ?? 0) <= 100,
          (report.recentErrors?.count ?? 0) <= 50, (report.recentWarnings?.count ?? 0) <= 50,
          report.appSetupDiagnostics?.hasValidCollectionBounds != false,
          report.appDesktopDiagnostics?.hasValidCollectionBounds != false,
          (report.appUiEvents?.count ?? 0) <= 500,
          report.hasValidModelEvidence,
          (event.path?.count ?? 0) <= 4096
        else { throw AppValidation.invalidMessage }
      }
    case "error":
      guard let code = event.errorCode, safeIdentifier(code), (event.action?.count ?? 0) <= 240
      else { throw AppValidation.invalidMessage }
    default: throw AppValidation.invalidMessage
    }
    return event
  }
}

enum AppValidation: Error { case invalidMessage, invalidPath }

enum LocalPaths {
  static var support: URL {
    FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(
      "Library/Application Support/MusicMuteLocal", isDirectory: true)
  }
  static var logs: URL { support.appendingPathComponent("logs", isDirectory: true) }

  static func descendant(_ path: String, of root: URL) -> URL? {
    guard path.hasPrefix("/"), !path.contains("\0") else { return nil }
    let candidate = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
    let parent = root.standardizedFileURL.resolvingSymlinksInPath()
    guard candidate.path.hasPrefix(parent.path + "/") else { return nil }
    return candidate
  }

  static func exportedReport(_ path: String) -> URL? {
    guard let url = descendant(path, of: logs.appendingPathComponent("exports", isDirectory: true)),
      url.pathExtension == "json",
      url.lastPathComponent.hasPrefix("diagnostics-"),
      UUID(uuidString: String(url.deletingPathExtension().lastPathComponent.dropFirst(12))) != nil,
      FileManager.default.fileExists(atPath: url.path)
    else { return nil }
    return url
  }
  static func isSetupURL(_ url: URL) -> Bool {
    url.scheme == "musicmute-local" && url.host == "setup" && (url.path.isEmpty || url.path == "/")
      && url.query == nil && url.fragment == nil && url.port == nil && url.user == nil
      && url.password == nil
  }
  static func isAccountURL(_ url: URL) -> Bool {
    url.scheme == "musicmute-local" && url.host == "account" && url.path.isEmpty
      && url.query == nil && url.fragment == nil && url.port == nil && url.user == nil
      && url.password == nil
  }
}

enum InstalledAppLocation {
  static let bundleFileName = "MusicMute Local.app"

  static func canonicalPath(_ url: URL) -> String {
    url.standardizedFileURL.resolvingSymlinksInPath().path
  }

  static func acceptedBundlePaths(home: URL) -> [String] {
    let system = URL(fileURLWithPath: "/Applications", isDirectory: true).appendingPathComponent(
      bundleFileName, isDirectory: true)
    let user = home.appendingPathComponent("Applications", isDirectory: true)
      .appendingPathComponent(bundleFileName, isDirectory: true)
    return [canonicalPath(system), canonicalPath(user)]
  }

  static func isInstalledCopy(
    _ bundleURL: URL, home: URL = FileManager.default.homeDirectoryForCurrentUser
  ) -> Bool {
    guard bundleURL.pathExtension == "app" else { return false }
    return acceptedBundlePaths(home: home).contains(canonicalPath(bundleURL))
  }

  static func preferredInstalledCopy(
    home: URL = FileManager.default.homeDirectoryForCurrentUser,
    fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
  ) -> URL? {
    acceptedBundlePaths(home: home).first { fileExists($0) }.map {
      URL(fileURLWithPath: $0, isDirectory: true)
    }
  }
}

struct LocalReport: Decodable, Sendable {
  let schemaVersion: Int?
  let createdAt: String?
  let availability: String?
  let identity: DiagnosticIdentity?
  let failureCode: String?
  let coverage: ReportCoverage?
  let counts: [String: Int]?
  let peaks: [String: Double]?
  let jobs: [ReportJob]?
  let recentErrors: [ReportEvent]?
  let recentWarnings: [ReportEvent]?
  let recentEvents: [ReportEvent]?
  let appUiEvents: [AppUiEvent]?
  let appUiCoverage: AppUiCoverage?
  let appSetupDiagnostics: AppSetupReport?
  let appDesktopDiagnostics: AppSetupReport?

  var errors: [ReportEvent] { Array((recentErrors ?? []).suffix(50)) }
  var warnings: [ReportEvent] { Array((recentWarnings ?? []).suffix(50)) }
  var events: [ReportEvent] { Array((recentEvents ?? []).suffix(100)).reversed() }
  var complete: Bool { availability == "available" && coverage?.incompleteHistory != true }
  var hasValidModelEvidence: Bool {
    [recentEvents, recentErrors, recentWarnings].allSatisfy { events in
      events?.allSatisfy(\.hasValidModelEvidence) != false
    } && appSetupDiagnostics?.hasValidModelEvidence != false
      && appDesktopDiagnostics?.hasValidModelEvidence != false
  }
}
struct AppUiEvent: Decodable, Identifiable, Sendable {
  let at: String
  let sessionId: String
  let event: String
  let code: String
  let command: String
  let identity: DiagnosticIdentity?
  var id: String { "\(sessionId)-\(at)-\(event)-\(code)" }
}
struct AppUiCoverage: Decodable, Sendable {
  let available: Bool?
  let malformedRecords: Int?
  let historyTruncated: Bool?
}
struct AppSetupReport: Decodable, Sendable {
  let availability: String?
  let identity: DiagnosticIdentity?
  let coverage: ReportCoverage?
  let counts: [String: Int]?
  let peaks: [String: Double]?
  let jobs: [ReportJob]?
  let recentErrors: [ReportEvent]?
  let recentWarnings: [ReportEvent]?
  let recentEvents: [ReportEvent]?

  var errors: [ReportEvent] { Array((recentErrors ?? []).suffix(8)).reversed() }
  var warnings: [ReportEvent] { Array((recentWarnings ?? []).suffix(8)).reversed() }
  var events: [ReportEvent] { Array((recentEvents ?? []).suffix(6)).reversed() }
  var hasValidCollectionBounds: Bool {
    (jobs?.count ?? 0) <= 100 && (recentErrors?.count ?? 0) <= 50
      && (recentWarnings?.count ?? 0) <= 50 && (recentEvents?.count ?? 0) <= 500
      && (counts?.count ?? 0) <= 64 && (peaks?.count ?? 0) <= 64
      && counts?.allSatisfy({ safeIdentifier($0.key) && $0.value >= 0 }) != false
      && peaks?.allSatisfy({ safeIdentifier($0.key) && $0.value.isFinite && $0.value >= 0 })
        != false
  }
  var hasValidModelEvidence: Bool {
    [recentEvents, recentErrors, recentWarnings].allSatisfy { events in
      events?.allSatisfy(\.hasValidModelEvidence) != false
    }
  }
}
struct ReportCoverage: Decodable, Sendable {
  let incompleteHistory: Bool?
  let malformedRecords: Int?
  let recoveredTailBytes: Int?
  let rejectedFields: Int?
  let failedWrites: Int?
  let retainedBytes: Int64?
  let maxLogBytes: Int64?
  let recentEventsTruncated: Bool?
  let jobSummariesTruncated: Bool?
  let readOnly: Bool?
  let unmeasured: [String]?
}
struct ReportJob: Decodable, Identifiable, Sendable {
  let jobId: String
  let state: String
  let elapsedMs: Double?
  let stagesMs: [String: Double]?
  let peaks: [String: Double]?
  let errorCodes: [String]?
  let incomplete: Bool?
  var id: String { jobId }
}
struct ReportEvent: Decodable, Identifiable, Sendable {
  let component: String?
  let severity: String?
  let event: String?
  let code: String?
  let jobId: String?
  let sequence: Int?
  let recordedAt: String?
  let sessionId: String?
  let metrics: [String: MetricValue]?
  let identity: DiagnosticIdentity?
  let verifiedModelSha256: String?
  var id: String { "\(sessionId ?? "local")-\(sequence ?? 0)-\(event ?? "event")" }
  var displayName: String {
    guard let event, safeIdentifier(event) else { return "Event" }
    return event.replacingOccurrences(of: "_", with: " ").capitalized
  }
  var displayComponent: String { displayCode(component) }
  var displayErrorCode: String? { code.map { displayCode($0) } }
  var displayTime: String? {
    guard let recordedAt, recordedAt.count <= 40,
      recordedAt.range(
        of:
          #"\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})\z"#,
        options: .regularExpression) != nil
    else { return nil }
    return String(recordedAt.dropFirst(11).prefix(8))
  }
  var hasValidModelEvidence: Bool {
    verifiedModelSha256.map(DiagnosticIdentity.validDigest) != false
  }
}
enum MetricValue: Decodable, Sendable {
  case number(Double)
  case boolean(Bool)
  case text(String)
  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if let value = try? container.decode(Bool.self) {
      self = .boolean(value)
    } else if let value = try? container.decode(Double.self), value.isFinite {
      self = .number(value)
    } else if let value = try? container.decode(String.self), value.count <= 80 {
      self = .text(value)
    } else {
      throw AppValidation.invalidMessage
    }
  }
}

func safeIdentifier(_ value: String) -> Bool {
  !value.isEmpty && value.count <= 80
    && value.unicodeScalars.allSatisfy {
      CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
        .contains($0)
    }
}
func displayCode(_ value: String?) -> String {
  guard let value, safeIdentifier(value) else { return "UNKNOWN_ERROR" }
  return value
}
func bytesLabel(_ value: Int64) -> String {
  ByteCountFormatter.string(fromByteCount: max(0, value), countStyle: .file)
}
func measuredBytesLabel(_ value: Double?) -> String {
  guard let value, value.isFinite, value >= 0, value < Double(Int64.max) else {
    return "Not sampled"
  }
  return bytesLabel(Int64(value))
}
func durationLabel(_ milliseconds: Double?) -> String {
  guard let milliseconds, milliseconds.isFinite, milliseconds >= 0 else { return "Not measured" }
  let seconds = milliseconds / 1000
  return seconds >= 60
    ? String(format: "%.1f min", seconds / 60) : String(format: "%.1f sec", seconds)
}
