import CoreFoundation
import CryptoKit
import Darwin
import Foundation

enum NativeDiagnosticIdentity {
  // Keep the expected model aligned with app-setup.ts; this is not a verified model observation.
  static let expectedModelSha256 =
    "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b"
  static let maxInventoryBytes = 8 * 1024 * 1024
  /// Production resolution is process-wide and uses only the running app's own bundle.
  static let current = resolve(bundle: .main)

  static func resolve(bundle: Bundle) -> DiagnosticIdentity {
    let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    let packaged =
      bundle.bundleIdentifier == "com.hatem.musicmute.local"
      && bundle.bundleURL.pathExtension == "app"
    return DiagnosticIdentity(
      softwareVersion: version.flatMap { DiagnosticIdentity.validVersion($0) ? $0 : nil }
        ?? "0.1.0",
      runtimeScope: packaged ? .packagedApp : .development,
      expectedModelSha256: expectedModelSha256,
      packageInventorySha256: packaged ? bundle.resourceURL.flatMap(inventoryDigest) : nil)
  }

  /// Tests pass owned temporary Resources directories; no environment override exists.
  static func inventoryDigest(resources: URL) -> String? {
    inventoryDigest(resources: resources, beforeFinalValidation: nil)
  }
  #if MUSICMUTE_NATIVE_TESTS
    /// Runs only in the source-test executable, after the descriptor has been validated.
    static func inventoryDigestForTesting(
      resources: URL, beforeFinalValidation: @escaping () -> Void
    ) -> String? {
      inventoryDigest(resources: resources, beforeFinalValidation: beforeFinalValidation)
    }
  #endif
  private static func inventoryDigest(
    resources: URL, beforeFinalValidation: (() -> Void)?
  ) -> String? {
    var directory = stat()
    guard lstat(resources.path, &directory) == 0, safeResources(directory)
    else { return nil }
    let path = resources.appendingPathComponent("bundle-audit.json").path
    var before = stat()
    guard lstat(path, &before) == 0, safeInventory(before) else { return nil }
    let descriptor = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    guard descriptor >= 0 else { return nil }
    defer { _ = close(descriptor) }
    var opened = stat()
    guard fstat(descriptor, &opened) == 0, safeInventory(opened), unchanged(before, opened)
    else { return nil }
    var data = Data()
    data.reserveCapacity(Int(opened.st_size))
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    while data.count <= maxInventoryBytes {
      let limit = min(buffer.count, maxInventoryBytes + 1 - data.count)
      let count = buffer.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress, limit) }
      if count < 0 && errno == EINTR { continue }
      guard count >= 0 else { return nil }
      if count == 0 { break }
      data.append(contentsOf: buffer.prefix(count))
    }
    var after = stat()
    guard data.count <= maxInventoryBytes, data.count == Int(opened.st_size),
      fstat(descriptor, &after) == 0, safeInventory(after), unchanged(opened, after),
      validInventory(data)
    else { return nil }
    beforeFinalValidation?()
    // The descriptor may remain valid after a path or its parent has been replaced.
    var finalDirectory = stat()
    var finalPath = stat()
    guard lstat(resources.path, &finalDirectory) == 0, safeResources(finalDirectory),
      directory.st_dev == finalDirectory.st_dev, directory.st_ino == finalDirectory.st_ino,
      lstat(path, &finalPath) == 0, safeInventory(finalPath), unchanged(after, finalPath)
    else { return nil }
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
  private static func safeResources(_ info: stat) -> Bool {
    // Signed app resources may belong to the installing administrator. Mutable
    // user journal storage below keeps its current-owner checks.
    (info.st_mode & S_IFMT) == S_IFDIR && (info.st_mode & 0o022) == 0
  }
  private static func safeInventory(_ info: stat) -> Bool {
    (info.st_mode & S_IFMT) == S_IFREG && info.st_nlink == 1
      && (info.st_mode & 0o022) == 0 && info.st_size > 0 && info.st_size <= maxInventoryBytes
  }
  private static func unchanged(_ lhs: stat, _ rhs: stat) -> Bool {
    lhs.st_dev == rhs.st_dev && lhs.st_ino == rhs.st_ino && lhs.st_size == rhs.st_size
      && lhs.st_mode == rhs.st_mode && lhs.st_uid == rhs.st_uid && lhs.st_nlink == rhs.st_nlink
      && lhs.st_mtimespec.tv_sec == rhs.st_mtimespec.tv_sec
      && lhs.st_mtimespec.tv_nsec == rhs.st_mtimespec.tv_nsec
      && lhs.st_ctimespec.tv_sec == rhs.st_ctimespec.tv_sec
      && lhs.st_ctimespec.tv_nsec == rhs.st_ctimespec.tv_nsec
  }
  private static func validInventory(_ data: Data) -> Bool {
    guard let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let schema = value["schema_version"] as? NSNumber,
      CFGetTypeID(schema) != CFBooleanGetTypeID(), schema.doubleValue == 1,
      value["architecture"] as? String == "arm64",
      let model = value["includes_model_weights"] as? NSNumber,
      CFGetTypeID(model) == CFBooleanGetTypeID(), !model.boolValue,
      let worker = value["includes_worker_state"] as? NSNumber,
      CFGetTypeID(worker) == CFBooleanGetTypeID(), !worker.boolValue,
      let files = value["files"] as? [Any], !files.isEmpty, files.count <= 50_000
    else { return false }
    return true
  }
}

