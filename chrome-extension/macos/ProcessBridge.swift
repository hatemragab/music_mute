import CryptoKit
import Darwin
import Foundation
import LocalAuthentication
import Security

enum RuntimeBootstrapFailure: Error, Equatable, Sendable {
  case code(String)
  case cancelled

  var errorCode: String {
    switch self {
    case .code(let value): value
    case .cancelled: "RUNTIME_CANCELLED"
    }
  }
}

struct RuntimePOSIXIntegerResult {
  let value: Int32
  let error: Int32?

  var succeeded: Bool { error == nil }
}

struct RuntimePOSIXPointerResult<Pointee> {
  let value: UnsafeMutablePointer<Pointee>?
  let error: Int32?

  var succeeded: Bool { error == nil }
}

enum RuntimePOSIXCall {
  static func retryingInteger(
    _ operation: () -> Int32, captureErrno: () -> Int32 = { Darwin.errno }
  ) -> RuntimePOSIXIntegerResult {
    while true {
      let value = operation()
      guard value == -1 else { return RuntimePOSIXIntegerResult(value: value, error: nil) }
      let error = captureErrno()
      if error == EINTR { continue }
      return RuntimePOSIXIntegerResult(value: value, error: error)
    }
  }

  static func retryingPointer<Pointee>(
    _ operation: () -> UnsafeMutablePointer<Pointee>?,
    captureErrno: () -> Int32 = { Darwin.errno }
  ) -> RuntimePOSIXPointerResult<Pointee> {
    while true {
      let value = operation()
      guard value == nil else { return RuntimePOSIXPointerResult(value: value, error: nil) }
      let error = captureErrno()
      if error == EINTR { continue }
      return RuntimePOSIXPointerResult(value: value, error: error)
    }
  }

  static func wouldBlock(_ error: Int32?) -> Bool {
    error == EWOULDBLOCK || error == EAGAIN
  }
}

/// Opens the permanent app-update lock without using the racy `O_CREAT`-without-`O_EXCL`
/// combination. macOS may report `ENOENT` to one of simultaneous creators even though another
/// creator has installed the name. Only the precise create-lost/open-disappeared transition is
/// retried; all other errors remain terminal and callers still verify the descriptor and name.
enum RuntimeUpdateLockFile {
  static let maximumCreateOpenTransitions = 4

  static func open(in directory: Int32) -> RuntimePOSIXIntegerResult {
    createOrOpen(
      create: {
        RuntimePOSIXCall.retryingInteger {
          openat(
            directory, "update.lock",
            O_RDWR | O_CREAT | O_EXCL | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW, 0o600)
        }
      },
      openExisting: {
        RuntimePOSIXCall.retryingInteger {
          openat(directory, "update.lock", O_RDWR | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW)
        }
      })
  }

  static func createOrOpen(
    create: () -> RuntimePOSIXIntegerResult,
    openExisting: () -> RuntimePOSIXIntegerResult
  ) -> RuntimePOSIXIntegerResult {
    for _ in 0..<maximumCreateOpenTransitions {
      let created = create()
      if created.succeeded { return created }
      guard created.error == EEXIST else { return created }

      let existing = openExisting()
      if existing.succeeded { return existing }
      guard existing.error == ENOENT else { return existing }
    }
    return RuntimePOSIXIntegerResult(value: -1, error: ENOENT)
  }
}

struct RuntimeBootstrapDocument: Decodable, Sendable {
  let schemaVersion: Int
  let runtime: RuntimeBootstrapManifest

  enum CodingKeys: String, CodingKey {
    case schemaVersion = "schema_version"
    case runtime
  }

  static func load(resources: URL) throws -> (document: Self, digest: String) {
    let file = resources.appendingPathComponent("runtime-bootstrap.json")
    let data: Data
    do {
      data = try RuntimeFileSecurity.readRegularFile(
        file, maximumBytes: 16 * 1024 * 1024, requireCurrentOwner: false,
        privatePermissions: false, code: "RUNTIME_MANIFEST_INVALID")
    } catch {
      throw RuntimeBootstrapFailure.code("RUNTIME_MANIFEST_INVALID")
    }
    guard !data.isEmpty else { throw RuntimeBootstrapFailure.code("RUNTIME_MANIFEST_INVALID") }
    let document: Self
    do { document = try JSONDecoder().decode(Self.self, from: data) } catch {
      throw RuntimeBootstrapFailure.code("RUNTIME_MANIFEST_INVALID")
    }
    try document.validate()
    return (document, RuntimeDigest.data(data))
  }

  static func decodeValidated(_ data: Data) throws -> Self {
    let document: Self
    do { document = try JSONDecoder().decode(Self.self, from: data) } catch {
      throw RuntimeBootstrapFailure.code("RUNTIME_MANIFEST_INVALID")
    }
    try document.validate()
    return document
  }

  func validate() throws {
    guard schemaVersion == 1 else {
      throw RuntimeBootstrapFailure.code("RUNTIME_MANIFEST_INVALID")
    }
    try runtime.validate()
  }
}

struct RuntimeBootstrapManifest: Decodable, Sendable {
  let id: String
  let apiVersion: Int
  let platform: String
  let arch: String
  let url: String
  let archiveFormat: String
  let archiveSha256: String
  let archiveBytes: Int64
  let installedBytes: Int64
  let downloadHosts: [String]
  let signing: RuntimeSigningManifest
  let files: [RuntimeFileManifest]

  enum CodingKeys: String, CodingKey {
    case id
    case apiVersion = "api_version"
    case platform, arch, url
    case archiveFormat = "archive_format"
    case archiveSha256 = "archive_sha256"
    case archiveBytes = "archive_bytes"
    case installedBytes = "installed_bytes"
    case downloadHosts = "download_hosts"
    case signing, files
  }

  var archiveURL: URL? { URL(string: url) }

  func validate() throws {
    guard RuntimePath.safeIdentifier(id), apiVersion == 1, platform == "darwin", arch == "arm64",
      archiveFormat == "zip", RuntimeDigest.valid(archiveSha256), archiveBytes > 0,
      archiveBytes <= 2_000_000_000, installedBytes > 0, installedBytes <= 4_000_000_000,
      files.count >= 5, files.count <= 50_000,
      let archiveURL, RuntimePath.safeDownloadURL(archiveURL),
      let sourceHost = archiveURL.host?.lowercased(), !downloadHosts.isEmpty,
      downloadHosts.count <= 8
    else { throw RuntimeBootstrapFailure.code("RUNTIME_MANIFEST_INVALID") }
    let hosts = downloadHosts.map { $0.lowercased() }
    guard hosts.contains(sourceHost), Set(hosts).count == hosts.count,
      hosts.allSatisfy(RuntimePath.safeHost)
    else { throw RuntimeBootstrapFailure.code("RUNTIME_MANIFEST_INVALID") }
    try signing.validate()
    var paths = Set<String>()
    for file in files {
      try file.validate(signing: signing)
      guard paths.insert(file.path).inserted else {
        throw RuntimeBootstrapFailure.code("RUNTIME_MANIFEST_INVALID")
      }
    }
    let required = [
      "runtime/runtime/node/bin/node", "runtime/runtime/python/bin/python3",
      "runtime/runtime/bin/ffmpeg", "runtime/runtime/bin/ffprobe",
      "runtime/tools/youtube/bin/deno",
    ]
    guard required.allSatisfy(paths.contains), files.contains(where: { $0.codeSigned == true })
    else {
      throw RuntimeBootstrapFailure.code("RUNTIME_MANIFEST_INVALID")
    }
  }
}

struct RuntimeSigningManifest: Decodable, Sendable {
  let mode: String
  let teamID: String?

  enum CodingKeys: String, CodingKey {
    case mode
    case teamID = "team_id"
  }

  func validate() throws {
    switch mode {
    case "developer_id":
      guard let teamID,
        teamID.range(of: #"\A[A-Z0-9]{10}\z"#, options: .regularExpression) != nil
      else { throw RuntimeBootstrapFailure.code("RUNTIME_MANIFEST_INVALID") }
    case "ad_hoc":
      guard teamID == nil else {
        throw RuntimeBootstrapFailure.code("RUNTIME_MANIFEST_INVALID")
      }
    default: throw RuntimeBootstrapFailure.code("RUNTIME_MANIFEST_INVALID")
    }
  }
}

struct RuntimeFileManifest: Decodable, Sendable {
  let path: String
  let type: String
  let bytes: Int64?
  let sha256: String?
  let executable: Bool?
  let codeSigned: Bool?
  let linkTarget: String?

  enum CodingKeys: String, CodingKey {
    case path, type, bytes, sha256, executable
    case codeSigned = "code_signed"
    case linkTarget = "link_target"
  }

  func validate(signing: RuntimeSigningManifest) throws {
    guard RuntimePath.safeRelative(path), path.hasPrefix("runtime/") else {
      throw RuntimeBootstrapFailure.code("RUNTIME_MANIFEST_INVALID")
    }
    switch type {
    case "file":
      guard let bytes, bytes >= 0, bytes <= 1_000_000_000,
        let sha256, RuntimeDigest.valid(sha256), linkTarget == nil,
        executable != nil, codeSigned != nil
      else { throw RuntimeBootstrapFailure.code("RUNTIME_MANIFEST_INVALID") }
    case "symlink":
      guard bytes == nil, sha256 == nil, executable == nil, codeSigned == nil,
        let linkTarget, RuntimePath.safeLinkTarget(linkTarget, from: path)
      else { throw RuntimeBootstrapFailure.code("RUNTIME_MANIFEST_INVALID") }
    default: throw RuntimeBootstrapFailure.code("RUNTIME_MANIFEST_INVALID")
    }
  }
}

struct RuntimeActiveDocument: Codable, Equatable, Sendable {
  let schemaVersion: Int
  let runtimeID: String
  let apiVersion: Int
  let releasePath: String
  let archiveSha256: String

  enum CodingKeys: String, CodingKey {
    case schemaVersion = "schema_version"
    case runtimeID = "runtime_id"
    case apiVersion = "api_version"
    case releasePath = "release_path"
    case archiveSha256 = "archive_sha256"
  }

  init(runtime: RuntimeBootstrapManifest) {
    schemaVersion = 1
    runtimeID = runtime.id
    apiVersion = runtime.apiVersion
    releasePath = "releases/\(runtime.id)"
    archiveSha256 = runtime.archiveSha256
  }

  func matches(_ runtime: RuntimeBootstrapManifest) -> Bool {
    schemaVersion == 1 && runtimeID == runtime.id && apiVersion == runtime.apiVersion
      && releasePath == "releases/\(runtime.id)" && archiveSha256 == runtime.archiveSha256
  }

  var structurallySafe: Bool {
    schemaVersion == 1 && RuntimePath.safeIdentifier(runtimeID) && apiVersion == 1
      && releasePath == "releases/\(runtimeID)" && RuntimeDigest.valid(archiveSha256)
  }
}

enum RuntimePath {
  static func safeIdentifier(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 64
      && value.range(of: #"\A[A-Za-z0-9][A-Za-z0-9._-]*\z"#, options: .regularExpression)
        != nil
  }

  static func safeHost(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 253 && value == value.lowercased()
      && value.range(
        of:
          #"\A(?=.{1,253}\z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\z"#,
        options: .regularExpression) != nil
  }

  static func safeDownloadURL(_ url: URL) -> Bool {
    safeTransportURL(url)
      && url.user == nil && url.password == nil && url.fragment == nil
      && url.query == nil
  }

  static func safeTransportURL(_ url: URL) -> Bool {
    url.scheme?.lowercased() == "https" && url.host.map { safeHost($0.lowercased()) } == true
      && url.user == nil && url.password == nil && url.fragment == nil
      && (url.port == nil || url.port == 443) && (url.query?.utf8.count ?? 0) <= 4096
  }

  static func safeRelative(_ value: String) -> Bool {
    guard !value.isEmpty, value.utf8.count <= 4096, !value.hasPrefix("/"),
      !value.hasSuffix("/"), !value.contains("\\"), !value.contains("\0"),
      !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 })
    else { return false }
    let components = value.split(separator: "/", omittingEmptySubsequences: false)
    return !components.isEmpty
      && components.allSatisfy {
        !$0.isEmpty && $0 != "." && $0 != ".." && $0.utf8.count <= 255
      }
  }

  static func safeLinkTarget(_ target: String, from path: String) -> Bool {
    guard !target.isEmpty, target.utf8.count <= 4096, !target.hasPrefix("/"),
      !target.contains("\\"), !target.contains("\0"),
      !target.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 })
    else { return false }
    var stack = Array(path.split(separator: "/").dropLast()).map(String.init)
    for component in target.split(separator: "/", omittingEmptySubsequences: false) {
      if component.isEmpty || component == "." { continue }
      if component == ".." {
        guard !stack.isEmpty else { return false }
        stack.removeLast()
      } else {
        guard component.utf8.count <= 255 else { return false }
        stack.append(String(component))
      }
    }
    return stack.first == "runtime"
  }

  static func canonicalExisting(_ url: URL) -> String? {
    var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
    return url.path.withCString { pointer in
      let resolved = RuntimePOSIXCall.retryingPointer { realpath(pointer, &buffer) }
      guard resolved.succeeded else { return nil }
      let end = buffer.firstIndex(of: 0) ?? buffer.endIndex
      return String(decoding: buffer[..<end].map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }
  }
}

enum RuntimeDigest {
  static func valid(_ value: String) -> Bool {
    value.utf8.count == 64
      && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
  }

  static func data(_ value: Data) -> String {
    SHA256.hash(data: value).map { String(format: "%02x", $0) }.joined()
  }