enum UIJournalEvent: String, Sendable {
  case appOperationError = "app_operation_error"
  case appStarted = "app_started"
  case appSetupCancelled = "app_setup_cancelled"
}
private struct UIJournalRecord: Encodable {
  let schemaVersion = 1
  let at: String
  let sessionId: String
  let event: String
  let code: String
  let command: String
  let identity: DiagnosticIdentity
  enum CodingKeys: String, CodingKey {
    case schemaVersion = "schema_version"
    case sessionId = "session_id"
    case at, event, code, command, identity
  }
}
private enum JournalError: Error { case unsafeStorage, writeFailed }

/// Independent app-shell evidence. The Node writer owns other log filenames.
final class UIJournal: @unchecked Sendable {
  static let maxSegmentBytes = 512 * 1024
  private let queue = DispatchQueue(label: "com.musicmute.local.ui-journal", qos: .utility)
  private let root: URL
  private let session = UUID().uuidString.lowercased()
  private let maxBytes: Int
  private let identity: DiagnosticIdentity
  private var available = true
  private var failureHandler: (@Sendable () -> Void)?
  private let formatter = ISO8601DateFormatter()
  private static let codes: Set<String> = [
    "NONE", "UNKNOWN_ERROR", "APP_OPERATION_BUSY", "APP_RESOURCES_INCOMPLETE",
    "LOCAL_COMPANION_BUSY", "LOCAL_COMPANION_LOCK_UNSAFE", "LOCAL_COMPANION_START_FAILED",
    "APP_PROCESS_START_FAILED", "APP_OPERATION_TIMEOUT", "APP_CONTROL_INVALID",
    "APP_PROCESS_EXITED", "APP_RESULT_MISSING", "APP_EXPORT_PATH_INVALID",
    "APP_UI_JOURNAL_UNAVAILABLE",
    "UNSUPPORTED_PLATFORM", "CHROME_NOT_INSTALLED", "CHROME_OPEN_FAILED",
    "MODEL_DOWNLOAD_INTERRUPTED", "MODEL_DOWNLOAD_FAILED", "MODEL_CHECKSUM_MISMATCH",
    "MODEL_NOT_READY", "MODEL_SOURCE_UNAVAILABLE", "MODEL_SETUP_FAILED", "MODEL_DOWNLOAD_INVALID",
    "MODEL_SIZE_MISMATCH", "SETUP_REQUIRED", "SETUP_CANCELLED", "SETUP_FAILED",
    "DEV_RUNTIME_INCOMPLETE", "DEV_RUNTIME_MISSING", "ENGINE_DOCTOR_INVALID", "ENGINE_MISSING",
    "ENGINE_NOT_READY", "INVALID_LOCAL_CONFIG", "LOCAL_DIRECTORY_NOT_PRIVATE", "YT_DLP_MISSING",
    "YT_DLP_VERSION_INVALID", "YT_DLP_EJS_MISSING", "YT_DLP_IDENTITY_INVALID", "DISK_SPACE_LOW",
    "MEMORY_LOW", "TOOL_FAILED", "TOOL_TIMEOUT", "TOOL_UNAVAILABLE", "COMMAND_FAILED",
    "DIAGNOSTICS_EXPORT_FAILED", "DIAGNOSTICS_UNAVAILABLE", "COMPANION_CRASH",
    "COMPANION_REJECTION",
    "APP_RUNTIME_MISSING", "APP_RUNTIME_INVALID", "APP_MANIFEST_INVALID", "APP_NODE_INVALID",
    "APP_MODEL_INVALID", "APP_REGISTRATION_FAILED", "APP_ALREADY_RUNNING",
    "FOREIGN_NATIVE_REGISTRATION", "NATIVE_REGISTRATION_CONFLICT", "INVALID_EXTENSION_PATH",
    "INVALID_APP_RESOURCES", "APP_SETUP_FAILED", "APP_SETUP_CANCELLED", "APP_STATUS_FAILED",
    "APP_REPLY_TOO_LARGE", "APP_RESOURCES_REQUIRED", "APP_RESOURCES_MISSING", "APP_COMMAND_FAILED",
    "INVALID_APP_COMMAND", "CANCELLED", "EXTENSION_MANIFEST_KEY_INVALID",
    "FOREIGN_NATIVE_LAUNCHER_EXISTS", "FOREIGN_NATIVE_REGISTRATION_EXISTS", "MODEL_CACHE_INVALID",
    "MODEL_CHECKSUM_INVALID", "MODEL_DOWNLOAD_TIMEOUT", "MODEL_REDIRECT_INVALID",
    "MODEL_SIZE_INVALID", "MODEL_SOURCE_INVALID", "SETUP_BUSY",
    "UNSAFE_NATIVE_REGISTRATION_DIRECTORY", "UNSAFE_SETUP_FILE", "CLI_OPTION_UNSUPPORTED",
    "CACHE_PIN_UNAVAILABLE", "DESKTOP_PLAYBACK_START_FAILED", "DESKTOP_AUDIO_PLAYBACK_FAILED",
    "GOOGLE_SIGN_IN_TIMEOUT", "AUTH_SIGN_IN_FAILED",
    "GOOGLE_TOKEN_INVALID_CLIENT", "GOOGLE_TOKEN_INVALID_GRANT", "GOOGLE_TOKEN_INVALID_REQUEST",
    "GOOGLE_TOKEN_REDIRECT_MISMATCH", "GOOGLE_TOKEN_UNAVAILABLE", "GOOGLE_CLIENT_SECRET_REQUIRED",
    "GOOGLE_TOKEN_EXCHANGE_FAILED",
  ]

  init(
    logsRoot: URL = LocalPaths.logs, maxBytes: Int = UIJournal.maxSegmentBytes,
    identity: DiagnosticIdentity = NativeDiagnosticIdentity.current
  ) {
    root = logsRoot.standardizedFileURL
    self.maxBytes = max(512, min(maxBytes, Self.maxSegmentBytes))
    self.identity = identity
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  }
  func setFailureHandler(_ callback: @escaping @Sendable () -> Void) {
    queue.async { self.failureHandler = callback }
  }
  func record(_ event: UIJournalEvent, code: String = "NONE", command: AppCommand? = nil) {
    let safeCode = Self.codes.contains(code) ? code : "UNKNOWN_ERROR"
    queue.async {
      guard self.available else { return }
      do {
        let record = UIJournalRecord(
          at: self.formatter.string(from: Date()), sessionId: self.session, event: event.rawValue,
          code: safeCode, command: command?.rawValue ?? "none", identity: self.identity)
        var bytes = try JSONEncoder().encode(record)
        bytes.append(10)
        try self.write(bytes)
      } catch {
        self.available = false
        self.failureHandler?()
      }
    }
  }
  // Unit checks only. Product code observes asynchronous failure callbacks.
  func flushForTesting() { queue.sync {} }
  var availableForTesting: Bool { queue.sync { available } }

  private func write(_ data: Data) throws {
    guard data.count <= maxBytes else { throw JournalError.writeFailed }
    var info = stat()
    if lstat(root.path, &info) != 0 {
      guard errno == ENOENT else { throw JournalError.unsafeStorage }
      try FileManager.default.createDirectory(
        at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      guard lstat(root.path, &info) == 0 else { throw JournalError.unsafeStorage }
    }
    guard (info.st_mode & S_IFMT) == S_IFDIR, info.st_uid == getuid(), (info.st_mode & 0o077) == 0
    else { throw JournalError.unsafeStorage }
    let path = root.appendingPathComponent("ui-events.jsonl").path
    let archive = root.appendingPathComponent("ui-events.jsonl.1").path
    if try safeFile(path), fileSize(path) + data.count > maxBytes {
      if try safeFile(archive) {
        guard unlink(archive) == 0 else { throw JournalError.writeFailed }
      }
      guard rename(path, archive) == 0 else { throw JournalError.writeFailed }
    }
    let descriptor = open(path, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else { throw JournalError.unsafeStorage }
    defer { _ = close(descriptor) }
    var file = stat()
    guard fstat(descriptor, &file) == 0, (file.st_mode & S_IFMT) == S_IFREG, file.st_nlink == 1,
      file.st_uid == getuid(), (file.st_mode & 0o077) == 0
    else { throw JournalError.unsafeStorage }
    try data.withUnsafeBytes { buffer in
      guard let base = buffer.baseAddress else { throw JournalError.writeFailed }
      var offset = 0
      while offset < buffer.count {
        let count = Darwin.write(descriptor, base.advanced(by: offset), buffer.count - offset)
        if count < 0 && errno == EINTR { continue }
        guard count > 0 else { throw JournalError.writeFailed }
        offset += count
      }
    }
    guard fsync(descriptor) == 0 else { throw JournalError.writeFailed }
  }
  private func safeFile(_ path: String) throws -> Bool {
    var info = stat()
    if lstat(path, &info) != 0 {
      if errno == ENOENT { return false }
      throw JournalError.unsafeStorage
    }
    guard (info.st_mode & S_IFMT) == S_IFREG, info.st_nlink == 1, info.st_uid == getuid(),
      (info.st_mode & 0o077) == 0,
      info.st_size <= maxBytes
    else { throw JournalError.unsafeStorage }
    return true
  }
  private func fileSize(_ path: String) -> Int {
    var info = stat()
    return lstat(path, &info) == 0 ? Int(info.st_size) : 0
  }
}