  static func file(_ url: URL, expectedBytes: Int64? = nil) throws -> String {
    let descriptor = open(url.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
    guard descriptor >= 0 else {
      throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID")
    }
    var information = stat()
    guard fstat(descriptor, &information) == 0,
      information.st_mode & S_IFMT == S_IFREG,
      information.st_nlink == 1,
      information.st_uid == getuid(),
      information.st_mode & 0o022 == 0,
      expectedBytes == nil || information.st_size == expectedBytes
    else {
      close(descriptor)
      throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID")
    }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    defer { try? handle.close() }
    var digest = SHA256()
    do {
      while let bytes = try handle.read(upToCount: 1024 * 1024), !bytes.isEmpty {
        digest.update(data: bytes)
      }
    } catch { throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID") }
    return digest.finalize().map { String(format: "%02x", $0) }.joined()
  }
}

enum RuntimeFileSecurity {
  static func readRegularFile(
    _ url: URL, maximumBytes: Int64, requireCurrentOwner: Bool,
    privatePermissions: Bool, code: String
  ) throws -> Data {
    let descriptor = open(url.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
    guard descriptor >= 0 else { throw RuntimeBootstrapFailure.code(code) }
    var information = stat()
    guard fstat(descriptor, &information) == 0,
      information.st_mode & S_IFMT == S_IFREG,
      information.st_nlink == 1,
      !requireCurrentOwner || information.st_uid == getuid(),
      information.st_mode & (privatePermissions ? 0o077 : 0o022) == 0,
      information.st_size >= 0, information.st_size <= maximumBytes
    else {
      close(descriptor)
      throw RuntimeBootstrapFailure.code(code)
    }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    defer { try? handle.close() }
    do {
      let data = try handle.readToEnd() ?? Data()
      guard data.count == information.st_size else { throw RuntimeBootstrapFailure.code(code) }
      return data
    } catch let failure as RuntimeBootstrapFailure { throw failure } catch {
      throw RuntimeBootstrapFailure.code(code)
    }
  }

  static func ensurePrivateDirectory(_ url: URL) throws {
    var information = stat()
    if lstat(url.path, &information) != 0 {
      guard errno == ENOENT else {
        throw RuntimeBootstrapFailure.code("LOCAL_DIRECTORY_NOT_PRIVATE")
      }
      do {
        try FileManager.default.createDirectory(
          at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      } catch { throw RuntimeBootstrapFailure.code("LOCAL_DIRECTORY_NOT_PRIVATE") }
      guard lstat(url.path, &information) == 0 else {
        throw RuntimeBootstrapFailure.code("LOCAL_DIRECTORY_NOT_PRIVATE")
      }
    }
    guard information.st_mode & S_IFMT == S_IFDIR, information.st_uid == getuid(),
      information.st_mode & 0o077 == 0
    else { throw RuntimeBootstrapFailure.code("LOCAL_DIRECTORY_NOT_PRIVATE") }
  }

  static func readPrivateFile(_ url: URL, maximumBytes: Int64) throws -> Data {
    try readRegularFile(
      url, maximumBytes: maximumBytes, requireCurrentOwner: true, privatePermissions: true,
      code: "RUNTIME_ACTIVE_INVALID")
  }

  static func atomicWrite(_ data: Data, to destination: URL, mode: mode_t = 0o400) throws {
    let directory = destination.deletingLastPathComponent()
    try ensurePrivateDirectory(directory)
    let temporary = directory.appendingPathComponent(".active-\(UUID().uuidString).tmp")
    let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else { throw RuntimeBootstrapFailure.code("RUNTIME_ACTIVATION_FAILED") }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    do {
      try handle.write(contentsOf: data)
      try handle.synchronize()
      try handle.close()
      guard chmod(temporary.path, mode) == 0,
        rename(temporary.path, destination.path) == 0
      else { throw RuntimeBootstrapFailure.code("RUNTIME_ACTIVATION_FAILED") }
      let directoryDescriptor = open(directory.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
      if directoryDescriptor >= 0 {
        _ = fsync(directoryDescriptor)
        close(directoryDescriptor)
      }
    } catch {
      try? handle.close()
      unlink(temporary.path)
      if let failure = error as? RuntimeBootstrapFailure { throw failure }
      throw RuntimeBootstrapFailure.code("RUNTIME_ACTIVATION_FAILED")
    }
  }

  static func exclusiveRename(_ source: URL, to destination: URL) -> Bool {
    renamex_np(source.path, destination.path, UInt32(RENAME_EXCL)) == 0
  }

  static func removeOwnedTree(_ root: URL, maximumEntries: Int = 100_000) throws {
    let root = root.standardizedFileURL
    var rootInformation = stat()
    guard lstat(root.path, &rootInformation) == 0,
      rootInformation.st_mode & S_IFMT == S_IFDIR,
      rootInformation.st_uid == getuid(), chmod(root.path, 0o700) == 0
    else { throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED") }
    var enumerationFailed = false
    guard
      let enumerator = FileManager.default.enumerator(
        at: root, includingPropertiesForKeys: nil, options: [],
        errorHandler: { _, _ in
          enumerationFailed = true
          return false
        })
    else { throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED") }
    var count = 0
    while let candidate = enumerator.nextObject() as? URL {
      count += 1
      guard count <= maximumEntries,
        candidate.standardizedFileURL.path.hasPrefix(root.path + "/")
      else { throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED") }
      var information = stat()
      guard lstat(candidate.path, &information) == 0, information.st_uid == getuid()
      else { throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED") }
      if information.st_mode & S_IFMT == S_IFDIR {
        guard chmod(candidate.path, 0o700) == 0 else {
          throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED")
        }
      }
    }
    guard !enumerationFailed else {
      throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED")
    }
    do { try FileManager.default.removeItem(at: root) } catch {
      throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED")
    }
  }
}

struct RuntimeDownloadResumeState: Codable, Equatable, Sendable {
  static let maximumBytes: Int64 = 4 * 1024
  static let maximumETagBytes = 512

  let schemaVersion: Int
  let runtimeID: String
  let url: String
  let archiveSha256: String
  let archiveBytes: Int64
  let etag: String

  enum CodingKeys: String, CodingKey {
    case schemaVersion = "schema_version"
    case runtimeID = "runtime_id"
    case url
    case archiveSha256 = "archive_sha256"
    case archiveBytes = "archive_bytes"
    case etag
  }

  init(manifest: RuntimeBootstrapManifest, etag: String) {
    schemaVersion = 1
    runtimeID = manifest.id
    url = manifest.url
    archiveSha256 = manifest.archiveSha256
    archiveBytes = manifest.archiveBytes
    self.etag = etag
  }

  func matches(_ manifest: RuntimeBootstrapManifest) -> Bool {
    schemaVersion == 1 && runtimeID == manifest.id && url == manifest.url
      && archiveSha256 == manifest.archiveSha256 && archiveBytes == manifest.archiveBytes
      && Self.strongETag(etag)
  }

  static func strongETag(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard bytes.count >= 2, bytes.count <= maximumETagBytes, bytes.first == 0x22,
      bytes.last == 0x22
    else { return false }
    return bytes.dropFirst().dropLast().allSatisfy { byte in
      byte == 0x21 || (0x23...0x7e).contains(byte)
    }
  }

  static func sidecar(for partial: URL) -> URL {
    partial.appendingPathExtension("resume.json")
  }

  static func validated(
    partial: URL, manifest: RuntimeBootstrapManifest
  ) throws -> (state: Self, bytes: Int64)? {
    let sidecar = sidecar(for: partial)
    let partialInformation = try privateRegularFileInformation(partial)
    let sidecarInformation = try privateRegularFileInformation(sidecar)
    guard let partialInformation, let sidecarInformation else {
      if partialInformation != nil || sidecarInformation != nil {
        try discard(partial: partial)
      }
      return nil
    }
    guard partialInformation.st_size > 0,
      partialInformation.st_size <= manifest.archiveBytes,
      sidecarInformation.st_size > 0,
      sidecarInformation.st_size <= maximumBytes
    else {
      try discard(partial: partial)
      return nil
    }
    let data: Data
    do {
      data = try RuntimeFileSecurity.readRegularFile(
        sidecar, maximumBytes: maximumBytes, requireCurrentOwner: true,
        privatePermissions: true, code: "RUNTIME_DOWNLOAD_UNSAFE")
    } catch let failure as RuntimeBootstrapFailure {
      throw failure
    } catch {
      throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_UNSAFE")
    }
    guard let state = try? JSONDecoder().decode(Self.self, from: data), state.matches(manifest)
    else {
      try discard(partial: partial)
      return nil
    }
    return (state, partialInformation.st_size)
  }

  static func persist(_ state: Self, for partial: URL) throws {
    guard strongETag(state.etag) else {
      throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_FAILED")
    }
    let destination = sidecar(for: partial)
    let directory = destination.deletingLastPathComponent()
    try RuntimeFileSecurity.ensurePrivateDirectory(directory)
    _ = try privateRegularFileInformation(destination)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    var data = try encoder.encode(state)
    data.append(10)
    guard !data.isEmpty, data.count <= Int(maximumBytes) else {
      throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_FAILED")
    }
    let temporary = directory.appendingPathComponent(
      ".runtime-resume-\(UUID().uuidString).tmp")
    let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else {
      throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_FAILED")
    }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    var renamed = false
    do {
      try handle.write(contentsOf: data)
      try handle.synchronize()
      try handle.close()
      guard chmod(temporary.path, 0o400) == 0,
        rename(temporary.path, destination.path) == 0
      else { throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_FAILED") }
      renamed = true
      try synchronizeDirectory(directory)
    } catch {
      try? handle.close()
      _ = unlink(temporary.path)
      if renamed {
        _ = unlink(destination.path)
        try? synchronizeDirectory(directory)
      }
      if let failure = error as? RuntimeBootstrapFailure { throw failure }
      throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_FAILED")
    }
  }

  static func discard(partial: URL) throws {
    let sidecar = sidecar(for: partial)
    let hadSidecar = try removePrivateRegularFileIfPresent(sidecar)
    let hadPartial = try removePrivateRegularFileIfPresent(partial)
    if hadSidecar || hadPartial {
      try synchronizeDirectory(partial.deletingLastPathComponent())
    }
  }

  static func discardSidecar(for partial: URL) throws {
    if try removePrivateRegularFileIfPresent(sidecar(for: partial)) {
      try synchronizeDirectory(partial.deletingLastPathComponent())
    }
  }

  private static func privateRegularFileInformation(_ url: URL) throws -> stat? {
    var information = stat()
    guard lstat(url.path, &information) == 0 else {
      if errno == ENOENT { return nil }
      throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_UNSAFE")
    }
    guard information.st_mode & S_IFMT == S_IFREG,
      information.st_uid == getuid(), information.st_nlink == 1,
      information.st_mode & 0o077 == 0, information.st_size >= 0
    else { throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_UNSAFE") }
    return information
  }

  @discardableResult private static func removePrivateRegularFileIfPresent(_ url: URL) throws
    -> Bool
  {
    guard try privateRegularFileInformation(url) != nil else { return false }
    guard unlink(url.path) == 0 else {
      throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_UNSAFE")
    }
    return true
  }

  static func synchronizeDirectory(_ directory: URL) throws {
    let descriptor = open(directory.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
    guard descriptor >= 0 else {
      throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_UNSAFE")
    }
    defer { close(descriptor) }
    guard fsync(descriptor) == 0 else {
      throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_UNSAFE")
    }
  }
}

enum RuntimeArchivePromotion {
  static func recoverCompletePartial(
    _ partial: URL, archive: URL, manifest: RuntimeBootstrapManifest
  ) throws -> Bool {
    var information = stat()
    guard lstat(partial.path, &information) == 0 else {
      if errno == ENOENT { return false }
      throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_UNSAFE")
    }
    guard information.st_mode & S_IFMT == S_IFREG, information.st_uid == getuid(),
      information.st_nlink == 1, information.st_mode & 0o077 == 0,
      information.st_size >= 0, information.st_size <= manifest.archiveBytes
    else { throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_UNSAFE") }
    guard information.st_size == manifest.archiveBytes else { return false }
    let valid =
      try RuntimeDigest.file(partial, expectedBytes: manifest.archiveBytes)
      == manifest.archiveSha256
    guard valid else {
      try RuntimeDownloadResumeState.discard(partial: partial)
      return false
    }
    try promote(partial, archive: archive, manifest: manifest)
    return true
  }

  static func promote(
    _ partial: URL, archive: URL, manifest: RuntimeBootstrapManifest
  ) throws {
    if RuntimeFileSecurity.exclusiveRename(partial, to: archive) {
      try RuntimeDownloadResumeState.synchronizeDirectory(archive.deletingLastPathComponent())
      try RuntimeDownloadResumeState.discardSidecar(for: partial)
      return
    }
    guard errno == EEXIST,
      (try? RuntimeDigest.file(archive, expectedBytes: manifest.archiveBytes))
        == manifest.archiveSha256
    else { throw RuntimeBootstrapFailure.code("RUNTIME_ACTIVATION_FAILED") }
    var partialInformation = stat()
    guard lstat(partial.path, &partialInformation) == 0,
      partialInformation.st_mode & S_IFMT == S_IFREG,
      partialInformation.st_uid == getuid(), partialInformation.st_nlink == 1,
      unlink(partial.path) == 0
    else { throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_UNSAFE") }
    try RuntimeDownloadResumeState.synchronizeDirectory(archive.deletingLastPathComponent())
    try RuntimeDownloadResumeState.discardSidecar(for: partial)
  }
}

enum RuntimeInstallationResolver {
  static func runtimeRoot(resources: URL, support: URL = LocalPaths.support) -> URL? {
    let manifestFile = resources.appendingPathComponent("runtime-bootstrap.json")
    if FileManager.default.fileExists(atPath: manifestFile.path) {
      guard let loaded = try? RuntimeBootstrapDocument.load(resources: resources),
        let active = activeDocument(support: support), active.matches(loaded.document.runtime)
      else { return nil }
      let release = support.appendingPathComponent("runtime/\(active.releasePath)")
      guard safeReleaseDirectory(release, support: support) else { return nil }
      let payload = release.appendingPathComponent("runtime", isDirectory: true)
      guard safeReleaseDirectory(payload, support: support), criticalFilesReady(payload) else {
        return nil
      }
      return payload
    }
    let bundled = resources.appendingPathComponent("runtime", isDirectory: true)
    #if MUSICMUTE_NATIVE_TESTS
      return FileManager.default.isExecutableFile(
        atPath: bundled.appendingPathComponent("runtime/node/bin/node").path)
        ? bundled : nil
    #else
      return criticalFilesReady(bundled) ? bundled : nil
    #endif
  }

  static func activeDocument(support: URL) -> RuntimeActiveDocument? {
    let file = support.appendingPathComponent("runtime/active.json")
    guard let data = try? RuntimeFileSecurity.readPrivateFile(file, maximumBytes: 16 * 1024),
      let document = try? JSONDecoder().decode(RuntimeActiveDocument.self, from: data),
      document.structurallySafe
    else { return nil }
    return document
  }

  static func safeReleaseDirectory(_ url: URL, support: URL) -> Bool {
    let support = support.standardizedFileURL
    let runtime = support.appendingPathComponent("runtime", isDirectory: true).standardizedFileURL
    let releases = runtime.appendingPathComponent("releases", isDirectory: true).standardizedFileURL
    let candidate = url.standardizedFileURL
    guard candidate.path.hasPrefix(releases.path + "/") else { return false }

    let suffix = candidate.path.dropFirst(releases.path.count + 1)
    let components = suffix.split(separator: "/", omittingEmptySubsequences: false)
    guard !components.isEmpty,
      components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." })
    else { return false }

    var directories = [support, runtime, releases]
    var current = releases
    for component in components {
      current.appendPathComponent(String(component), isDirectory: true)
      directories.append(current)
    }
    for directory in directories {
      var information = stat()
      guard lstat(directory.path, &information) == 0,
        information.st_mode & S_IFMT == S_IFDIR,
        information.st_uid == getuid(), information.st_mode & 0o022 == 0
      else { return false }
    }
    guard let canonicalSupport = RuntimePath.canonicalExisting(support),
      let canonicalReleases = RuntimePath.canonicalExisting(releases),
      let canonicalCandidate = RuntimePath.canonicalExisting(candidate),
      canonicalReleases == canonicalSupport + "/runtime/releases"
    else { return false }
    return canonicalCandidate.hasPrefix(canonicalReleases + "/")
  }

  static func criticalFilesReady(_ runtime: URL) -> Bool {
    [
      "runtime/node/bin/node", "runtime/python/bin/python3", "runtime/bin/ffmpeg",
      "runtime/bin/ffprobe", "tools/youtube/bin/deno",
    ].allSatisfy {
      FileManager.default.isExecutableFile(atPath: runtime.appendingPathComponent($0).path)
    }
  }
}

private struct RuntimeFileIdentity: Codable, Hashable, Sendable {
  let device: UInt64
  let inode: UInt64
  let mode: UInt32
  let owner: UInt32
  let linkCount: UInt64
  let size: Int64
  let modifiedSeconds: Int64
  let modifiedNanoseconds: Int64
  let changedSeconds: Int64
  let changedNanoseconds: Int64

  static func load(_ url: URL) throws -> Self {
    var information = stat()
    guard lstat(url.path, &information) == 0 else {
      throw RuntimeBootstrapFailure.code("RUNTIME_ACTIVE_INVALID")
    }
    return Self(
      device: UInt64(information.st_dev), inode: UInt64(information.st_ino),
      mode: UInt32(information.st_mode), owner: information.st_uid,
      linkCount: UInt64(information.st_nlink), size: information.st_size,
      modifiedSeconds: Int64(information.st_mtimespec.tv_sec),
      modifiedNanoseconds: Int64(information.st_mtimespec.tv_nsec),
      changedSeconds: Int64(information.st_ctimespec.tv_sec),
      changedNanoseconds: Int64(information.st_ctimespec.tv_nsec))
  }
}

enum RuntimeInventoryMetadataFingerprint {
  static func compute(
    release: URL, manifest: RuntimeBootstrapManifest,
    entryObserved: ((String) throws -> Void)? = nil
  ) throws -> String {
    var digest = SHA256()
    let releasePath = release.path
    try appendEntry(
      path: ".", declaredType: "directory", filesystemPath: releasePath, digest: &digest)
    try entryObserved?(".")

    let directoryPaths = derivedDirectories(manifest.files)
    let weightedDirectories: [(path: String, depth: Int)] = directoryPaths.map { path in
      let depth = path.utf8.reduce(1) { count, byte in byte == 0x2f ? count + 1 : count }
      return (path: path, depth: depth)
    }
    let directories = weightedDirectories.sorted { first, second in
      first.depth == second.depth ? first.path < second.path : first.depth < second.depth
    }
    for directory in directories {
      let path = directory.path
      let filesystemPath = releasePath + "/" + path
      var information = stat()
      guard lstat(filesystemPath, &information) == 0,
        information.st_mode & S_IFMT == S_IFDIR
      else {
        throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID")
      }
      try appendEntry(
        path: path, declaredType: "directory", filesystemPath: filesystemPath,
        digest: &digest)
      try entryObserved?(path)
    }
    for entry in manifest.files.sorted(by: { $0.path < $1.path }) {
      try appendEntry(
        path: entry.path, declaredType: entry.type,
        declaredLinkTarget: entry.linkTarget,
        filesystemPath: releasePath + "/" + entry.path, digest: &digest)
      try entryObserved?(entry.path)
    }
    return digest.finalize().map { String(format: "%02x", $0) }.joined()
  }

  static func derivedDirectories(_ files: [RuntimeFileManifest]) -> Set<String> {
    var directories = Set<String>()
    for file in files {
      var components = file.path.split(separator: "/").map(String.init)
      components.removeLast()
      while !components.isEmpty {
        directories.insert(components.joined(separator: "/"))
        components.removeLast()
      }
    }
    return directories
  }

  private static func appendEntry(
    path: String, declaredType: String, declaredLinkTarget: String? = nil,
    filesystemPath: String,
    digest: inout SHA256
  ) throws {
    var information = stat()
    guard lstat(filesystemPath, &information) == 0 else {
      throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID")
    }
    let actualType: String
    switch information.st_mode & S_IFMT {
    case S_IFDIR: actualType = "directory"
    case S_IFREG: actualType = "file"
    case S_IFLNK: actualType = "symlink"
    default: actualType = "other"
    }
    let actualLinkTarget: String
    if actualType == "symlink" {
      var bytes = [UInt8](repeating: 0, count: 4097)
      let count = bytes.withUnsafeMutableBytes { buffer in
        readlink(filesystemPath, buffer.baseAddress, buffer.count - 1)
      }
      guard count >= 0, count <= 4096,
        let target = String(bytes: bytes.prefix(count), encoding: .utf8)
      else { throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID") }
      actualLinkTarget = target
    } else {
      actualLinkTarget = ""
    }
    for field in [
      path, declaredType, declaredLinkTarget ?? "", actualType,
      String(UInt64(information.st_dev)), String(UInt64(information.st_ino)),
      String(UInt32(information.st_mode)), String(information.st_uid),
      String(UInt64(information.st_nlink)), String(information.st_size),
      String(Int64(information.st_mtimespec.tv_sec)),
      String(Int64(information.st_mtimespec.tv_nsec)),
      String(Int64(information.st_ctimespec.tv_sec)),
      String(Int64(information.st_ctimespec.tv_nsec)), actualLinkTarget,
    ] {
      append(field, digest: &digest)
    }
  }

  private static func append(_ value: String, digest: inout SHA256) {
    let bytes = Data(value.utf8)
    var count = UInt64(bytes.count).bigEndian
    withUnsafeBytes(of: &count) { digest.update(data: Data($0)) }
    digest.update(data: bytes)
  }
}

protocol RuntimeInventoryMetadataFingerprinting: Sendable {
  func compute(release: URL, manifest: RuntimeBootstrapManifest) throws -> String
}

struct SystemRuntimeInventoryMetadataFingerprinter: RuntimeInventoryMetadataFingerprinting {
  func compute(release: URL, manifest: RuntimeBootstrapManifest) throws -> String {
    try RuntimeInventoryMetadataFingerprint.compute(release: release, manifest: manifest)
  }
}

private struct RuntimeVerificationKey: Hashable, Sendable {
  let resourcesPath: String
  let supportPath: String
  let signaturePolicyIdentifier: String
  let signingMode: String
  let signingTeamID: String?
  let manifestDigest: String
  let activeDigest: String
  let activeIdentity: RuntimeFileIdentity
  let runtimeID: String
  let archiveSha256: String
  let releasePath: String
  let releaseIdentity: RuntimeFileIdentity
  let payloadPath: String
  let payloadIdentity: RuntimeFileIdentity
  let inventoryMetadataDigest: String
}

struct RuntimeVerificationApplicationIdentity: Codable, Equatable, Sendable {
  let bundleIdentifier: String
  let bundleVersion: String
  let codeDirectoryHash: String

  enum CodingKeys: String, CodingKey {
    case bundleIdentifier = "bundle_identifier"
    case bundleVersion = "bundle_version"
    case codeDirectoryHash = "code_directory_hash"
  }

  var structurallySafe: Bool {
    !bundleIdentifier.isEmpty && bundleIdentifier.utf8.count <= 255
      && !bundleIdentifier.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 })
      && !bundleVersion.isEmpty && bundleVersion.utf8.count <= 128
      && !bundleVersion.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 })
      && codeDirectoryHash.utf8.count >= 40 && codeDirectoryHash.utf8.count <= 128
      && codeDirectoryHash.range(of: #"\A[0-9a-f]+\z"#, options: .regularExpression) != nil
  }
}

protocol RuntimeVerificationReceiptAuthenticating: Sendable {
  func authenticationCode(for payload: Data) throws -> Data
  func isValidAuthenticationCode(_ code: Data, authenticating payload: Data) throws -> Bool
}

protocol RuntimeVerificationReceiptStoring: Sendable {
  func load(support: URL) throws -> Data?
  func persist(_ data: Data, support: URL) throws
}

struct SystemRuntimeVerificationReceiptAuthenticator: RuntimeVerificationReceiptAuthenticating {
  private static let service = "com.musicmute.local.runtime-verification-receipt"
  private static let account = "runtime-inventory-hmac-v1"
  private static let keyBytes = 32

  static func noninteractiveContext() -> LAContext {
    let context = LAContext()
    context.interactionNotAllowed = true
    return context
  }

  func authenticationCode(for payload: Data) throws -> Data {
    let key = try key(createIfMissing: true)
    return Data(HMAC<SHA256>.authenticationCode(for: payload, using: SymmetricKey(data: key)))
  }

  func isValidAuthenticationCode(_ code: Data, authenticating payload: Data) throws -> Bool {
    guard code.count == SHA256.byteCount else { return false }
    let key = try key(createIfMissing: false)
    return HMAC<SHA256>.isValidAuthenticationCode(
      code, authenticating: payload, using: SymmetricKey(data: key))
  }

  private func key(createIfMissing: Bool) throws -> Data {
    if let existing = try existingKey() { return existing }
    guard createIfMissing else {
      throw RuntimeBootstrapFailure.code("RUNTIME_RECEIPT_UNAVAILABLE")
    }
    var bytes = [UInt8](repeating: 0, count: Self.keyBytes)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
      throw RuntimeBootstrapFailure.code("RUNTIME_RECEIPT_UNAVAILABLE")
    }
    let generated = Data(bytes)
    let status = SecItemAdd(
      [
        // Receipt caching is optional and must never open an authentication dialog.
        kSecUseAuthenticationContext: Self.noninteractiveContext(),
        // The legacy file Keychain can prompt to create a default Keychain even
        // with a noninteractive LAContext. Use the data protection Keychain;
        // unavailable access simply disables this optional verification cache.
        kSecUseDataProtectionKeychain: true,
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: Self.service,
        kSecAttrAccount: Self.account,
        kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        kSecAttrSynchronizable: kCFBooleanFalse as Any,
        kSecValueData: generated,
      ] as CFDictionary, nil)
    if status == errSecSuccess { return generated }
    if status == errSecDuplicateItem, let raced = try existingKey() { return raced }
    throw RuntimeBootstrapFailure.code("RUNTIME_RECEIPT_UNAVAILABLE")
  }

  private func existingKey() throws -> Data? {
    var result: CFTypeRef?
    let status = SecItemCopyMatching(
      [
        // Receipt caching is optional and must never open an authentication dialog.
        kSecUseAuthenticationContext: Self.noninteractiveContext(),
        kSecUseDataProtectionKeychain: true,
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: Self.service,
        kSecAttrAccount: Self.account,
        kSecAttrSynchronizable: kCFBooleanFalse as Any,
        kSecMatchLimit: kSecMatchLimitOne,
        kSecReturnData: true,
      ] as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data, data.count == Self.keyBytes else {
      throw RuntimeBootstrapFailure.code("RUNTIME_RECEIPT_UNAVAILABLE")
    }
    return data
  }
}

struct FileRuntimeVerificationReceiptStore: RuntimeVerificationReceiptStoring {
  static let maximumBytes: Int64 = 64 * 1024
  static let filename = "verification-receipt-v1.json"

  func load(support: URL) throws -> Data? {
    let file = receiptFile(support: support)
    var information = stat()
    guard lstat(file.path, &information) == 0 else {
      if errno == ENOENT { return nil }
      throw RuntimeBootstrapFailure.code("RUNTIME_RECEIPT_INVALID")
    }
    return try RuntimeFileSecurity.readRegularFile(
      file, maximumBytes: Self.maximumBytes, requireCurrentOwner: true,
      privatePermissions: true, code: "RUNTIME_RECEIPT_INVALID")
  }

  func persist(_ data: Data, support: URL) throws {
    guard !data.isEmpty, data.count <= Self.maximumBytes else {
      throw RuntimeBootstrapFailure.code("RUNTIME_RECEIPT_INVALID")
    }
    try RuntimeFileSecurity.atomicWrite(data, to: receiptFile(support: support))
  }

  private func receiptFile(support: URL) -> URL {
    support.appendingPathComponent("runtime/\(Self.filename)")
  }
}

private struct RuntimeVerificationReceiptPayload: Codable, Equatable, Sendable {
  let schemaVersion: Int
  let application: RuntimeVerificationApplicationIdentity
  let resourcesPath: String
  let supportPath: String
  let signaturePolicyIdentifier: String
  let signingMode: String
  let signingTeamID: String?
  let manifestDigest: String
  let activeDigest: String
  let activeIdentity: RuntimeFileIdentity
  let runtimeID: String
  let archiveSha256: String
  let releasePath: String
  let releaseIdentity: RuntimeFileIdentity
  let payloadPath: String
  let payloadIdentity: RuntimeFileIdentity
  let inventoryMetadataDigest: String

  enum CodingKeys: String, CodingKey {
    case schemaVersion = "schema_version"
    case application
    case resourcesPath = "resources_path"
    case supportPath = "support_path"
    case signaturePolicyIdentifier = "signature_policy_identifier"
    case signingMode = "signing_mode"
    case signingTeamID = "signing_team_id"
    case manifestDigest = "manifest_digest"
    case activeDigest = "active_digest"
    case activeIdentity = "active_identity"
    case runtimeID = "runtime_id"
    case archiveSha256 = "archive_sha256"
    case releasePath = "release_path"
    case releaseIdentity = "release_identity"
    case payloadPath = "payload_path"
    case payloadIdentity = "payload_identity"
    case inventoryMetadataDigest = "inventory_metadata_digest"
  }

  init(key: RuntimeVerificationKey, application: RuntimeVerificationApplicationIdentity) {
    schemaVersion = 1
    self.application = application
    resourcesPath = key.resourcesPath
    supportPath = key.supportPath
    signaturePolicyIdentifier = key.signaturePolicyIdentifier
    signingMode = key.signingMode
    signingTeamID = key.signingTeamID
    manifestDigest = key.manifestDigest
    activeDigest = key.activeDigest
    activeIdentity = key.activeIdentity
    runtimeID = key.runtimeID
    archiveSha256 = key.archiveSha256
    releasePath = key.releasePath
    releaseIdentity = key.releaseIdentity
    payloadPath = key.payloadPath
    payloadIdentity = key.payloadIdentity
    inventoryMetadataDigest = key.inventoryMetadataDigest
  }

  var structurallySafe: Bool {
    schemaVersion == 1 && application.structurallySafe
      && !resourcesPath.isEmpty && resourcesPath.utf8.count <= 4096
      && !supportPath.isEmpty && supportPath.utf8.count <= 4096
      && !signaturePolicyIdentifier.isEmpty && signaturePolicyIdentifier.utf8.count <= 255
      && ((signingMode == "developer_id"
        && signingTeamID?.range(
          of: #"\A[A-Z0-9]{10}\z"#, options: .regularExpression) != nil)
        || (signingMode == "ad_hoc" && signingTeamID == nil))
      && RuntimeDigest.valid(manifestDigest) && RuntimeDigest.valid(activeDigest)
      && RuntimePath.safeIdentifier(runtimeID) && RuntimeDigest.valid(archiveSha256)
      && !releasePath.isEmpty && releasePath.utf8.count <= 4096
      && !payloadPath.isEmpty && payloadPath.utf8.count <= 4096
      && RuntimeDigest.valid(inventoryMetadataDigest)
  }
}

private struct RuntimeVerificationReceiptEnvelope: Codable, Sendable {
  let schemaVersion: Int
  let payload: Data
  let authenticationCode: Data

  enum CodingKeys: String, CodingKey {
    case schemaVersion = "schema_version"
    case payload
    case authenticationCode = "authentication_code"
  }
}

private enum RuntimeVerificationReceipt {
  static let maximumPayloadBytes = 48 * 1024

  static func encode(
    key: RuntimeVerificationKey, application: RuntimeVerificationApplicationIdentity,
    authenticator: any RuntimeVerificationReceiptAuthenticating
  ) throws -> Data {
    let payload = RuntimeVerificationReceiptPayload(key: key, application: application)
    guard payload.structurallySafe else {
      throw RuntimeBootstrapFailure.code("RUNTIME_RECEIPT_INVALID")
    }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let payloadData = try encoder.encode(payload)
    guard !payloadData.isEmpty, payloadData.count <= maximumPayloadBytes else {
      throw RuntimeBootstrapFailure.code("RUNTIME_RECEIPT_INVALID")
    }
    let authenticationCode = try authenticator.authenticationCode(for: payloadData)
    guard authenticationCode.count == SHA256.byteCount else {
      throw RuntimeBootstrapFailure.code("RUNTIME_RECEIPT_INVALID")
    }
    var data = try encoder.encode(
      RuntimeVerificationReceiptEnvelope(
        schemaVersion: 1, payload: payloadData, authenticationCode: authenticationCode))
    data.append(10)
    return data
  }

  static func matches(
    _ data: Data, key: RuntimeVerificationKey,
    application: RuntimeVerificationApplicationIdentity,
    authenticator: any RuntimeVerificationReceiptAuthenticating
  ) throws -> Bool {
    guard !data.isEmpty, data.count <= Int(FileRuntimeVerificationReceiptStore.maximumBytes),
      let envelope = try? JSONDecoder().decode(RuntimeVerificationReceiptEnvelope.self, from: data),
      envelope.schemaVersion == 1, !envelope.payload.isEmpty,
      envelope.payload.count <= maximumPayloadBytes,
      envelope.authenticationCode.count == SHA256.byteCount,
      try authenticator.isValidAuthenticationCode(
        envelope.authenticationCode, authenticating: envelope.payload)
    else { return false }
    guard
      let payload = try? JSONDecoder().decode(
        RuntimeVerificationReceiptPayload.self, from: envelope.payload),
      payload.structurallySafe
    else { return false }
    return payload == RuntimeVerificationReceiptPayload(key: key, application: application)
  }
}

private struct RuntimeVerificationCandidate: Sendable {
  let key: RuntimeVerificationKey
  let release: URL
  let runtimeRoot: URL
  let resources: URL
  let manifest: RuntimeBootstrapManifest
}

private enum RuntimeExecutionResolution: Sendable {
  case missing
  case bundled(URL)
  case installed(RuntimeVerificationCandidate)
}

/// Shared side of the app-update gate. This is acquired before the signed app is read and retained
/// until the verified child terminates, so Sparkle cannot replace resources between verification
/// and Python/JavaScript startup.
private final class RuntimeUpdateExecutionLease: @unchecked Sendable {
  private let descriptor: Int32

  private static func failure(
    _ stage: String, error: Int32? = nil, descriptor: stat? = nil, named: stat? = nil,
    canonicalMatches: Bool? = nil, detail: String? = nil
  ) -> RuntimeBootstrapFailure {
    #if MUSICMUTE_NATIVE_TESTS
      func summary(_ value: stat?) -> String {
        guard let value else { return "none" }
        return [
          "dev=\(UInt64(value.st_dev))", "ino=\(UInt64(value.st_ino))",
          "mode=\(String(UInt32(value.st_mode), radix: 8))", "uid=\(value.st_uid)",
          "nlink=\(UInt64(value.st_nlink))",
          "type=\(UInt32(value.st_mode) & UInt32(S_IFMT))",
        ].joined(separator: ",")
      }
      let line =
        "Runtime update execution lease diagnostic stage=\(stage) errno=\(error.map(String.init) ?? "none") descriptor={\(summary(descriptor))} named={\(summary(named))} canonical_matches=\(canonicalMatches.map(String.init) ?? "none") detail=\(detail ?? "none")\n"
      try? FileHandle.standardError.write(contentsOf: Data(line.utf8))
    #endif
    return RuntimeBootstrapFailure.code("UPDATE_LOCK_UNSAFE")
  }

  init(support: URL) throws {
    let supportPath = try Self.canonicalPathForCreation(support)
    let root = RuntimePOSIXCall.retryingInteger {
      open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
    }
    var directory = root.value
    guard root.succeeded else {
      throw Self.failure("root-open", error: root.error)
    }
    defer { close(directory) }

    for component in supportPath.split(separator: "/") {
      let name = String(component)
      var opened = RuntimePOSIXCall.retryingInteger {
        openat(directory, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
      }
      if !opened.succeeded && opened.error == ENOENT {
        let created = RuntimePOSIXCall.retryingInteger { mkdirat(directory, name, 0o700) }
        guard created.succeeded || created.error == EEXIST else {
          throw Self.failure("support-mkdir", error: created.error)
        }
        opened = RuntimePOSIXCall.retryingInteger {
          openat(directory, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        }
      }
      guard opened.succeeded else {
        throw Self.failure("support-open", error: opened.error)
      }
      let child = opened.value
      var information = stat()
      let inspected = RuntimePOSIXCall.retryingInteger { fstat(child, &information) }
      guard inspected.succeeded,
        information.st_uid == 0 || information.st_uid == getuid()
      else {
        close(child)
        throw Self.failure("support-fstat", error: inspected.error, descriptor: information)
      }
      close(directory)
      directory = child
    }

    var supportInformation = stat()
    let inspectedSupport = RuntimePOSIXCall.retryingInteger {
      fstat(directory, &supportInformation)
    }
    let canonicalMatches = RuntimePath.canonicalExisting(support) == supportPath
    guard inspectedSupport.succeeded,
      supportInformation.st_mode & S_IFMT == S_IFDIR,
      supportInformation.st_uid == getuid(), supportInformation.st_mode & 0o777 == 0o700,
      canonicalMatches
    else {
      throw Self.failure(
        "support-invariants", error: inspectedSupport.error, descriptor: supportInformation,
        canonicalMatches: canonicalMatches)
    }

    let openedFile = RuntimeUpdateLockFile.open(in: directory)
    guard openedFile.succeeded else {
      var parentAfterFailure = stat()
      var namedAfterFailure = stat()
      let parentProbe = RuntimePOSIXCall.retryingInteger {
        fstat(directory, &parentAfterFailure)
      }
      let nameProbe = RuntimePOSIXCall.retryingInteger {
        fstatat(directory, "update.lock", &namedAfterFailure, AT_SYMLINK_NOFOLLOW)
      }
      throw Self.failure(
        "lock-open", error: openedFile.error, descriptor: parentAfterFailure,
        named: nameProbe.succeeded ? namedAfterFailure : nil,
        canonicalMatches: RuntimePath.canonicalExisting(support) == supportPath,
        detail:
          "parent_probe_errno=\(parentProbe.error.map(String.init) ?? "none"),name_probe_errno=\(nameProbe.error.map(String.init) ?? "none")"
      )
    }
    let file = openedFile.value
    var information = stat()
    var named = stat()
    let inspectedFile = RuntimePOSIXCall.retryingInteger { fstat(file, &information) }
    let inspectedName = RuntimePOSIXCall.retryingInteger {
      fstatat(directory, "update.lock", &named, AT_SYMLINK_NOFOLLOW)
    }
    guard inspectedFile.succeeded, inspectedName.succeeded,
      information.st_mode & S_IFMT == S_IFREG,
      information.st_uid == getuid(), information.st_nlink == 1,
      information.st_mode & 0o777 == 0o600,
      named.st_mode & S_IFMT == S_IFREG,
      information.st_dev == named.st_dev, information.st_ino == named.st_ino
    else {
      close(file)
      throw Self.failure(
        "lock-invariants-before-flock", error: inspectedFile.error ?? inspectedName.error,
        descriptor: information, named: named)
    }
    let locked = RuntimePOSIXCall.retryingInteger { flock(file, LOCK_SH | LOCK_NB) }
    guard locked.succeeded else {
      let code =
        RuntimePOSIXCall.wouldBlock(locked.error)
        ? "UPDATE_INSTALLING" : "UPDATE_LOCK_UNSAFE"
      close(file)
      if code == "UPDATE_LOCK_UNSAFE" {
        throw Self.failure(
          "lock-flock", error: locked.error, descriptor: information, named: named)
      }
      throw RuntimeBootstrapFailure.code(code)
    }
    var namedAfterLock = stat()
    let inspectedNameAfterLock = RuntimePOSIXCall.retryingInteger {
      fstatat(directory, "update.lock", &namedAfterLock, AT_SYMLINK_NOFOLLOW)
    }
    guard inspectedNameAfterLock.succeeded,
      namedAfterLock.st_mode & S_IFMT == S_IFREG,
      information.st_dev == namedAfterLock.st_dev,
      information.st_ino == namedAfterLock.st_ino
    else {
      _ = RuntimePOSIXCall.retryingInteger { flock(file, LOCK_UN) }
      close(file)
      throw Self.failure(
        "lock-invariants-after-flock", error: inspectedNameAfterLock.error,
        descriptor: information, named: namedAfterLock)
    }
    descriptor = file
  }

  func preserveAcrossExec() throws {
    let flags = RuntimePOSIXCall.retryingInteger { fcntl(descriptor, F_GETFD) }
    guard flags.succeeded else {
      throw Self.failure("lock-fcntl-get", error: flags.error)
    }
    let preserved = RuntimePOSIXCall.retryingInteger {
      fcntl(descriptor, F_SETFD, flags.value & ~FD_CLOEXEC)
    }
    guard preserved.succeeded else {
      throw Self.failure("lock-fcntl-set", error: preserved.error)
    }
  }

  deinit {
    _ = RuntimePOSIXCall.retryingInteger { flock(descriptor, LOCK_UN) }
    close(descriptor)
  }

  private static func canonicalPathForCreation(_ support: URL) throws -> String {
    let standardized = support.standardizedFileURL
    guard standardized.path.hasPrefix("/"), standardized.path != "/",
      !standardized.path.contains("\0")
    else { throw Self.failure("canonical-input") }

    var existing = standardized
    var missing = [String]()
    var canonical = RuntimePath.canonicalExisting(existing)
    while canonical == nil {
      guard existing.path != "/" else {
        throw Self.failure("canonical-root")
      }
      let component = existing.lastPathComponent
      guard !component.isEmpty, component != ".", component != ".." else {
        throw Self.failure("canonical-component")
      }
      missing.append(component)
      existing.deleteLastPathComponent()
      canonical = RuntimePath.canonicalExisting(existing)
    }
    guard let canonical else { throw Self.failure("canonical-realpath") }
    var result = URL(fileURLWithPath: canonical, isDirectory: true)
    for component in missing.reversed() {
      result.appendPathComponent(component, isDirectory: true)
    }
    // `standardizedFileURL` rewrites macOS's canonical `/private/var` back to the `/var`
    // symlink. Keep the realpath-derived spelling so the descriptor walk can reject symlinks.
    return result.path
  }
}

#if MUSICMUTE_NATIVE_TESTS
  final class RuntimeUpdateExecutionTestLease: @unchecked Sendable {
    private let lease: RuntimeUpdateExecutionLease

    init(support: URL) throws {
      lease = try RuntimeUpdateExecutionLease(support: support)
    }
  }
#endif

/// An installed runtime execution lease. Contents are trusted after Prepare during normal use;
/// explicit verification also returns this lease. Retaining it pins an installed release against
/// cooperative Prepare/prune and app-update operations; native exec explicitly inherits the
/// underlying leases.
final class RuntimeVerifiedRuntime: @unchecked Sendable {
  let runtimeRoot: URL
  private let setupLease: RuntimeFileLock?
  private let updateLease: RuntimeUpdateExecutionLease?

  fileprivate init(
    runtimeRoot: URL, setupLease: RuntimeFileLock?, updateLease: RuntimeUpdateExecutionLease?
  ) {
    self.runtimeRoot = runtimeRoot
    self.setupLease = setupLease
    self.updateLease = updateLease
  }

  fileprivate func preserveLeaseAcrossExec() throws {
    try setupLease?.preserveAcrossExec()
    try updateLease?.preserveAcrossExec()
  }
}

private struct AcquiredRuntimeExecutionLease: Sendable {
  let fileLock: RuntimeFileLock
  let supportPath: String
}

/// Resolves a metadata-only exact identity for the active release separately from its complete
/// content/signature verification. The shared coordinator below caches only within this process.
struct RuntimeExecutionGate: Sendable {
  let support: URL
  let signatureChecker: any RuntimeSignatureChecking
  let metadataFingerprinter: any RuntimeInventoryMetadataFingerprinting

  init(
    support: URL = LocalPaths.support,
    signatureChecker: any RuntimeSignatureChecking = SystemRuntimeSignatureChecker(),
    metadataFingerprinter: any RuntimeInventoryMetadataFingerprinting =
      SystemRuntimeInventoryMetadataFingerprinter()
  ) {
    self.support = support
    self.signatureChecker = signatureChecker
    self.metadataFingerprinter = metadataFingerprinter
  }

  fileprivate func resolution(
    resources: URL,
    preloadedManifest: (document: RuntimeBootstrapDocument, digest: String)? = nil
  ) throws -> RuntimeExecutionResolution {
    let manifestFile = resources.appendingPathComponent("runtime-bootstrap.json")
    guard FileManager.default.fileExists(atPath: manifestFile.path) else {
      // Pre-bootstrap packaged apps keep their immutable runtime inside the signed bundle. This
      // compatibility path is also used by isolated native fixtures.
      return RuntimeInstallationResolver.runtimeRoot(resources: resources, support: support).map {
        .bundled($0)
      } ?? .missing
    }

    let loaded = try preloadedManifest ?? RuntimeBootstrapDocument.load(resources: resources)
    let activeFile = support.appendingPathComponent("runtime/active.json")
    var activeInformation = stat()
    guard lstat(activeFile.path, &activeInformation) == 0 else {
      if errno == ENOENT { return .missing }
      throw RuntimeBootstrapFailure.code("RUNTIME_ACTIVE_INVALID")
    }
    let activeData = try RuntimeFileSecurity.readPrivateFile(
      activeFile, maximumBytes: 16 * 1024)
    guard let active = try? JSONDecoder().decode(RuntimeActiveDocument.self, from: activeData),
      active.structurallySafe
    else { throw RuntimeBootstrapFailure.code("RUNTIME_ACTIVE_INVALID") }
    guard active.matches(loaded.document.runtime) else {
      throw RuntimeBootstrapFailure.code("APP_RUNTIME_INCOMPATIBLE")
    }

    let release = support.appendingPathComponent("runtime/\(active.releasePath)")
    guard RuntimeInstallationResolver.safeReleaseDirectory(release, support: support) else {
      throw RuntimeBootstrapFailure.code("RUNTIME_ACTIVE_INVALID")
    }
    let runtimeRoot = release.appendingPathComponent("runtime", isDirectory: true)
    guard let resourcesPath = RuntimePath.canonicalExisting(resources),
      let supportPath = RuntimePath.canonicalExisting(support),
      let releasePath = RuntimePath.canonicalExisting(release)
    else { throw RuntimeBootstrapFailure.code("RUNTIME_ACTIVE_INVALID") }
    let canonicalResources = URL(fileURLWithPath: resourcesPath, isDirectory: true)
    let canonicalRelease = URL(fileURLWithPath: releasePath, isDirectory: true)
    let canonicalRuntimeRoot = canonicalRelease.appendingPathComponent("runtime", isDirectory: true)
    return .installed(
      RuntimeVerificationCandidate(
        key: RuntimeVerificationKey(
          resourcesPath: resourcesPath, supportPath: supportPath,
          signaturePolicyIdentifier: signatureChecker.verificationPolicyIdentifier,
          signingMode: loaded.document.runtime.signing.mode,
          signingTeamID: loaded.document.runtime.signing.teamID,
          manifestDigest: loaded.digest, activeDigest: RuntimeDigest.data(activeData),
          activeIdentity: try RuntimeFileIdentity.load(activeFile),
          runtimeID: loaded.document.runtime.id,
          archiveSha256: loaded.document.runtime.archiveSha256,
          releasePath: releasePath,
          releaseIdentity: try RuntimeFileIdentity.load(release),
          payloadPath: canonicalRuntimeRoot.path,
          payloadIdentity: try RuntimeFileIdentity.load(runtimeRoot),
          inventoryMetadataDigest: try metadataFingerprinter.compute(
            release: release, manifest: loaded.document.runtime)),
        release: canonicalRelease, runtimeRoot: canonicalRuntimeRoot,
        resources: canonicalResources,
        manifest: loaded.document.runtime))
  }

  fileprivate func verify(_ candidate: RuntimeVerificationCandidate) throws -> URL {
    try RuntimeInventoryVerifier(signatureChecker: signatureChecker).verify(
      release: candidate.release, resources: candidate.resources, manifest: candidate.manifest)
    guard case .installed(let current) = try resolution(resources: candidate.resources),
      current.key == candidate.key
    else { throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID") }
    return candidate.runtimeRoot
  }
}

/// A full verification establishes the authenticated receipt for an exact app/runtime identity.
/// Later app or native-host processes may use that receipt only after validating the outer app and
/// obtaining two identical metadata fingerprints; a missing or invalid receipt falls back to full
/// verification. Concurrent starts are joined, and returned runtimes retain a shared bootstrap
/// lease that excludes Prepare/pruning.
final class RuntimeVerificationCoordinator: @unchecked Sendable {
  static let shared = RuntimeVerificationCoordinator()

  private enum State {
    case verifying
    case verified
  }

  private let condition = NSCondition()
  private let receiptAuthenticator: any RuntimeVerificationReceiptAuthenticating
  private let receiptStore: any RuntimeVerificationReceiptStoring
  private let metadataFingerprinter: any RuntimeInventoryMetadataFingerprinting
  private var states = [RuntimeVerificationKey: State]()
  private var fullVerificationRuns = 0

  init(
    receiptAuthenticator: any RuntimeVerificationReceiptAuthenticating =
      SystemRuntimeVerificationReceiptAuthenticator(),
    receiptStore: any RuntimeVerificationReceiptStoring = FileRuntimeVerificationReceiptStore(),
    metadataFingerprinter: any RuntimeInventoryMetadataFingerprinting =
      SystemRuntimeInventoryMetadataFingerprinter()
  ) {
    self.receiptAuthenticator = receiptAuthenticator
    self.receiptStore = receiptStore
    self.metadataFingerprinter = metadataFingerprinter
  }

  /// Normal execution trusts installed contents. Only resolve the selected release and retain
  /// its update/setup leases: no inventory walk, signatures, receipt/Keychain or model checks.
  /// Full verification is an explicit setup/diagnostic operation, never a launch fallback.
  func installedRuntime(resources: URL, support: URL = LocalPaths.support) throws
    -> RuntimeVerifiedRuntime?
  {
    let external = FileManager.default.fileExists(
      atPath: resources.appendingPathComponent("runtime-bootstrap.json").path)
    #if MUSICMUTE_NATIVE_TESTS
      let updateLease = external ? try RuntimeUpdateExecutionLease(support: support) : nil
    #else
      let updateLease: RuntimeUpdateExecutionLease? = try RuntimeUpdateExecutionLease(
        support: support)
    #endif
    let setupLease = try executionLease(resources: resources, support: support)
    if !external {
      guard
        let runtime = RuntimeInstallationResolver.runtimeRoot(
          resources: resources, support: support)
      else { return nil }
      return RuntimeVerifiedRuntime(runtimeRoot: runtime, setupLease: nil, updateLease: updateLease)
    }
    let loaded = try RuntimeBootstrapDocument.load(resources: resources)
    let activeFile = support.appendingPathComponent("runtime/active.json")
    guard FileManager.default.fileExists(atPath: activeFile.path) else { return nil }
    let data = try RuntimeFileSecurity.readPrivateFile(activeFile, maximumBytes: 16 * 1024)
    guard let active = try? JSONDecoder().decode(RuntimeActiveDocument.self, from: data),
      active.structurallySafe, let setupLease
    else { throw RuntimeBootstrapFailure.code("RUNTIME_ACTIVE_INVALID") }
    guard active.matches(loaded.document.runtime) else {
      throw RuntimeBootstrapFailure.code("APP_RUNTIME_INCOMPATIBLE")
    }
    let release = support.appendingPathComponent("runtime/\(active.releasePath)")
    let runtime = release.appendingPathComponent("runtime", isDirectory: true)
    guard RuntimeInstallationResolver.safeReleaseDirectory(release, support: support),
      RuntimeInstallationResolver.safeReleaseDirectory(runtime, support: support)
    else { throw RuntimeBootstrapFailure.code("RUNTIME_ACTIVE_INVALID") }
    return RuntimeVerifiedRuntime(
      runtimeRoot: runtime, setupLease: setupLease.fileLock, updateLease: updateLease)
  }

  /// Explicit manual audit always checks contents, even if a previous receipt remains valid.
  func inspectRuntime(
    resources: URL, support: URL = LocalPaths.support,
    signatureChecker: any RuntimeSignatureChecking = SystemRuntimeSignatureChecker()
  ) throws -> RuntimeVerifiedRuntime? {
    guard let installed = try installedRuntime(resources: resources, support: support) else {
      return nil
    }
    let gate = RuntimeExecutionGate(
      support: support, signatureChecker: signatureChecker,
      metadataFingerprinter: metadataFingerprinter)
    if case .installed(let candidate) = try gate.resolution(resources: resources) {
      _ = try gate.verify(candidate)
    }
    return installed
  }

  func verifiedRuntime(
    resources: URL, support: URL = LocalPaths.support,
    signatureChecker: any RuntimeSignatureChecking = SystemRuntimeSignatureChecker()
  ) throws -> RuntimeVerifiedRuntime? {
    // Pin the signed bundle before any manifest or signature read. The updater takes the
    // corresponding exclusive lock before replacing the app.
    #if MUSICMUTE_NATIVE_TESTS
      // Synthetic bundled-runtime fixtures are not app bundles and intentionally use an isolated
      // direct executable. External-runtime fixtures still exercise the production update gate.
      let hasExternalRuntimeManifest = FileManager.default.fileExists(
        atPath: resources.appendingPathComponent("runtime-bootstrap.json").path)
      let updateLease =
        hasExternalRuntimeManifest ? try RuntimeUpdateExecutionLease(support: support) : nil
    #else
      let updateLease: RuntimeUpdateExecutionLease? = try RuntimeUpdateExecutionLease(
        support: support)
      let hasExternalRuntimeManifest = FileManager.default.fileExists(
        atPath: resources.appendingPathComponent("runtime-bootstrap.json").path)
    #endif
    let gate = RuntimeExecutionGate(
      support: support, signatureChecker: signatureChecker,
      metadataFingerprinter: metadataFingerprinter)
    let setupLease = try executionLease(resources: resources, support: support)
    var preloadedManifest: (document: RuntimeBootstrapDocument, digest: String)?
    var storedReceipt: Data?
    var receiptApplication: RuntimeVerificationApplicationIdentity?
    // Receipts authenticate only the external runtime selected by runtime-bootstrap.json.
    // A receipt retained from a thin app must not poison an older bundled-runtime rollback.
    if signatureChecker.supportsDurableVerificationReceipts && hasExternalRuntimeManifest {
      do {
        storedReceipt = try receiptStore.load(support: support)
      } catch {
        // An unavailable, corrupt or unsafe receipt is never authoritative. The complete
        // verifier remains the fallback and may replace the receipt afterward.
        storedReceipt = nil
      }
      if storedReceipt != nil {
        let loaded = try RuntimeBootstrapDocument.load(resources: resources)
        // Validate and identify the currently running app while the update lease is held. The
        // exact inventory scan below then becomes the one final filesystem resolution on a hit.
        try signatureChecker.validateOuterApplication(
          resources: resources, signing: loaded.document.runtime.signing)
        receiptApplication = try? signatureChecker.verificationReceiptApplicationIdentity(
          resources: resources)
        preloadedManifest = loaded
      }
    }
    resolutionLoop: while true {
      switch try gate.resolution(
        resources: resources, preloadedManifest: preloadedManifest)
      {
      case .missing: return nil
      case .bundled(let runtime):
        return RuntimeVerifiedRuntime(
          runtimeRoot: runtime, setupLease: nil, updateLease: updateLease)
      case .installed(let candidate):
        guard let setupLease, setupLease.supportPath == candidate.key.supportPath else {
          throw RuntimeBootstrapFailure.code("RUNTIME_ACTIVE_INVALID")
        }
        condition.lock()
        switch states[candidate.key] {
        case .verified:
          condition.unlock()
          if storedReceipt != nil {
            // Consecutive complete passes detect a persistent in-place mutation made after a leaf
            // was visited by the first pass. This narrows verification TOCTOU to parity with the
            // full verifier; it does not claim to defeat a hostile same-UID writer after checking.
            guard
              case .installed(let current) = try gate.resolution(
                resources: resources, preloadedManifest: preloadedManifest),
              current.key == candidate.key
            else { continue resolutionLoop }
            return RuntimeVerifiedRuntime(
              runtimeRoot: current.runtimeRoot, setupLease: setupLease.fileLock,
              updateLease: updateLease)
          }
          try signatureChecker.validateOuterApplication(
            resources: candidate.resources, signing: candidate.manifest.signing)
          guard case .installed(let current) = try gate.resolution(resources: resources) else {
            throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID")
          }
          if current.key != candidate.key { continue resolutionLoop }
          return RuntimeVerifiedRuntime(
            runtimeRoot: current.runtimeRoot, setupLease: setupLease.fileLock,
            updateLease: updateLease)
        case .verifying:
          condition.wait()
          condition.unlock()
          continue resolutionLoop
        case nil:
          states[candidate.key] = .verifying
          condition.unlock()
          do {
            let receiptMatches =
              storedReceipt.flatMap { receipt in
                receiptApplication.map { application in
                  (try? RuntimeVerificationReceipt.matches(
                    receipt, key: candidate.key, application: application,
                    authenticator: receiptAuthenticator)) == true
                }
              } ?? false
            if receiptMatches {
              guard
                case .installed(let current) = try gate.resolution(
                  resources: resources, preloadedManifest: preloadedManifest),
                current.key == candidate.key
              else {
                condition.lock()
                states.removeValue(forKey: candidate.key)
                condition.broadcast()
                condition.unlock()
                continue resolutionLoop
              }
              condition.lock()
              states[candidate.key] = .verified
              condition.broadcast()
              condition.unlock()
              return RuntimeVerifiedRuntime(
                runtimeRoot: current.runtimeRoot, setupLease: setupLease.fileLock,
                updateLease: updateLease)
            }
            condition.lock()
            fullVerificationRuns += 1
            condition.unlock()
            let runtime = try gate.verify(candidate)
            if signatureChecker.supportsDurableVerificationReceipts {
              if receiptApplication == nil {
                receiptApplication =
                  try? signatureChecker
                  .verificationReceiptApplicationIdentity(resources: candidate.resources)
              }
              if let receiptApplication,
                let receipt = try? RuntimeVerificationReceipt.encode(
                  key: candidate.key, application: receiptApplication,
                  authenticator: receiptAuthenticator)
              {
                // Runtime execution remains safe when Keychain or durable storage is unavailable:
                // the just-completed verifier is authoritative for this process only.
                try? receiptStore.persist(receipt, support: support)
              }
            }
            condition.lock()
            states[candidate.key] = .verified
            condition.broadcast()
            condition.unlock()
            return RuntimeVerifiedRuntime(
              runtimeRoot: runtime, setupLease: setupLease.fileLock,
              updateLease: updateLease)
          } catch let failure as RuntimeBootstrapFailure {
            condition.lock()
            states.removeValue(forKey: candidate.key)
            condition.broadcast()
            condition.unlock()
            throw failure
          } catch {
            let failure = RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID")
            condition.lock()
            states.removeValue(forKey: candidate.key)
            condition.broadcast()
            condition.unlock()
            throw failure
          }
        }
      }
    }
  }

  var verificationRunCount: Int {
    condition.lock()
    defer { condition.unlock() }
    return fullVerificationRuns
  }

  private func executionLease(resources: URL, support: URL) throws
    -> AcquiredRuntimeExecutionLease?
  {
    guard
      FileManager.default.fileExists(
        atPath: resources.appendingPathComponent("runtime-bootstrap.json").path)
    else { return nil }
    guard let supportPath = RuntimePath.canonicalExisting(support) else { return nil }
    let runtimeDirectory = URL(fileURLWithPath: supportPath, isDirectory: true)
      .appendingPathComponent("runtime", isDirectory: true)
    var runtimeInformation = stat()
    guard lstat(runtimeDirectory.path, &runtimeInformation) == 0 else {
      if errno == ENOENT { return nil }
      throw RuntimeBootstrapFailure.code("RUNTIME_ACTIVE_INVALID")
    }
    guard runtimeInformation.st_mode & S_IFMT == S_IFDIR,
      runtimeInformation.st_uid == getuid(), runtimeInformation.st_mode & 0o077 == 0
    else { throw RuntimeBootstrapFailure.code("RUNTIME_ACTIVE_INVALID") }
    let lockFile = runtimeDirectory.appendingPathComponent("bootstrap.lock")
    var lockInformation = stat()
    guard lstat(lockFile.path, &lockInformation) == 0 else {
      if errno == ENOENT { return nil }
      throw RuntimeBootstrapFailure.code("RUNTIME_ACTIVE_INVALID")
    }
    return AcquiredRuntimeExecutionLease(
      fileLock: try RuntimeFileLock(path: lockFile, mode: .shared),
      supportPath: supportPath)
  }
}

struct NativeHostLaunchPlan: Sendable {
  let executable: URL
  let arguments: [String]
  let environment: [String: String]
  // Retain the shared lease; execute makes its descriptor survive the Python -> Node exec chain.
  fileprivate let verifiedRuntime: RuntimeVerifiedRuntime
}

/// Builds and execs the Chrome Native Messaging host only after the complete active runtime has
/// passed the same inventory gate used by GUI companion commands.
enum NativeHostLauncher {
  typealias ReplaceProcess = (NativeHostLaunchPlan) -> Int32

  static func execute(
    arguments: [String], resources: URL, support: URL = LocalPaths.support,
    signatureChecker: any RuntimeSignatureChecking = SystemRuntimeSignatureChecker(),
    coordinator: RuntimeVerificationCoordinator = .shared,
    replace: ReplaceProcess = replaceCurrentProcess
  ) throws -> Int32 {
    let plan = try launchPlan(
      arguments: arguments, resources: resources, support: support,
      signatureChecker: signatureChecker, coordinator: coordinator)
    try plan.verifiedRuntime.preserveLeaseAcrossExec()
    return replace(plan)
  }

  static func launchPlan(
    arguments: [String], resources: URL, support: URL = LocalPaths.support,
    signatureChecker: any RuntimeSignatureChecking = SystemRuntimeSignatureChecker(),
    coordinator: RuntimeVerificationCoordinator = .shared
  ) throws -> NativeHostLaunchPlan {
    let started = ProcessInfo.processInfo.systemUptime
    guard arguments.count == 1, validChromeOrigin(arguments[0]) else {
      throw RuntimeBootstrapFailure.code("APP_CONTROL_INVALID")
    }
    guard
      let verifiedRuntime = try coordinator.installedRuntime(
        resources: resources, support: support)
    else { throw RuntimeBootstrapFailure.code("APP_RUNTIME_NOT_PREPARED") }
    let runtime = verifiedRuntime.runtimeRoot

    let python = runtime.appendingPathComponent("runtime/python/bin/python3")
    let node = runtime.appendingPathComponent("runtime/node/bin/node")
    let wrapper = resources.appendingPathComponent("scripts/native-lock.py")
    let host = resources.appendingPathComponent("companion/host.js")
    guard FileManager.default.isExecutableFile(atPath: python.path),
      FileManager.default.isExecutableFile(atPath: node.path),
      FileManager.default.fileExists(atPath: wrapper.path),
      FileManager.default.fileExists(atPath: host.path)
    else { throw RuntimeBootstrapFailure.code("APP_RESOURCES_INCOMPLETE") }

    return NativeHostLaunchPlan(
      executable: python,
      arguments: ["-I", "-B", "-S", wrapper.path, node.path, host.path, arguments[0]],
      environment: [
        "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
        "PATH": "/usr/bin:/bin",
        "LANG": "en_US.UTF-8",
        "TMPDIR": NSTemporaryDirectory(),
        "MUSICMUTE_LOCAL_APP_RESOURCES": resources.path,
        "MUSICMUTE_LOCAL_ROOT": support.path,
        "MUSICMUTE_LOCAL_LAUNCH_MS": String(
          (ProcessInfo.processInfo.systemUptime - started) * 1000),
      ],
      verifiedRuntime: verifiedRuntime)
  }

  static func validChromeOrigin(_ value: String) -> Bool {
    value.utf8.count <= 64
      && value.range(
        of: #"\Achrome-extension://[a-p]{32}/?\z"#, options: .regularExpression) != nil
  }

  private static func replaceCurrentProcess(_ plan: NativeHostLaunchPlan) -> Int32 {
    let argumentStrings = [plan.executable.path] + plan.arguments
    let environmentStrings = plan.environment.keys.sorted().compactMap { key in
      plan.environment[key].map { "\(key)=\($0)" }
    }
    func duplicate(_ value: String) -> UnsafeMutablePointer<CChar>? {
      value.withCString { strdup($0) }
    }
    var argv: [UnsafeMutablePointer<CChar>?] = argumentStrings.map(duplicate)
    var envp: [UnsafeMutablePointer<CChar>?] = environmentStrings.map(duplicate)
    defer {
      for value in argv { if let value { free(value) } }
      for value in envp { if let value { free(value) } }
    }
    guard argv.allSatisfy({ $0 != nil }), envp.allSatisfy({ $0 != nil }) else {
      return ENOMEM
    }
    argv.append(nil)
    envp.append(nil)
    return plan.executable.path.withCString { executable in
      argv.withUnsafeMutableBufferPointer { arguments in
        envp.withUnsafeMutableBufferPointer { environment in
          execve(executable, arguments.baseAddress, environment.baseAddress)
          return errno
        }
      }
    }
  }
}

private final class RuntimeOutputCapture: @unchecked Sendable {
  private let lock = NSLock()
  private var storage = Data()
  private var overflow = false
  private let maximumBytes: Int

  init(maximumBytes: Int) { self.maximumBytes = maximumBytes }

  func append(_ data: Data) {
    lock.lock()
    defer { lock.unlock() }
    guard !overflow else { return }
    guard storage.count + data.count <= maximumBytes else {
      overflow = true
      return
    }
    storage.append(data)
  }

  var result: Data? {
    lock.lock()
    defer { lock.unlock() }
    return overflow ? nil : storage
  }
}

struct RuntimeProcessResult: Sendable {
  let status: Int32
  let output: Data
}

enum RuntimeProcessRunner {
  static func stop(_ process: Process) {
    guard process.isRunning else { return }
    process.terminate()
    DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
      guard process.isRunning else { return }
      let pid = process.processIdentifier
      if pid > 0 { kill(pid, SIGKILL) }
    }
  }

  static func run(
    executable: URL, arguments: [String], timeout: TimeInterval = 120,
    maximumOutputBytes: Int = 8 * 1024 * 1024,
    register: @escaping @Sendable (Process?) -> Void = { _ in }
  ) throws -> RuntimeProcessResult {
    let process = Process()
    let output = Pipe()
    let errors = Pipe()
    let capture = RuntimeOutputCapture(maximumBytes: maximumOutputBytes)
    let group = DispatchGroup()
    process.executableURL = executable
    process.arguments = arguments
    process.environment = [
      "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
      "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8",
      "TMPDIR": NSTemporaryDirectory(),
    ]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = output
    process.standardError = errors
    for handle in [output.fileHandleForReading, errors.fileHandleForReading] {
      group.enter()
      handle.readabilityHandler = { readable in
        let bytes = readable.availableData
        if bytes.isEmpty {
          readable.readabilityHandler = nil
          group.leave()
        } else {
          capture.append(bytes)
          if capture.result == nil { stop(process) }
        }
      }
    }
    do { try process.run() } catch {
      output.fileHandleForReading.readabilityHandler = nil
      errors.fileHandleForReading.readabilityHandler = nil
      throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED")
    }
    register(process)
    let deadline = DispatchWorkItem {
      stop(process)
    }
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: deadline)
    process.waitUntilExit()
    deadline.cancel()
    register(nil)
    _ = group.wait(timeout: .now() + 2)
    output.fileHandleForReading.readabilityHandler = nil
    errors.fileHandleForReading.readabilityHandler = nil
    guard let bytes = capture.result else {
      throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED")
    }
    return RuntimeProcessResult(status: process.terminationStatus, output: bytes)
  }
}

protocol RuntimeSignatureChecking: Sendable {
  var verificationPolicyIdentifier: String { get }
  var supportsDurableVerificationReceipts: Bool { get }
  func validateOuterApplication(resources: URL, signing: RuntimeSigningManifest) throws
  func validateCode(at url: URL, signing: RuntimeSigningManifest) throws
  func verificationReceiptApplicationIdentity(resources: URL) throws
    -> RuntimeVerificationApplicationIdentity
}

extension RuntimeSignatureChecking {
  var supportsDurableVerificationReceipts: Bool { false }

  func verificationReceiptApplicationIdentity(resources: URL) throws
    -> RuntimeVerificationApplicationIdentity
  {
    throw RuntimeBootstrapFailure.code("RUNTIME_RECEIPT_UNAVAILABLE")
  }
}

struct SystemRuntimeSignatureChecker: RuntimeSignatureChecking {
  let verificationPolicyIdentifier = "musicmute-system-codesign-v1"
  let supportsDurableVerificationReceipts = true

  static func verificationArguments(
    for url: URL, signing: RuntimeSigningManifest
  ) throws -> [String] {
    var arguments = ["--verify", "--strict", "--all-architectures"]
    if signing.mode == "developer_id" {
      guard let teamID = signing.teamID else {
        throw RuntimeBootstrapFailure.code("RUNTIME_SIGNATURE_INVALID")
      }
      arguments += [
        "--test-requirement",
        "=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"\(teamID)\"",
      ]
    }
    arguments += ["--verbose=2", url.path]
    return arguments
  }

  private func details(_ url: URL) throws -> String {
    let result = try RuntimeProcessRunner.run(
      executable: URL(fileURLWithPath: "/usr/bin/codesign"),
      arguments: ["-d", "--verbose=4", url.path], timeout: 30, maximumOutputBytes: 128 * 1024)
    guard result.status == 0, let value = String(data: result.output, encoding: .utf8) else {
      throw RuntimeBootstrapFailure.code("RUNTIME_SIGNATURE_INVALID")
    }
    return value
  }

  private func verify(_ url: URL, signing: RuntimeSigningManifest) throws {
    let result = try RuntimeProcessRunner.run(
      executable: URL(fileURLWithPath: "/usr/bin/codesign"),
      arguments: try Self.verificationArguments(for: url, signing: signing), timeout: 60,
      maximumOutputBytes: 128 * 1024)
    guard result.status == 0 else {
      throw RuntimeBootstrapFailure.code("RUNTIME_SIGNATURE_INVALID")
    }
  }

  private func validateDetails(_ details: String, signing: RuntimeSigningManifest) throws {
    switch signing.mode {
    case "developer_id":
      guard let teamID = signing.teamID, details.contains("TeamIdentifier=\(teamID)"),
        details.contains("Authority=Developer ID Application:"),
        details.range(of: #"flags=.*\bruntime\b"#, options: .regularExpression) != nil
      else { throw RuntimeBootstrapFailure.code("RUNTIME_SIGNATURE_INVALID") }
    case "ad_hoc":
      guard details.contains("Signature=adhoc"),
        details.contains("TeamIdentifier=not set") || !details.contains("TeamIdentifier="),
        details.range(of: #"flags=.*\bruntime\b"#, options: .regularExpression) != nil
      else { throw RuntimeBootstrapFailure.code("RUNTIME_SIGNATURE_INVALID") }
    default: throw RuntimeBootstrapFailure.code("RUNTIME_SIGNATURE_INVALID")
    }
  }

  func validateOuterApplication(resources: URL, signing: RuntimeSigningManifest) throws {
    let application = resources.deletingLastPathComponent().deletingLastPathComponent()
    guard application.pathExtension == "app" else {
      throw RuntimeBootstrapFailure.code("RUNTIME_SIGNATURE_INVALID")
    }
    try verify(application, signing: signing)
    try validateDetails(try details(application), signing: signing)
  }

  func validateCode(at url: URL, signing: RuntimeSigningManifest) throws {
    try verify(url, signing: signing)
    try validateDetails(try details(url), signing: signing)
  }

  func verificationReceiptApplicationIdentity(resources: URL) throws
    -> RuntimeVerificationApplicationIdentity
  {
    let application = resources.deletingLastPathComponent().deletingLastPathComponent()
    guard application.pathExtension == "app" else {
      throw RuntimeBootstrapFailure.code("RUNTIME_RECEIPT_UNAVAILABLE")
    }
    let infoFile = application.appendingPathComponent("Contents/Info.plist")
    let data: Data
    do {
      data = try RuntimeFileSecurity.readRegularFile(
        infoFile, maximumBytes: 1024 * 1024, requireCurrentOwner: false,
        privatePermissions: false, code: "RUNTIME_RECEIPT_UNAVAILABLE")
    } catch {
      throw RuntimeBootstrapFailure.code("RUNTIME_RECEIPT_UNAVAILABLE")
    }
    guard
      let propertyList = try? PropertyListSerialization.propertyList(
        from: data, options: [], format: nil) as? [String: Any],
      let bundleIdentifier = propertyList["CFBundleIdentifier"] as? String,
      let bundleVersion = propertyList["CFBundleVersion"] as? String
    else { throw RuntimeBootstrapFailure.code("RUNTIME_RECEIPT_UNAVAILABLE") }
    let signingDetails = try details(application)
    guard
      let codeDirectoryHash = signingDetails.split(whereSeparator: \.isNewline).lazy
        .map(String.init).first(where: { $0.hasPrefix("CDHash=") })?
        .dropFirst("CDHash=".count).lowercased()
    else { throw RuntimeBootstrapFailure.code("RUNTIME_RECEIPT_UNAVAILABLE") }
    let identity = RuntimeVerificationApplicationIdentity(
      bundleIdentifier: bundleIdentifier, bundleVersion: bundleVersion,
      codeDirectoryHash: codeDirectoryHash)
    guard identity.structurallySafe else {
      throw RuntimeBootstrapFailure.code("RUNTIME_RECEIPT_UNAVAILABLE")
    }
    return identity
  }
}

struct RuntimeInventoryVerifier {
  let signatureChecker: any RuntimeSignatureChecking

  func verify(
    release: URL, resources: URL, manifest: RuntimeBootstrapManifest,
    progress: @escaping @Sendable (Double, String) -> Void = { _, _ in },
    cancelled: @escaping @Sendable () -> Bool = { false }
  ) throws {
    guard safeReleaseRoot(release) else {
      throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID")
    }
    let expected = Dictionary(uniqueKeysWithValues: manifest.files.map { ($0.path, $0) })
    let expectedDirectories = RuntimeInventoryMetadataFingerprint.derivedDirectories(
      manifest.files)
    guard let releasePath = RuntimePath.canonicalExisting(release) else {
      throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID")
    }
    guard
      let enumerator = FileManager.default.enumerator(
        at: release, includingPropertiesForKeys: nil, options: [], errorHandler: { _, _ in false })
    else { throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID") }
    var seen = Set<String>()
    var seenDirectories = Set<String>()
    var installedBytes: Int64 = 0
    var signed: [(URL, RuntimeFileManifest)] = []
    var checked = 0
    while let candidate = enumerator.nextObject() as? URL {
      if cancelled() { throw RuntimeBootstrapFailure.cancelled }
      guard candidate.path.hasPrefix(releasePath + "/") else {
        throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID")
      }
      let relative = String(candidate.path.dropFirst(releasePath.count + 1))
      guard RuntimePath.safeRelative(relative) else {
        throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID")
      }
      var information = stat()
      guard lstat(candidate.path, &information) == 0, information.st_uid == getuid()
      else { throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID") }
      switch information.st_mode & S_IFMT {
      case S_IFDIR:
        guard information.st_mode & 0o022 == 0, expectedDirectories.contains(relative),
          seenDirectories.insert(relative).inserted
        else {
          throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID")
        }
        continue
      case S_IFREG:
        guard information.st_mode & 0o022 == 0, information.st_nlink == 1,
          let entry = expected[relative], entry.type == "file",
          seen.insert(relative).inserted, entry.bytes == information.st_size,
          entry.executable == (information.st_mode & 0o111 != 0),
          let expectedDigest = entry.sha256,
          try RuntimeDigest.file(candidate, expectedBytes: entry.bytes) == expectedDigest
        else { throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID") }
        installedBytes += information.st_size
        if entry.codeSigned == true { signed.append((candidate, entry)) }
      case S_IFLNK:
        guard let entry = expected[relative], entry.type == "symlink",
          seen.insert(relative).inserted,
          let expectedTarget = entry.linkTarget,
          let target = try? FileManager.default.destinationOfSymbolicLink(atPath: candidate.path),
          target == expectedTarget, RuntimePath.safeLinkTarget(target, from: relative)
        else { throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID") }
      default: throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID")
      }
      checked += 1
      if checked % 128 == 0 {
        progress(
          45 + (Double(checked) / Double(manifest.files.count)) * 30,
          "Verifying downloaded runtime")
      }
    }
    guard seen.count == expected.count, seen == Set(expected.keys),
      seenDirectories == expectedDirectories,
      installedBytes == manifest.installedBytes
    else { throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID") }
    let resolvedSymlinks = try validateAllSymlinks(
      release: release, releasePath: releasePath, entries: expected,
      directories: seenDirectories)
    try signatureChecker.validateOuterApplication(
      resources: resources, signing: manifest.signing)
    for (index, item) in signed.enumerated() {
      if cancelled() { throw RuntimeBootstrapFailure.cancelled }
      try signatureChecker.validateCode(at: item.0, signing: manifest.signing)
      if index % 8 == 0 {
        progress(
          76 + (Double(index + 1) / Double(max(signed.count, 1))) * 17,
          "Checking runtime signatures")
      }
    }
    try validateCriticalSignatures(
      release: release, manifest: manifest, resolvedSymlinks: resolvedSymlinks)
  }

  private func safeReleaseRoot(_ release: URL) -> Bool {
    var information = stat()
    return lstat(release.path, &information) == 0 && information.st_mode & S_IFMT == S_IFDIR
      && information.st_uid == getuid() && information.st_mode & 0o022 == 0
  }

  private func validateCriticalSignatures(
    release: URL, manifest: RuntimeBootstrapManifest, resolvedSymlinks: [String: String]
  ) throws {
    let entries = Dictionary(uniqueKeysWithValues: manifest.files.map { ($0.path, $0) })
    for path in [
      "runtime/runtime/node/bin/node", "runtime/runtime/python/bin/python3",
      "runtime/runtime/bin/ffmpeg", "runtime/runtime/bin/ffprobe",
      "runtime/tools/youtube/bin/deno",
    ] {
      guard let launcher = entries[path] else {
        throw RuntimeBootstrapFailure.code("RUNTIME_SIGNATURE_INVALID")
      }
      let destination = launcher.type == "symlink" ? resolvedSymlinks[path] : path
      guard let destination, let target = entries[destination], target.type == "file",
        target.executable == true,
        target.codeSigned == true,
        FileManager.default.isExecutableFile(
          atPath: release.appendingPathComponent(path).path)
      else { throw RuntimeBootstrapFailure.code("RUNTIME_SIGNATURE_INVALID") }
    }
  }

  private func validateAllSymlinks(
    release: URL, releasePath: String, entries: [String: RuntimeFileManifest],
    directories: Set<String>
  ) throws -> [String: String] {
    let payloadPath = releasePath + "/runtime"
    var resolvedSymlinks = [String: String]()
    for entry in entries.values where entry.type == "symlink" {
      let link = release.appendingPathComponent(entry.path)
      guard let resolvedPath = RuntimePath.canonicalExisting(link),
        resolvedPath.hasPrefix(payloadPath + "/")
      else { throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID") }
      let destinationPath = String(resolvedPath.dropFirst(releasePath.count + 1))
      guard RuntimePath.safeRelative(destinationPath) else {
        throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID")
      }
      if let destination = entries[destinationPath] {
        guard destination.type == "file" else {
          throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID")
        }
      } else {
        guard directories.contains(destinationPath),
          !entry.path.hasPrefix(destinationPath + "/")
        else {
          throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID")
        }
      }
      resolvedSymlinks[entry.path] = destinationPath
    }
    return resolvedSymlinks
  }
}

final class RuntimeFileLock: @unchecked Sendable {
  enum Mode: Equatable {
    case exclusive
    case shared
  }

  private let descriptor: Int32

  init(path: URL, mode: Mode = .exclusive) throws {
    let directory = open(
      path.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
    guard directory >= 0 else {
      throw RuntimeBootstrapFailure.code("RUNTIME_SETUP_BUSY")
    }
    defer { close(directory) }
    let openFlags =
      mode == .exclusive
      ? O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW
      : O_RDONLY | O_CLOEXEC | O_NOFOLLOW
    let file = openat(directory, path.lastPathComponent, openFlags, 0o600)
    guard file >= 0 else {
      throw RuntimeBootstrapFailure.code("RUNTIME_SETUP_BUSY")
    }
    var information = stat()
    var named = stat()
    guard fstat(file, &information) == 0,
      fstatat(directory, path.lastPathComponent, &named, AT_SYMLINK_NOFOLLOW) == 0,
      information.st_mode & S_IFMT == S_IFREG,
      information.st_uid == getuid(), information.st_nlink == 1,
      information.st_mode & 0o077 == 0,
      named.st_mode & S_IFMT == S_IFREG,
      information.st_dev == named.st_dev, information.st_ino == named.st_ino
    else {
      close(file)
      throw RuntimeBootstrapFailure.code("RUNTIME_SETUP_BUSY")
    }
    let lockMode = mode == .exclusive ? LOCK_EX | LOCK_NB : LOCK_SH | LOCK_NB
    guard flock(file, lockMode) == 0 else {
      close(file)
      throw RuntimeBootstrapFailure.code("RUNTIME_SETUP_BUSY")
    }
    var namedAfterLock = stat()
    guard fstatat(directory, path.lastPathComponent, &namedAfterLock, AT_SYMLINK_NOFOLLOW) == 0,
      namedAfterLock.st_mode & S_IFMT == S_IFREG,
      information.st_dev == namedAfterLock.st_dev,
      information.st_ino == namedAfterLock.st_ino
    else {
      _ = flock(file, LOCK_UN)
      close(file)
      throw RuntimeBootstrapFailure.code("RUNTIME_SETUP_BUSY")
    }
    descriptor = file
  }

  func preserveAcrossExec() throws {
    let flags = fcntl(descriptor, F_GETFD)
    guard flags >= 0, fcntl(descriptor, F_SETFD, flags & ~FD_CLOEXEC) == 0 else {
      throw RuntimeBootstrapFailure.code("RUNTIME_SETUP_BUSY")
    }
  }

  deinit {
    _ = flock(descriptor, LOCK_UN)
    close(descriptor)
  }
}

enum RuntimeDownloadRequestPolicy {
  static func safeURL(_ url: URL?, allowedHosts: Set<String>) -> Bool {
    guard let url, RuntimePath.safeTransportURL(url), let host = url.host?.lowercased() else {
      return false
    }
    return allowedHosts.contains(host)
  }

  static func request(
    for url: URL, resume: (state: RuntimeDownloadResumeState, bytes: Int64)?
  ) -> URLRequest {
    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.httpShouldHandleCookies = false
    request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    request.setValue("MusicMuteLocal-runtime/1", forHTTPHeaderField: "User-Agent")
    if let resume {
      request.setValue("bytes=\(resume.bytes)-", forHTTPHeaderField: "Range")
      request.setValue(resume.state.etag, forHTTPHeaderField: "If-Range")
    }
    return request
  }

  static func redirectedRequest(
    _ proposed: URLRequest, allowedHosts: Set<String>,
    resume: (state: RuntimeDownloadResumeState, bytes: Int64)?
  ) -> URLRequest? {
    guard safeURL(proposed.url, allowedHosts: allowedHosts), let url = proposed.url else {
      return nil
    }
    return request(for: url, resume: resume)
  }
}

final class RuntimeDownloadDelegate: @unchecked Sendable {
  private let lock = NSLock()
  private let file: URL
  private let manifest: RuntimeBootstrapManifest
  private let allowedHosts: Set<String>
  private let configuration: URLSessionConfiguration
  private let progress: @Sendable (Double, String) -> Void
  private var attempt: Attempt?
  private var cancelled = false

  init(
    file: URL, manifest: RuntimeBootstrapManifest,
    configuration: URLSessionConfiguration = .ephemeral,
    progress: @escaping @Sendable (Double, String) -> Void
  ) {
    self.file = file
    self.manifest = manifest
    allowedHosts = Set(manifest.downloadHosts.map { $0.lowercased() })
    self.configuration = configuration.copy() as? URLSessionConfiguration ?? .ephemeral
    self.progress = progress
  }

  func download(_ url: URL) throws {
    guard url.absoluteString == manifest.url, safeResponseURL(url) else {
      throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_FAILED")
    }
    var retriedFromZero = false
    while true {
      try checkCancellation()
      var resume = try RuntimeDownloadResumeState.validated(
        partial: file, manifest: manifest)
      if let complete = resume, complete.bytes == manifest.archiveBytes {
        if (try? RuntimeDigest.file(file, expectedBytes: manifest.archiveBytes))
          == manifest.archiveSha256
        {
          return
        }
        try RuntimeDownloadResumeState.discard(partial: file)
        resume = nil
      }
      let attempt = Attempt(
        file: file, manifest: manifest, resume: resume, allowedHosts: allowedHosts,
        configuration: configuration, progress: progress)
      lock.lock()
      self.attempt = attempt
      let cancelledBeforeStart = cancelled
      lock.unlock()
      if cancelledBeforeStart { attempt.cancel() }
      let outcome: Attempt.Outcome
      do {
        outcome = try attempt.run(url)
      } catch {
        clear(attempt)
        _ = try RuntimeDownloadResumeState.validated(partial: file, manifest: manifest)
        throw error
      }
      clear(attempt)
      switch outcome {
      case .success:
        return
      case .retryFromZero:
        try RuntimeDownloadResumeState.discard(partial: file)
        guard resume != nil, !retriedFromZero else {
          throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_FAILED")
        }
        retriedFromZero = true
      }
    }
  }

  func cancel() {
    lock.lock()
    cancelled = true
    let attempt = attempt
    lock.unlock()
    attempt?.cancel()
  }

  private func checkCancellation() throws {
    lock.lock()
    let cancelled = cancelled
    lock.unlock()
    if cancelled { throw RuntimeBootstrapFailure.cancelled }
  }

  private func clear(_ attempt: Attempt) {
    lock.lock()
    if self.attempt === attempt { self.attempt = nil }
    lock.unlock()
  }

  private func safeResponseURL(_ url: URL?) -> Bool {
    RuntimeDownloadRequestPolicy.safeURL(url, allowedHosts: allowedHosts)
  }

  private final class Attempt: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate,
    @unchecked Sendable
  {
    enum Outcome { case success, retryFromZero }
    private enum Failure: Equatable { case failed, retryFromZero }

    private let lock = NSLock()
    private let file: URL
    private let manifest: RuntimeBootstrapManifest
    private let resume: (state: RuntimeDownloadResumeState, bytes: Int64)?
    private let allowedHosts: Set<String>
    private let configuration: URLSessionConfiguration
    private let progress: @Sendable (Double, String) -> Void
    private let finished = DispatchSemaphore(value: 0)
    private var handle: FileHandle?
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var startingBytes: Int64
    private var receivedBytes: Int64
    private var responseBytes: Int64 = 0
    private var expectedResponseBytes: Int64?
    private var responseAccepted = false
    private var failure: Failure?
    private var completed = false
    private var cancelled = false

    init(
      file: URL, manifest: RuntimeBootstrapManifest,
      resume: (state: RuntimeDownloadResumeState, bytes: Int64)?,
      allowedHosts: Set<String>, configuration: URLSessionConfiguration,
      progress: @escaping @Sendable (Double, String) -> Void
    ) {
      self.file = file
      self.manifest = manifest
      self.resume = resume
      self.allowedHosts = allowedHosts
      self.configuration = configuration.copy() as? URLSessionConfiguration ?? .ephemeral
      self.progress = progress
      startingBytes = resume?.bytes ?? 0
      receivedBytes = resume?.bytes ?? 0
    }

    func run(_ url: URL) throws -> Outcome {
      try openPartial()
      let configuration = configuredSession()
      let queue = OperationQueue()
      queue.name = "com.musicmute.local.runtime-download"
      queue.maxConcurrentOperationCount = 1
      let session = URLSession(
        configuration: configuration, delegate: self, delegateQueue: queue)
      let task = session.dataTask(
        with: RuntimeDownloadRequestPolicy.request(for: url, resume: resume))
      lock.lock()
      if cancelled {
        lock.unlock()
        closeHandle()
        session.invalidateAndCancel()
        throw RuntimeBootstrapFailure.cancelled
      }
      self.session = session
      self.task = task
      lock.unlock()
      task.resume()
      finished.wait()
      session.finishTasksAndInvalidate()
      lock.lock()
      let cancelled = cancelled
      let failure = failure
      let accepted = responseAccepted
      let expectedResponseBytes = expectedResponseBytes
      let responseBytes = responseBytes
      let receivedBytes = receivedBytes
      lock.unlock()
      if cancelled { throw RuntimeBootstrapFailure.cancelled }
      if failure == .retryFromZero { return .retryFromZero }
      guard failure == nil, accepted, let expectedResponseBytes,
        responseBytes == expectedResponseBytes, receivedBytes == manifest.archiveBytes
      else { throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_FAILED") }
      return .success
    }

    func cancel() {
      lock.lock()
      cancelled = true
      let task = task
      lock.unlock()
      task?.cancel()
    }

    private func configuredSession() -> URLSessionConfiguration {
      let configured = configuration.copy() as? URLSessionConfiguration ?? .ephemeral
      configured.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
      configured.timeoutIntervalForRequest = 60
      configured.timeoutIntervalForResource = 4 * 60 * 60
      configured.waitsForConnectivity = false
      configured.httpMaximumConnectionsPerHost = 1
      configured.urlCache = nil
      configured.httpCookieStorage = nil
      configured.urlCredentialStorage = nil
      configured.httpShouldSetCookies = false
      configured.httpCookieAcceptPolicy = .never
      configured.httpAdditionalHeaders = nil
      return configured
    }

    private func openPartial() throws {
      let flags =
        resume == nil
        ? O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC | O_NOFOLLOW
        : O_WRONLY | O_APPEND | O_CLOEXEC | O_NOFOLLOW
      let descriptor = open(file.path, flags, 0o600)
      guard descriptor >= 0 else {
        throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_FAILED")
      }
      var information = stat()
      guard fstat(descriptor, &information) == 0,
        information.st_mode & S_IFMT == S_IFREG,
        information.st_uid == getuid(), information.st_nlink == 1,
        information.st_mode & 0o077 == 0,
        information.st_size == startingBytes,
        information.st_size >= 0, information.st_size <= manifest.archiveBytes
      else {
        close(descriptor)
        throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_UNSAFE")
      }
      handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    }

    private func safeResponseURL(_ url: URL?) -> Bool {
      RuntimeDownloadRequestPolicy.safeURL(url, allowedHosts: allowedHosts)
    }

    func urlSession(
      _ session: URLSession, task: URLSessionTask,
      willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
      completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
      guard
        let redirected = RuntimeDownloadRequestPolicy.redirectedRequest(
          request, allowedHosts: allowedHosts, resume: resume)
      else {
        recordFailure(.failed)
        completionHandler(nil)
        return
      }
      completionHandler(redirected)
    }

    func urlSession(
      _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
      completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
    ) {
      guard let response = response as? HTTPURLResponse, safeResponseURL(response.url) else {
        recordFailure(.failed)
        completionHandler(.cancel)
        return
      }
      switch response.statusCode {
      case 200:
        do {
          if startingBytes > 0 { try resetForFullResponse() }
          guard identityEncoded(response), exactContentLength(response) == manifest.archiveBytes
          else { throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_FAILED") }
          let etag = strongResponseETag(response)
          if let etag {
            try RuntimeDownloadResumeState.persist(
              RuntimeDownloadResumeState(manifest: manifest, etag: etag), for: file)
          } else {
            try RuntimeDownloadResumeState.discardSidecar(for: file)
          }
          acceptResponse(bytes: manifest.archiveBytes)
          completionHandler(.allow)
        } catch {
          recordFailure(.failed)
          completionHandler(.cancel)
        }
      case 206 where startingBytes > 0:
        let remaining = manifest.archiveBytes - startingBytes
        let expectedRange =
          "bytes \(startingBytes)-\(manifest.archiveBytes - 1)/\(manifest.archiveBytes)"
        guard identityEncoded(response), strongResponseETag(response) == resume?.state.etag,
          response.value(forHTTPHeaderField: "Content-Range")?
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == expectedRange,
          exactContentLength(response) == remaining
        else {
          recordFailure(.retryFromZero)
          completionHandler(.cancel)
          return
        }
        acceptResponse(bytes: remaining)
        completionHandler(.allow)
      case 412 where startingBytes > 0, 416 where startingBytes > 0:
        recordFailure(.retryFromZero)
        completionHandler(.cancel)
      default:
        recordFailure(.failed)
        completionHandler(.cancel)
      }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
      lock.lock()
      let expectedResponseBytes = expectedResponseBytes
      let nextResponseBytes = responseBytes + Int64(data.count)
      let nextReceivedBytes = receivedBytes + Int64(data.count)
      let stopped = failure != nil || cancelled || !responseAccepted
      lock.unlock()
      guard !stopped, let expectedResponseBytes,
        nextResponseBytes <= expectedResponseBytes,
        nextReceivedBytes <= manifest.archiveBytes
      else {
        recordFailure(.failed)
        dataTask.cancel()
        return
      }
      do {
        guard let handle else { throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_FAILED") }
        try handle.write(contentsOf: data)
      } catch {
        recordFailure(.failed)
        dataTask.cancel()
        return
      }
      lock.lock()
      responseBytes = nextResponseBytes
      receivedBytes = nextReceivedBytes
      lock.unlock()
      let percent = min(40, max(0, Double(nextReceivedBytes) / Double(manifest.archiveBytes) * 40))
      progress(percent, "Downloading processing tools")
    }

    func urlSession(
      _ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?
    ) {
      do {
        try handle?.synchronize()
        try handle?.close()
      } catch { recordFailure(.failed) }
      handle = nil
      lock.lock()
      if error != nil, !cancelled, failure == nil { failure = .failed }
      guard !completed else {
        lock.unlock()
        return
      }
      completed = true
      lock.unlock()
      finished.signal()
    }

    private func resetForFullResponse() throws {
      try RuntimeDownloadResumeState.discardSidecar(for: file)
      guard let handle else { throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_FAILED") }
      try handle.truncate(atOffset: 0)
      try handle.seek(toOffset: 0)
      try handle.synchronize()
      lock.lock()
      startingBytes = 0
      receivedBytes = 0
      responseBytes = 0
      lock.unlock()
    }

    private func acceptResponse(bytes: Int64) {
      lock.lock()
      expectedResponseBytes = bytes
      responseBytes = 0
      responseAccepted = true
      lock.unlock()
    }

    private func identityEncoded(_ response: HTTPURLResponse) -> Bool {
      guard let value = response.value(forHTTPHeaderField: "Content-Encoding") else {
        return true
      }
      return value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "identity"
    }

    private func strongResponseETag(_ response: HTTPURLResponse) -> String? {
      guard
        let value = response.value(forHTTPHeaderField: "ETag")?
          .trimmingCharacters(in: .whitespacesAndNewlines),
        RuntimeDownloadResumeState.strongETag(value)
      else { return nil }
      return value
    }

    private func exactContentLength(_ response: HTTPURLResponse) -> Int64? {
      guard
        let value = response.value(forHTTPHeaderField: "Content-Length")?
          .trimmingCharacters(in: .whitespacesAndNewlines),
        !value.isEmpty, value.allSatisfy({ $0.isASCII && $0.isNumber }),
        let parsed = Int64(value), parsed >= 0,
        response.expectedContentLength == parsed
      else { return nil }
      return parsed
    }

    private func recordFailure(_ value: Failure) {
      lock.lock()
      if failure == nil { failure = value }
      lock.unlock()
    }

    private func closeHandle() {
      try? handle?.close()
      handle = nil
    }
  }
}

enum RuntimeStorageMaintenance {
  private struct ConsumerReference: Decodable {
    let schema_version: Int
    let consumer: String
    let runtime_id: String
    let archive_sha256: String
    let worker_root: String
    let service_id: String
  }
  private static let scratchPattern = try! NSRegularExpression(
    pattern:
      #"\A(?:install|rejected|cleanup)-[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\z"#
  )
  private static let downloadPattern = try! NSRegularExpression(
    pattern:
      #"\A[A-Za-z0-9][A-Za-z0-9._-]{0,63}-[0-9a-f]{12}\.zip(?:\.partial(?:\.resume\.json)?)?\z"#
  )
  private static let resumeTemporaryPattern = try! NSRegularExpression(
    pattern:
      #"\A\.runtime-resume-[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\.tmp\z"#
  )

  static func cleanupDownloads(
    _ downloads: URL, preserving manifest: RuntimeBootstrapManifest?
  ) throws {
    var directoryInformation = stat()
    guard lstat(downloads.path, &directoryInformation) == 0,
      directoryInformation.st_mode & S_IFMT == S_IFDIR,
      directoryInformation.st_uid == getuid(), directoryInformation.st_mode & 0o077 == 0
    else { throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_UNSAFE") }
    let entries: [URL]
    do {
      entries = try FileManager.default.contentsOfDirectory(
        at: downloads, includingPropertiesForKeys: nil)
    } catch { throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_UNSAFE") }
    guard entries.count <= 128 else {
      throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_UNSAFE")
    }

    let preservedNames: Set<String>
    if let manifest {
      guard RuntimePath.safeIdentifier(manifest.id), RuntimeDigest.valid(manifest.archiveSha256)
      else { throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_UNSAFE") }
      let archiveName = "\(manifest.id)-\(manifest.archiveSha256.prefix(12)).zip"
      preservedNames = [
        archiveName, "\(archiveName).partial", "\(archiveName).partial.resume.json",
      ]
    } else {
      preservedNames = []
    }

    var validated = [(url: URL, device: dev_t, inode: ino_t, maximumBytes: Int64)]()
    validated.reserveCapacity(entries.count)
    for entry in entries {
      let name = entry.lastPathComponent
      let range = NSRange(name.startIndex..<name.endIndex, in: name)
      let downloadMatch = downloadPattern.firstMatch(in: name, range: range) != nil
      let temporaryMatch = resumeTemporaryPattern.firstMatch(in: name, range: range) != nil
      guard downloadMatch || temporaryMatch else {
        throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_UNSAFE")
      }
      let maximumBytes: Int64 =
        name.hasSuffix(".resume.json") || temporaryMatch
        ? RuntimeDownloadResumeState.maximumBytes : 2_000_000_000
      var information = stat()
      guard lstat(entry.path, &information) == 0,
        information.st_mode & S_IFMT == S_IFREG,
        information.st_uid == getuid(), information.st_nlink == 1,
        information.st_mode & 0o077 == 0,
        information.st_size >= 0, information.st_size <= maximumBytes
      else { throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_UNSAFE") }
      validated.append((entry, information.st_dev, information.st_ino, maximumBytes))
    }

    for entry in validated where !preservedNames.contains(entry.url.lastPathComponent) {
      var information = stat()
      guard lstat(entry.url.path, &information) == 0,
        information.st_mode & S_IFMT == S_IFREG,
        information.st_uid == getuid(), information.st_nlink == 1,
        information.st_mode & 0o077 == 0,
        information.st_size >= 0, information.st_size <= entry.maximumBytes,
        information.st_dev == entry.device, information.st_ino == entry.inode
      else { throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_UNSAFE") }
      guard unlink(entry.url.path) == 0 else {
        throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED")
      }
    }
  }

  static func cleanupStaging(_ staging: URL) throws {
    try validateContainer(staging)
    let entries: [URL]
    do {
      entries = try FileManager.default.contentsOfDirectory(
        at: staging, includingPropertiesForKeys: nil)
    } catch { throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED") }
    guard entries.count <= 1_024 else {
      throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED")
    }
    for entry in entries {
      let name = entry.lastPathComponent
      let range = NSRange(name.startIndex..<name.endIndex, in: name)
      guard scratchPattern.firstMatch(in: name, range: range) != nil else { continue }
      try isolateAndRemove(entry, staging: staging)
    }
  }

  static func pruneReleases(
    releases: URL, staging: URL, currentID: String, previousID: String?
  ) throws {
    guard RuntimePath.safeIdentifier(currentID),
      previousID.map(RuntimePath.safeIdentifier) != false
    else {
      throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED")
    }
    try validateContainer(releases)
    try validateContainer(staging)
    let retained = try referencedRuntimeIDs(releases: releases)
    let entries: [URL]
    do {
      entries = try FileManager.default.contentsOfDirectory(
        at: releases, includingPropertiesForKeys: nil)
    } catch { throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED") }
    guard entries.count <= 128 else {
      throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED")
    }
    var candidates = [URL]()
    for entry in entries {
      let name = entry.lastPathComponent
      guard RuntimePath.safeIdentifier(name), name != currentID, !retained.contains(name) else {
        continue
      }
      var information = stat()
      guard lstat(entry.path, &information) == 0,
        information.st_mode & S_IFMT == S_IFDIR,
        information.st_uid == getuid(), information.st_mode & 0o777 == 0o500
      else { throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED") }
      candidates.append(entry)
    }
    candidates.sort {
      if $0.lastPathComponent == previousID { return false }
      if $1.lastPathComponent == previousID { return true }
      return $0.lastPathComponent < $1.lastPathComponent
    }
    var isolated = [(source: URL, temporary: URL, mode: mode_t)]()
    do {
      for source in candidates {
        var information = stat()
        guard lstat(source.path, &information) == 0 else {
          throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED")
        }
        let mode = information.st_mode & 0o777
        let temporary = try isolate(source, staging: staging, originalMode: mode)
        isolated.append((source, temporary, mode))
      }
    } catch {
      var restored = true
      for item in isolated.reversed() {
        if !RuntimeFileSecurity.exclusiveRename(item.temporary, to: item.source)
          || chmod(item.source.path, item.mode) != 0
        {
          restored = false
        }
      }
      guard restored else { throw RuntimeBootstrapFailure.code("RUNTIME_ACTIVATION_FAILED") }
      throw error
    }
    // Once every old release is atomically out of `releases`, activation is committed.
    // Interrupted or failed physical deletion is recovered by cleanupStaging on next prepare.
    for item in isolated {
      try? RuntimeFileSecurity.removeOwnedTree(item.temporary)
    }
  }

  static func discardOwnedTree(_ source: URL, staging: URL) throws {
    try validateContainer(staging)
    try isolateAndRemove(source, staging: staging)
  }

  /// Cooperative consumers publish under the shared bootstrap lease before activation.
  /// Prepare holds the exclusive lease here, so a referenced exact release cannot be
  /// removed between publication and service startup. Unknown references stop pruning.
  static func referencedRuntimeIDs(releases: URL) throws -> Set<String> {
    let runtime = releases.deletingLastPathComponent()
    let consumers = runtime.appendingPathComponent("consumers", isDirectory: true)
    var information = stat()
    guard lstat(consumers.path, &information) == 0 else {
      if errno == ENOENT { return [] }
      throw RuntimeBootstrapFailure.code("RUNTIME_CONSUMER_REFERENCE_INVALID")
    }
    do {
      try validateContainer(consumers)
      let references = try FileManager.default.contentsOfDirectory(
        at: consumers, includingPropertiesForKeys: nil)
      guard references.count <= 256 else {
        throw RuntimeBootstrapFailure.code("RUNTIME_CONSUMER_REFERENCE_INVALID")
      }
      let workerURL = runtime.deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("MusicMuteWorker", isDirectory: true)
      var workerInformation = stat()
      let workerRoot = RuntimePath.canonicalExisting(workerURL)
      if !references.isEmpty {
        guard workerRoot != nil, lstat(workerURL.path, &workerInformation) == 0,
          workerInformation.st_mode & S_IFMT == S_IFDIR,
          workerInformation.st_uid == getuid(), workerInformation.st_mode & 0o077 == 0
        else { throw RuntimeBootstrapFailure.code("RUNTIME_CONSUMER_REFERENCE_INVALID") }
      }
      let keys: Set<String> = [
        "schema_version", "consumer", "runtime_id", "archive_sha256", "worker_root", "service_id",
      ]
      var retained = Set<String>()
      for file in references {
        let data = try RuntimeFileSecurity.readPrivateFile(file, maximumBytes: 16 * 1024)
        guard let record = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(record.keys) == keys,
          let reference = try? JSONDecoder().decode(ConsumerReference.self, from: data),
          reference.schema_version == 1, reference.consumer == "macos-worker",
          RuntimePath.safeIdentifier(reference.runtime_id), safeDigest(reference.archive_sha256),
          safeDigest(reference.service_id),
          file.lastPathComponent == "\(reference.service_id).json",
          reference.worker_root == workerRoot
        else { throw RuntimeBootstrapFailure.code("RUNTIME_CONSUMER_REFERENCE_INVALID") }
        retained.insert(reference.runtime_id)
      }
      return retained
    } catch {
      throw RuntimeBootstrapFailure.code("RUNTIME_CONSUMER_REFERENCE_INVALID")
    }
  }

  private static func safeDigest(_ value: String) -> Bool {
    value.utf8.count == 64
      && value.utf8.allSatisfy {
        ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102)
      }
  }

  private static func validateContainer(_ directory: URL) throws {
    var information = stat()
    guard lstat(directory.path, &information) == 0,
      information.st_mode & S_IFMT == S_IFDIR,
      information.st_uid == getuid(), information.st_mode & 0o077 == 0
    else { throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED") }
  }

  private static func isolateAndRemove(_ source: URL, staging: URL) throws {
    var information = stat()
    guard lstat(source.path, &information) == 0,
      information.st_mode & S_IFMT == S_IFDIR, information.st_uid == getuid()
    else { throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED") }
    let originalMode = information.st_mode & 0o777
    let isolated = try isolate(source, staging: staging, originalMode: originalMode)
    try RuntimeFileSecurity.removeOwnedTree(isolated)
  }

  private static func isolate(
    _ source: URL, staging: URL, originalMode: mode_t
  ) throws -> URL {
    guard chmod(source.path, 0o700) == 0 else {
      throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED")
    }
    let isolated = staging.appendingPathComponent("cleanup-\(UUID().uuidString)", isDirectory: true)
    guard RuntimeFileSecurity.exclusiveRename(source, to: isolated) else {
      _ = chmod(source.path, originalMode)
      throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED")
    }
    return isolated
  }
}

final class RuntimeActivation: @unchecked Sendable {
  let runtimeRoot: URL
  private let activeFile: URL
  private let previous: Data?
  private let activated: Data
  private let changed: Bool
  private let commitAction: (@Sendable () throws -> Void)?
  private let lock = NSLock()
  private var completed = false
  private var commitResult: Bool?
  private var rollbackResult: Bool?
  private var setupLock: RuntimeFileLock?

  init(
    runtimeRoot: URL, activeFile: URL, previous: Data?, activated: Data, changed: Bool,
    setupLock: RuntimeFileLock? = nil,
    commitAction: (@Sendable () throws -> Void)? = nil
  ) {
    self.runtimeRoot = runtimeRoot
    self.activeFile = activeFile
    self.previous = previous
    self.activated = activated
    self.changed = changed
    self.setupLock = setupLock
    self.commitAction = commitAction
  }

  @discardableResult func commit() -> Bool {
    lock.lock()
    guard !completed else {
      let result = commitResult ?? true
      lock.unlock()
      return result
    }
    if let commitAction {
      do { try commitAction() } catch {
        let restored = restoreActiveDescriptor()
        completed = true
        commitResult = false
        rollbackResult = restored
        let retainedLock = setupLock
        setupLock = nil
        lock.unlock()
        _ = retainedLock
        _ = restored
        return false
      }
    }
    completed = true
    commitResult = true
    let retainedLock = setupLock
    setupLock = nil
    lock.unlock()
    _ = retainedLock
    return true
  }

  @discardableResult func rollback() -> Bool {
    lock.lock()
    guard !completed else {
      let result = rollbackResult ?? true
      lock.unlock()
      return result
    }
    completed = true
    let retainedLock = setupLock
    setupLock = nil
    let succeeded = restoreActiveDescriptor()
    rollbackResult = succeeded
    lock.unlock()
    _ = retainedLock
    return succeeded
  }

  private func restoreActiveDescriptor() -> Bool {
    guard changed,
      (try? RuntimeFileSecurity.readPrivateFile(activeFile, maximumBytes: 16 * 1024)) == activated
    else { return true }
    if let previous {
      do {
        try RuntimeFileSecurity.atomicWrite(previous, to: activeFile)
        return true
      } catch { return false }
    }
    var information = stat()
    return lstat(activeFile.path, &information) == 0
      && information.st_mode & S_IFMT == S_IFREG
      && information.st_uid == getuid() && information.st_nlink == 1
      && unlink(activeFile.path) == 0
  }

  deinit { _ = rollback() }
}

final class RuntimeBootstrapInstaller: @unchecked Sendable {
  private let resources: URL
  private let support: URL
  private let signatureChecker: any RuntimeSignatureChecking
  private let downloadConfiguration: URLSessionConfiguration
  private let stateLock = NSLock()
  private var cancelled = false
  private var downloader: RuntimeDownloadDelegate?
  private var subprocess: Process?

  init(
    resources: URL, support: URL = LocalPaths.support,
    signatureChecker: any RuntimeSignatureChecking = SystemRuntimeSignatureChecker(),
    downloadConfiguration: URLSessionConfiguration = .ephemeral
  ) {
    self.resources = resources
    self.support = support
    self.signatureChecker = signatureChecker
    self.downloadConfiguration =
      downloadConfiguration.copy() as? URLSessionConfiguration ?? .ephemeral
  }

  func cancel() {
    stateLock.lock()
    cancelled = true
    let downloader = downloader
    let subprocess = subprocess
    stateLock.unlock()
    downloader?.cancel()
    if let subprocess { RuntimeProcessRunner.stop(subprocess) }
  }

  private var isCancelled: Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    return cancelled
  }

  func prepare(progress: @escaping @Sendable (Double, String) -> Void) throws
    -> RuntimeActivation
  {
    let loaded = try RuntimeBootstrapDocument.load(resources: resources)
    let manifest = loaded.document.runtime
    try signatureChecker.validateOuterApplication(resources: resources, signing: manifest.signing)
    let runtimeDirectory = support.appendingPathComponent("runtime", isDirectory: true)
    let releases = runtimeDirectory.appendingPathComponent("releases", isDirectory: true)
    let downloads = runtimeDirectory.appendingPathComponent("downloads", isDirectory: true)
    let staging = runtimeDirectory.appendingPathComponent("staging", isDirectory: true)
    for directory in [support, runtimeDirectory, releases, downloads, staging] {
      try RuntimeFileSecurity.ensurePrivateDirectory(directory)
    }
    let setupLock = try RuntimeFileLock(
      path: runtimeDirectory.appendingPathComponent("bootstrap.lock"))
    try checkCancellation()
    try RuntimeStorageMaintenance.cleanupStaging(staging)
    try RuntimeStorageMaintenance.cleanupDownloads(downloads, preserving: manifest)
    let activeFile = runtimeDirectory.appendingPathComponent("active.json")
    var previous = try previousActiveData(
      activeFile: activeFile, runtimeDirectory: runtimeDirectory)
    let release = releases.appendingPathComponent(manifest.id, isDirectory: true)
    let verifier = RuntimeInventoryVerifier(signatureChecker: signatureChecker)
    if FileManager.default.fileExists(atPath: release.path) {
      do {
        progress(42, "Checking installed processing tools")
        try verifier.verify(
          release: release, resources: resources, manifest: manifest, progress: progress,
          cancelled: { [weak self] in self?.isCancelled ?? true })
        try freeze(release: release, manifest: manifest)
      } catch RuntimeBootstrapFailure.cancelled { throw RuntimeBootstrapFailure.cancelled } catch {
        if let previousData = previous,
          let activeDocument = try? JSONDecoder().decode(
            RuntimeActiveDocument.self, from: previousData),
          activeDocument.matches(manifest)
        {
          try clearActiveDescriptor(activeFile, expected: previousData)
          previous = nil
        }
        try RuntimeStorageMaintenance.discardOwnedTree(release, staging: staging)
        return try prepareMissingRelease(
          manifest: manifest, runtimeDirectory: runtimeDirectory, releases: releases,
          downloads: downloads, staging: staging, activeFile: activeFile, previous: previous,
          setupLock: setupLock, verifier: verifier, progress: progress)
      }
      try RuntimeStorageMaintenance.cleanupDownloads(downloads, preserving: nil)
      return try activate(
        release: release, manifest: manifest, activeFile: activeFile, previous: previous,
        setupLock: setupLock, releases: releases, staging: staging)
    }
    return try prepareMissingRelease(
      manifest: manifest, runtimeDirectory: runtimeDirectory, releases: releases,
      downloads: downloads, staging: staging, activeFile: activeFile, previous: previous,
      setupLock: setupLock, verifier: verifier, progress: progress)
  }

  private func prepareMissingRelease(
    manifest: RuntimeBootstrapManifest, runtimeDirectory: URL, releases: URL, downloads: URL,
    staging: URL, activeFile: URL, previous: Data?, setupLock: RuntimeFileLock,
    verifier: RuntimeInventoryVerifier, progress: @escaping @Sendable (Double, String) -> Void
  ) throws -> RuntimeActivation {
    let release = releases.appendingPathComponent(manifest.id, isDirectory: true)
    let archive = downloads.appendingPathComponent(
      "\(manifest.id)-\(manifest.archiveSha256.prefix(12)).zip")
    let partial = archive.appendingPathExtension("partial")
    let archiveIsValid = validArchive(archive, manifest: manifest)
    if !archiveIsValid {
      if FileManager.default.fileExists(atPath: archive.path) {
        try removeOwnedRegularFile(archive)
      }
      let recovered = try RuntimeArchivePromotion.recoverCompletePartial(
        partial, archive: archive, manifest: manifest)
      if !recovered {
        let resumableBytes =
          try RuntimeDownloadResumeState.validated(partial: partial, manifest: manifest)?.bytes ?? 0
        try requireDiskCapacity(
          runtimeDirectory: runtimeDirectory, manifest: manifest,
          additionalArchiveBytes: manifest.archiveBytes - resumableBytes)
        guard let url = manifest.archiveURL else {
          throw RuntimeBootstrapFailure.code("RUNTIME_MANIFEST_INVALID")
        }
        var verified = false
        for corruptionAttempt in 0...1 {
          try performDownload(
            url: url, partial: partial, manifest: manifest, progress: progress)
          try checkCancellation()
          if (try? RuntimeDigest.file(partial, expectedBytes: manifest.archiveBytes))
            == manifest.archiveSha256
          {
            verified = true
            break
          }
          try RuntimeDownloadResumeState.discard(partial: partial)
          if corruptionAttempt == 1 {
            throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID")
          }
        }
        guard verified else { throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID") }
        try RuntimeArchivePromotion.promote(partial, archive: archive, manifest: manifest)
      } else {
        try requireDiskCapacity(
          runtimeDirectory: runtimeDirectory, manifest: manifest, additionalArchiveBytes: 0)
      }
    } else {
      try requireDiskCapacity(
        runtimeDirectory: runtimeDirectory, manifest: manifest, additionalArchiveBytes: 0)
    }
    progress(42, "Verifying runtime archive")
    guard
      try RuntimeDigest.file(archive, expectedBytes: manifest.archiveBytes)
        == manifest.archiveSha256
    else {
      try removeOwnedRegularFile(archive)
      throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID")
    }
    try preflightArchive(archive, manifest: manifest)
    try checkCancellation()
    let candidate = staging.appendingPathComponent(
      "install-\(UUID().uuidString)", isDirectory: true)
    try RuntimeFileSecurity.ensurePrivateDirectory(candidate)
    defer {
      if FileManager.default.fileExists(atPath: candidate.path) {
        try? RuntimeFileSecurity.removeOwnedTree(candidate)
      }
    }
    progress(44, "Installing processing tools")
    let extraction = try runSubprocess(
      executable: "/usr/bin/ditto",
      arguments: ["-x", "-k", "--noextattr", "--noqtn", "--noacl", archive.path, candidate.path],
      timeout: 20 * 60, maximumOutputBytes: 256 * 1024)
    try checkCancellation()
    guard extraction.status == 0 else {
      throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED")
    }
    try verifier.verify(
      release: candidate, resources: resources, manifest: manifest, progress: progress,
      cancelled: { [weak self] in self?.isCancelled ?? true })
    try freeze(release: candidate, manifest: manifest)
    progress(94, "Activating processing tools")
    guard chmod(candidate.path, 0o700) == 0 else {
      throw RuntimeBootstrapFailure.code("RUNTIME_ACTIVATION_FAILED")
    }
    guard RuntimeFileSecurity.exclusiveRename(candidate, to: release) else {
      _ = chmod(candidate.path, 0o500)
      throw RuntimeBootstrapFailure.code("RUNTIME_ACTIVATION_FAILED")
    }
    guard chmod(release.path, 0o500) == 0 else {
      throw RuntimeBootstrapFailure.code("RUNTIME_ACTIVATION_FAILED")
    }
    try RuntimeStorageMaintenance.cleanupDownloads(downloads, preserving: nil)
    return try activate(
      release: release, manifest: manifest, activeFile: activeFile, previous: previous,
      setupLock: setupLock, releases: releases, staging: staging)
  }

  private func activate(
    release: URL, manifest: RuntimeBootstrapManifest, activeFile: URL, previous: Data?,
    setupLock: RuntimeFileLock, releases: URL, staging: URL
  ) throws -> RuntimeActivation {
    let runtimeRoot = release.appendingPathComponent("runtime", isDirectory: true)
    guard RuntimeInstallationResolver.criticalFilesReady(runtimeRoot) else {
      throw RuntimeBootstrapFailure.code("RUNTIME_ACTIVATION_FAILED")
    }
    let document = RuntimeActiveDocument(runtime: manifest)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    var data = try encoder.encode(document)
    data.append(10)
    let changed = previous != data
    if changed { try RuntimeFileSecurity.atomicWrite(data, to: activeFile) }
    let previousRuntimeID = previous.flatMap {
      try? JSONDecoder().decode(RuntimeActiveDocument.self, from: $0).runtimeID
    }
    let commitAction: @Sendable () throws -> Void = {
      try RuntimeStorageMaintenance.pruneReleases(
        releases: releases, staging: staging, currentID: manifest.id,
        previousID: previousRuntimeID)
    }
    return RuntimeActivation(
      runtimeRoot: runtimeRoot, activeFile: activeFile, previous: previous, activated: data,
      changed: changed, setupLock: setupLock, commitAction: commitAction)
  }

  func previousActiveData(
    activeFile: URL, runtimeDirectory: URL
  ) throws -> Data? {
    var information = stat()
    guard lstat(activeFile.path, &information) == 0 else {
      if errno == ENOENT { return nil }
      throw RuntimeBootstrapFailure.code("RUNTIME_ACTIVE_INVALID")
    }
    let data = try RuntimeFileSecurity.readPrivateFile(activeFile, maximumBytes: 16 * 1024)
    guard let document = try? JSONDecoder().decode(RuntimeActiveDocument.self, from: data),
      document.structurallySafe
    else { throw RuntimeBootstrapFailure.code("RUNTIME_ACTIVE_INVALID") }
    let release = runtimeDirectory.appendingPathComponent(document.releasePath)
    let payload = release.appendingPathComponent("runtime", isDirectory: true)
    let usable =
      RuntimeInstallationResolver.safeReleaseDirectory(release, support: support)
      && RuntimeInstallationResolver.safeReleaseDirectory(payload, support: support)
      && RuntimeInstallationResolver.criticalFilesReady(payload)
    if usable { return data }
    try clearActiveDescriptor(activeFile, expected: data)
    return nil
  }

  private func clearActiveDescriptor(_ activeFile: URL, expected: Data) throws {
    guard
      (try? RuntimeFileSecurity.readPrivateFile(activeFile, maximumBytes: 16 * 1024))
        == expected
    else { throw RuntimeBootstrapFailure.code("RUNTIME_ACTIVE_INVALID") }
    var information = stat()
    guard lstat(activeFile.path, &information) == 0,
      information.st_mode & S_IFMT == S_IFREG,
      information.st_uid == getuid(), information.st_nlink == 1,
      unlink(activeFile.path) == 0
    else { throw RuntimeBootstrapFailure.code("RUNTIME_ACTIVE_INVALID") }
  }

  private func validArchive(_ archive: URL, manifest: RuntimeBootstrapManifest) -> Bool {
    guard FileManager.default.fileExists(atPath: archive.path) else { return false }
    return (try? RuntimeDigest.file(archive, expectedBytes: manifest.archiveBytes))
      == manifest.archiveSha256
  }

  private func performDownload(
    url: URL, partial: URL, manifest: RuntimeBootstrapManifest,
    progress: @escaping @Sendable (Double, String) -> Void
  ) throws {
    let downloader = RuntimeDownloadDelegate(
      file: partial, manifest: manifest, configuration: downloadConfiguration,
      progress: progress)
    stateLock.lock()
    self.downloader = downloader
    let cancelledBeforeDownload = cancelled
    stateLock.unlock()
    if cancelledBeforeDownload { downloader.cancel() }
    defer {
      stateLock.lock()
      if self.downloader === downloader { self.downloader = nil }
      stateLock.unlock()
    }
    try downloader.download(url)
  }

  private func removeOwnedRegularFile(_ url: URL) throws {
    var information = stat()
    guard lstat(url.path, &information) == 0,
      information.st_mode & S_IFMT == S_IFREG,
      information.st_uid == getuid(), information.st_nlink == 1
    else { throw RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_UNSAFE") }
    guard unlink(url.path) == 0 else {
      throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED")
    }
  }

  private func requireDiskCapacity(
    runtimeDirectory: URL, manifest: RuntimeBootstrapManifest, additionalArchiveBytes: Int64
  ) throws {
    let values = try? runtimeDirectory.resourceValues(forKeys: [
      .volumeAvailableCapacityForImportantUsageKey
    ])
    guard let available = values?.volumeAvailableCapacityForImportantUsage else { return }
    let required = additionalArchiveBytes + manifest.installedBytes + 256_000_000
    guard available >= required else { throw RuntimeBootstrapFailure.code("DISK_SPACE_LOW") }
  }

  private func preflightArchive(_ archive: URL, manifest: RuntimeBootstrapManifest) throws {
    let result = try runSubprocess(
      executable: "/usr/bin/zipinfo", arguments: ["-1", archive.path], timeout: 120,
      maximumOutputBytes: 16 * 1024 * 1024)
    try checkCancellation()
    guard result.status == 0, let listing = String(data: result.output, encoding: .utf8) else {
      throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID")
    }
    let expectedFiles = Set(manifest.files.map(\.path))
    var expectedDirectories = Set<String>()
    for path in expectedFiles {
      var components = path.split(separator: "/").map(String.init)
      components.removeLast()
      while !components.isEmpty {
        expectedDirectories.insert(components.joined(separator: "/"))
        components.removeLast()
      }
    }
    var found = Set<String>()
    var listed = Set<String>()
    for raw in listing.split(separator: "\n", omittingEmptySubsequences: true) {
      let entry = String(raw)
      let directory = entry.hasSuffix("/")
      let path = directory ? String(entry.dropLast()) : entry
      guard RuntimePath.safeRelative(path) else {
        throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID")
      }
      guard listed.insert(path).inserted else {
        throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID")
      }
      if directory {
        guard expectedDirectories.contains(path) else {
          throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID")
        }
      } else {
        guard expectedFiles.contains(path), found.insert(path).inserted else {
          throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID")
        }
      }
    }
    guard found == expectedFiles else {
      throw RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID")
    }
  }

  private func freeze(release: URL, manifest: RuntimeBootstrapManifest) throws {
    let entries = Dictionary(uniqueKeysWithValues: manifest.files.map { ($0.path, $0) })
    guard let releasePath = RuntimePath.canonicalExisting(release) else {
      throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED")
    }
    guard
      let enumerator = FileManager.default.enumerator(
        at: release, includingPropertiesForKeys: nil, options: [], errorHandler: { _, _ in false })
    else { throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED") }
    var directories = [URL]()
    while let candidate = enumerator.nextObject() as? URL {
      var information = stat()
      guard lstat(candidate.path, &information) == 0 else {
        throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED")
      }
      guard candidate.path.hasPrefix(releasePath + "/") else {
        throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED")
      }
      let relative = String(candidate.path.dropFirst(releasePath.count + 1))
      switch information.st_mode & S_IFMT {
      case S_IFDIR: directories.append(candidate)
      case S_IFREG:
        guard let entry = entries[relative],
          chmod(candidate.path, entry.executable == true ? 0o500 : 0o400) == 0
        else { throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED") }
      case S_IFLNK: break
      default: throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED")
      }
    }
    for directory in directories.reversed() {
      guard chmod(directory.path, 0o500) == 0 else {
        throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED")
      }
    }
    guard chmod(release.path, 0o500) == 0 else {
      throw RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED")
    }
  }

  private func runSubprocess(
    executable: String, arguments: [String], timeout: TimeInterval, maximumOutputBytes: Int
  ) throws -> RuntimeProcessResult {
    try checkCancellation()
    return try RuntimeProcessRunner.run(
      executable: URL(fileURLWithPath: executable), arguments: arguments, timeout: timeout,
      maximumOutputBytes: maximumOutputBytes,
      register: { [weak self] process in
        self?.stateLock.lock()
        self?.subprocess = process
        let cancelled = self?.cancelled ?? true
        self?.stateLock.unlock()
        if let process, cancelled { RuntimeProcessRunner.stop(process) }
      })
  }

  private func checkCancellation() throws {
    if isCancelled { throw RuntimeBootstrapFailure.cancelled }
  }
}

enum ProcessOutcome: Sendable {
  case success, cancelled
  case failed(String)
}

private final class ActiveCommand: @unchecked Sendable {
  let process = Process()
  let stdout = Pipe()
  let stderr = Pipe()
  let lock = NSLock()
  var cancelled = false
  var timedOut = false
  var invalidOutput = false
  var outputBytes = 0
  var errorBytes = 0
  var terminalSeen = false
  var timeout: DispatchWorkItem?
  var installer: RuntimeBootstrapInstaller?
  var activation: RuntimeActivation?
  // Pins the verified release until the external child has fully terminated.
  var verifiedRuntime: RuntimeVerifiedRuntime?
  // Setup bypasses RuntimeVerificationCoordinator, so retain its app-update lease directly.
  var setupUpdateLease: RuntimeUpdateExecutionLease?
}

/// Executes the bundled control entrypoint without a shell or inherited secrets.
final class ProcessBridge: @unchecked Sendable {
  private let lock = NSLock()
  private var active: ActiveCommand?
  private let reader = DispatchQueue(label: "com.musicmute.local.control", qos: .userInitiated)
  private let support: URL
  private let signatureChecker: any RuntimeSignatureChecking
  private let verificationCoordinator: RuntimeVerificationCoordinator

  init(
    support: URL = LocalPaths.support,
    signatureChecker: any RuntimeSignatureChecking = SystemRuntimeSignatureChecker(),
    verificationCoordinator: RuntimeVerificationCoordinator = .shared
  ) {
    self.support = support
    self.signatureChecker = signatureChecker
    self.verificationCoordinator = verificationCoordinator
  }

  func run(
    _ command: AppCommand, resources: URL,
    onEvent: @escaping @Sendable (ControlEvent) -> Void,
    onFinish: @escaping @Sendable (ProcessOutcome) -> Void
  ) {
    let task = ActiveCommand()
    lock.lock()
    guard active == nil else {
      lock.unlock()
      onFinish(.failed("APP_OPERATION_BUSY"))
      return
    }
    active = task
    lock.unlock()
    reader.async { [self] in
      if command == .setup {
        do {
          let updateLease = try RuntimeUpdateExecutionLease(support: support)
          task.lock.lock()
          task.setupUpdateLease = updateLease
          task.lock.unlock()
        } catch let failure as RuntimeBootstrapFailure {
          onEvent(Self.failureEvent(failure.errorCode))
          finish(task, .failed(failure.errorCode), callback: onFinish)
          return
        } catch {
          onEvent(Self.failureEvent("UPDATE_LOCK_UNSAFE"))
          finish(task, .failed("UPDATE_LOCK_UNSAFE"), callback: onFinish)
          return
        }
      }
      let control = resources.appendingPathComponent("companion/app-control.js")
      guard FileManager.default.fileExists(atPath: control.path) else {
        finish(task, .failed("APP_RESOURCES_INCOMPLETE"), callback: onFinish)
        return
      }
      var runtime: URL?
      let hasBootstrap = FileManager.default.fileExists(
        atPath: resources.appendingPathComponent("runtime-bootstrap.json").path)
      if command == .setup && hasBootstrap {
        let installer = RuntimeBootstrapInstaller(
          resources: resources, support: support, signatureChecker: signatureChecker)
        task.lock.lock()
        task.installer = installer
        let cancelledBeforeInstall = task.cancelled
        task.lock.unlock()
        if cancelledBeforeInstall {
          finish(task, .cancelled, callback: onFinish)
          return
        }
        do {
          let activation = try installer.prepare { percent, label in
            let setupPercent = Self.runtimeSetupPercent(percent)
            onEvent(Self.progressEvent(phase: "runtime", percent: setupPercent, label: label))
          }
          task.lock.lock()
          task.activation = activation
          task.installer = nil
          let cancelledAfterInstall = task.cancelled
          task.lock.unlock()
          if cancelledAfterInstall {
            finish(task, .cancelled, callback: onFinish)
            return
          }
          runtime = activation.runtimeRoot
          onEvent(
            Self.progressEvent(
              phase: "runtime", percent: 55, label: "Processing tools are ready"))
        } catch RuntimeBootstrapFailure.cancelled {
          finish(task, .cancelled, callback: onFinish)
          return
        } catch let failure as RuntimeBootstrapFailure {
          onEvent(Self.failureEvent(failure.errorCode))
          finish(task, .failed(failure.errorCode), callback: onFinish)
          return
        } catch {
          onEvent(Self.failureEvent("RUNTIME_INSTALL_FAILED"))
          finish(task, .failed("RUNTIME_INSTALL_FAILED"), callback: onFinish)
          return
        }
      } else {
        do {
          let verifiedRuntime = try verificationCoordinator.installedRuntime(
            resources: resources, support: support)
          task.lock.lock()
          task.verifiedRuntime = verifiedRuntime
          task.lock.unlock()
          runtime = verifiedRuntime?.runtimeRoot
        } catch RuntimeBootstrapFailure.cancelled {
          finish(task, .cancelled, callback: onFinish)
          return
        } catch let failure as RuntimeBootstrapFailure {
          if command == .status && failure.errorCode == "APP_RUNTIME_INCOMPATIBLE" {
            onEvent(Self.missingRuntimeStatus(resources: resources))
            finish(task, .success, callback: onFinish)
            return
          }
          onEvent(Self.failureEvent(failure.errorCode))
          finish(task, .failed(failure.errorCode), callback: onFinish)
          return
        } catch {
          onEvent(Self.failureEvent("RUNTIME_ARCHIVE_INVALID"))
          finish(task, .failed("RUNTIME_ARCHIVE_INVALID"), callback: onFinish)
          return
        }
      }
      guard let runtime else {
        if command == .status && hasBootstrap {
          onEvent(Self.missingRuntimeStatus(resources: resources))
          finish(task, .success, callback: onFinish)
        } else {
          let code = hasBootstrap ? "APP_RUNTIME_NOT_PREPARED" : "APP_RESOURCES_INCOMPLETE"
          if hasBootstrap { onEvent(Self.failureEvent(code)) }
          finish(task, .failed(code), callback: onFinish)
        }
        return
      }
      let node = runtime.appendingPathComponent("runtime/node/bin/node")
      guard
        let launch = BundledControlLaunch.command(
          resources: resources, runtime: runtime, arguments: [control.path, command.rawValue])
      else {
        finish(task, .failed("APP_RESOURCES_INCOMPLETE"), callback: onFinish)
        return
      }
      task.process.executableURL = launch.executable
      task.process.arguments = launch.arguments
      task.process.currentDirectoryURL = resources
      let inherited = ProcessInfo.processInfo.environment
      var environment = [
        "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
        "PATH": "\(node.deletingLastPathComponent().path):/usr/bin:/bin:/usr/sbin:/sbin",
        "LANG": inherited["LANG"] ?? "en_US.UTF-8",
        "TMPDIR": inherited["TMPDIR"] ?? NSTemporaryDirectory(),
        "MUSICMUTE_LOCAL_APP_RESOURCES": resources.path,
        "MUSICMUTE_LOCAL_ROOT": support.path,
      ]
      if let home = inherited["HOME"], home.hasPrefix("/"), !home.contains("\0") {
        environment["HOME"] = home
      }
      task.process.environment = environment
      task.process.standardInput = FileHandle.nullDevice
      task.process.standardOutput = task.stdout
      task.process.standardError = task.stderr
      // Drain stderr independently but never persist/display arbitrary tool text.
      task.stderr.fileHandleForReading.readabilityHandler = { [weak task] handle in
        guard let task else { return }
        let data = handle.availableData
        task.lock.lock()
        task.errorBytes += data.count
        let exceeded = task.errorBytes > 2 * 1024 * 1024
        if exceeded { task.invalidOutput = true }
        task.lock.unlock()
        if data.isEmpty { handle.readabilityHandler = nil }
        if exceeded && task.process.isRunning { task.process.terminate() }
      }
      task.lock.lock()
      let cancelledBeforeStart = task.cancelled
      task.lock.unlock()
      if cancelledBeforeStart {
        task.stderr.fileHandleForReading.readabilityHandler = nil
        finish(task, .cancelled, callback: onFinish)
        return
      }
      do { try task.process.run() } catch {
        task.stderr.fileHandleForReading.readabilityHandler = nil
        finish(task, .failed("APP_PROCESS_START_FAILED"), callback: onFinish)
        return
      }
      task.lock.lock()
      let cancelledDuringStart = task.cancelled
      task.lock.unlock()
      if cancelledDuringStart { stop(task) }
      let timeout = DispatchWorkItem { [weak self, weak task] in
        guard let self, let task else { return }
        task.lock.lock()
        task.timedOut = true
        task.lock.unlock()
        stop(task)
      }
      task.timeout = timeout
      DispatchQueue.global().asyncAfter(
        deadline: .now() + (command == .setup ? 900 : 60), execute: timeout)
      var pending = Data()
      while true {
        let chunk = task.stdout.fileHandleForReading.availableData
        if chunk.isEmpty { break }
        pending.append(chunk)
        task.outputBytes += chunk.count
        if task.outputBytes > 4 * 1024 * 1024 || pending.count > 256 * 1024 {
          task.lock.lock()
          task.invalidOutput = true
          task.lock.unlock()
          stop(task)
          break
        }
        while let newline = pending.firstIndex(of: 10) {
          let line = Data(pending[..<newline])
          pending.removeSubrange(...newline)
          guard line.count <= 128 * 1024 else {
            task.lock.lock()
            task.invalidOutput = true
            task.lock.unlock()
            stop(task)
            break
          }
          if line.isEmpty { continue }
          do {
            let event = try ControlEvent.decode(line, command: command)
            if event.type == "result" || event.type == "error" {
              guard !task.terminalSeen else { throw AppValidation.invalidMessage }
              task.terminalSeen = true
            } else if task.terminalSeen {
              throw AppValidation.invalidMessage
            }
            if command == .setup, event.type == "progress" {
              onEvent(Self.remapSetupProgress(event))
            } else {
              onEvent(event)
            }
          } catch {
            task.lock.lock()
            task.invalidOutput = true
            task.lock.unlock()
            stop(task)
            break
          }
        }
        task.lock.lock()
        let invalid = task.invalidOutput
        task.lock.unlock()
        if invalid { break }
      }
      task.process.waitUntilExit()
      task.timeout?.cancel()
      task.stderr.fileHandleForReading.readabilityHandler = nil
      task.lock.lock()
      let cancelled = task.cancelled
      let timedOut = task.timedOut
      let invalid = task.invalidOutput
      task.lock.unlock()
      var outcome: ProcessOutcome
      if cancelled {
        outcome = .cancelled
      } else if timedOut {
        outcome = .failed("APP_OPERATION_TIMEOUT")
      } else if invalid || !pending.isEmpty {
        outcome = .failed("APP_CONTROL_INVALID")
      } else if task.process.terminationStatus == 75 {
        outcome = .failed("UPDATE_INSTALLING")
      } else if task.process.terminationStatus == 76 {
        outcome = .failed("UPDATE_LOCK_UNSAFE")
      } else if task.process.terminationStatus != 0 {
        outcome = .failed("APP_PROCESS_EXITED")
      } else if !task.terminalSeen {
        outcome = .failed("APP_RESULT_MISSING")
      } else {
        outcome = .success
      }
      if case .success = outcome {
        if task.activation?.commit() == false {
          outcome = .failed("RUNTIME_INSTALL_FAILED")
        }
      }
      finish(task, outcome, callback: onFinish)
    }
  }

  func cancel() {
    lock.lock()
    let task = active
    lock.unlock()
    guard let task else { return }
    task.lock.lock()
    task.cancelled = true
    let installer = task.installer
    task.lock.unlock()
    installer?.cancel()
    stop(task)
  }

  private func stop(_ task: ActiveCommand) {
    if task.process.isRunning { task.process.terminate() }
    DispatchQueue.global().asyncAfter(deadline: .now() + 3) { [weak task] in
      guard let task, task.process.isRunning else { return }
      let pid = task.process.processIdentifier
      if pid > 0 { kill(pid, SIGKILL) }
    }
  }
  private func finish(
    _ task: ActiveCommand, _ result: ProcessOutcome, callback: @Sendable (ProcessOutcome) -> Void
  ) {
    task.timeout?.cancel()
    let finalResult: ProcessOutcome
    if case .success = result {
      finalResult = result
    } else if task.activation?.rollback() == false {
      finalResult = .failed("RUNTIME_ACTIVATION_FAILED")
    } else {
      finalResult = result
    }
    lock.lock()
    if active === task { active = nil }
    lock.unlock()
    task.lock.lock()
    task.verifiedRuntime = nil
    task.setupUpdateLease = nil
    task.lock.unlock()
    callback(finalResult)
  }

  private static func progressEvent(phase: String, percent: Double, label: String) -> ControlEvent {
    ControlEvent(
      type: "progress", protocolVersion: 1, phase: phase, percent: percent, label: label,
      status: nil, report: nil, path: nil, errorCode: nil, action: nil)
  }

  static func runtimeSetupPercent(_ percent: Double) -> Double {
    min(55, max(0, percent * 0.55))
  }

  static func companionSetupPercent(_ percent: Double) -> Double {
    55 + min(max(percent, 0), 100) * 0.45
  }

  private static func remapSetupProgress(_ event: ControlEvent) -> ControlEvent {
    progressEvent(
      phase: event.phase ?? "setup", percent: companionSetupPercent(event.percent ?? 0),
      label: event.label ?? "Preparing your Mac")
  }

  private static func failureEvent(_ code: String) -> ControlEvent {
    let actions = [
      "RUNTIME_SETUP_BUSY":
        "Another MusicMute preparation is running. Wait for it to finish, then retry.",
      "RUNTIME_DOWNLOAD_FAILED":
        "Check your internet connection, then retry. The download will resume safely.",
      "RUNTIME_DOWNLOAD_UNSAFE":
        "MusicMute could not safely resume the runtime download. Review the app data folder, then retry.",
      "RUNTIME_ARCHIVE_INVALID":
        "The processing tools did not pass verification. Retry to download a clean copy.",
      "RUNTIME_SIGNATURE_INVALID":
        "The processing tools are not signed for this MusicMute app. Install an official update and retry.",
      "RUNTIME_MANIFEST_INVALID":
        "This MusicMute app has an invalid runtime manifest. Reinstall or update the app.",
      "RUNTIME_ACTIVE_INVALID":
        "MusicMute cannot safely read its runtime selection. Open Setup and retry Prepare; contact support if it repeats.",
      "RUNTIME_ACTIVATION_FAILED":
        "MusicMute could not activate the verified runtime. Check available disk space and retry.",
      "RUNTIME_INSTALL_FAILED":
        "MusicMute could not install the processing tools. Retry; incomplete tools will never be used.",
      "UPDATE_INSTALLING":
        "MusicMute is installing an update. Reopen the app when installation finishes.",
      "UPDATE_LOCK_UNSAFE":
        "MusicMute could not safely coordinate with the app updater. Restart MusicMute and retry.",
      "APP_RUNTIME_NOT_PREPARED":
        "Open Setup and choose Prepare my Mac before using local processing.",
      "APP_RUNTIME_INCOMPATIBLE":
        "This app version needs its matching processing tools. Open Setup and prepare this version.",
      "DISK_SPACE_LOW": "Free at least 2.5 GB on this Mac, then retry preparation.",
      "LOCAL_DIRECTORY_NOT_PRIVATE":
        "MusicMute cannot use its app data folder safely. Check its ownership and permissions.",
    ]
    return ControlEvent(
      type: "error", protocolVersion: 1, phase: nil, percent: nil, label: nil,
      status: nil, report: nil, path: nil, errorCode: code,
      action: actions[code] ?? "Retry preparation. Your previous runtime remains available.")
  }

  private static func missingRuntimeStatus(resources: URL) -> ControlEvent {
    let status = CompanionStatus(
      ready: false, platform: "darwin", arch: "arm64",
      version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        ?? "0.1.0",
      runtimeReady: false, modelReady: false, extensionRegistered: false,
      extensionPath: resources.appendingPathComponent("extension", isDirectory: true).path,
      modelBytes: 0, cacheBytes: 0, diagnosticMode: "LOCAL_ONLY",
      maxDurationSeconds: DesktopMediaLimits.maxDurationSeconds,
      downloaderReady: false, javascriptReady: false, tokenProviderReady: false,
      youtubeReady: false, localProcessingReady: false,
      components: [
        SetupComponentStatus(component: "engine", state: "missing", errorCode: nil),
        SetupComponentStatus(component: "model", state: "missing", errorCode: nil),
        SetupComponentStatus(component: "downloader", state: "missing", errorCode: nil),
        SetupComponentStatus(component: "javascript", state: "missing", errorCode: nil),
        SetupComponentStatus(component: "token_provider", state: "missing", errorCode: nil),
        SetupComponentStatus(component: "chrome", state: "missing", errorCode: nil),
      ])
    return ControlEvent(
      type: "result", protocolVersion: 1, phase: nil, percent: nil, label: nil,
      status: status, report: nil, path: nil, errorCode: nil, action: nil)
  }
}
