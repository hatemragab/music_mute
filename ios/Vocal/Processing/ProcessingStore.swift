import CryptoKit
import Foundation

enum UploadPhase: String, Codable, Sendable {
  case reservationPending, uploadPending, uploading, confirmationPending, submitted, stopped
}

enum AudioPipelinePhase: String, Codable, Sendable {
  case inspectingSource
  case preparingInput, reservingJob, uploadingInput
  case confirmingUpload, waitingProcessing, ready, awaitingAppResume, cancelling
  case failed, cancelled, deleted, awaitingConfirmation

  var isTerminal: Bool { [.ready, .failed, .cancelled, .deleted].contains(self) }

  init(from decoder: Decoder) throws {
    let value = try decoder.singleValueContainer().decode(String.self)
    self = Self(rawValue: value) ?? .failed
  }

}

struct AudioPipelineIntent: Codable, Equatable, Identifiable, Sendable {
  let operationId: UUID
  var id: UUID { operationId }
  let ownerUid: String
  let sourceKind: JobSourceKind
  var sourceTitle: String?
  var displayName: String?
  let clientStartedAt: Date
  var updatedAt: Date
  var completedAt: Date?
  var phase: AudioPipelinePhase
  var jobId: String?
  var jobStatus: String?
  var retryAttempt: Int
  var nextRetryAt: Date?
  var lastFailureCode: String?
  var cancellationRequested: Bool
  var activeRunToken: UUID?
  var reviewInput: PreparedInput?
  var cloudConsent: Bool?

  enum CodingKeys: String, CodingKey {
    case operationId, ownerUid, sourceKind, sourceTitle, displayName
    case clientStartedAt, updatedAt, completedAt, phase, jobId, jobStatus, retryAttempt
    case nextRetryAt, lastFailureCode, cancellationRequested, activeRunToken, reviewInput,
      cloudConsent
  }

  init(
    operationId: UUID, ownerUid: String, sourceKind: JobSourceKind,
    sourceTitle: String? = nil, displayName: String? = nil,
    clientStartedAt: Date, updatedAt: Date, completedAt: Date? = nil,
    phase: AudioPipelinePhase, jobId: String? = nil, jobStatus: String? = nil,
    retryAttempt: Int = 0, nextRetryAt: Date? = nil, lastFailureCode: String? = nil,
    cancellationRequested: Bool = false, activeRunToken: UUID? = nil
  ) {
    self.operationId = operationId
    self.ownerUid = ownerUid
    self.sourceKind = sourceKind
    self.sourceTitle = sourceTitle
    self.displayName = displayName
    self.clientStartedAt = clientStartedAt
    self.updatedAt = updatedAt
    self.completedAt = completedAt
    self.phase = phase
    self.jobId = jobId
    self.jobStatus = jobStatus
    self.retryAttempt = retryAttempt
    self.nextRetryAt = nextRetryAt
    self.lastFailureCode = lastFailureCode
    self.cancellationRequested = cancellationRequested
    self.activeRunToken = activeRunToken
  }
}

struct UploadOperation: Codable, Equatable, Identifiable, Sendable {
  var id: UUID { operationId }
  let operationId: UUID
  let ownerUid: String
  let requestId: UUID
  let input: InputDeclaration
  let stagedRelativePath: String
  let createdAt: Date
  var updatedAt: Date
  var jobId: String?
  var jobStatus: String?
  var phase: UploadPhase
  var transferId: UUID?
  var transferTaskId: Int?
  var uploadAttempts: Int
  var uploadGrantRequestId: UUID? = nil
  var lastFailureCode: String?
  var cancellationRequested: Bool = false
  var sourceTitle: String?
  var sourceKind: JobSourceKind?
  var sourceURL: String? = nil
  var clientStartedAt: Date?
  var displayName: String?
  var activeRunToken: UUID? = nil
  var policyVersion: Int? = nil
  var preparationProfileId: String? = nil
  var mediaSource: String? = nil

  enum CodingKeys: String, CodingKey {
    case operationId, ownerUid, requestId, input, stagedRelativePath, createdAt, updatedAt
    case jobId, jobStatus, phase, transferId, transferTaskId, uploadAttempts,
      uploadGrantRequestId, lastFailureCode
    case cancellationRequested, sourceTitle, sourceKind, sourceURL, clientStartedAt, displayName,
      activeRunToken, policyVersion, preparationProfileId, mediaSource
  }
}

extension UploadOperation {
  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    self.init(
      operationId: try values.decode(UUID.self, forKey: .operationId),
      ownerUid: try values.decode(String.self, forKey: .ownerUid),
      requestId: try values.decode(UUID.self, forKey: .requestId),
      input: try values.decode(InputDeclaration.self, forKey: .input),
      stagedRelativePath: try values.decode(String.self, forKey: .stagedRelativePath),
      createdAt: try values.decode(Date.self, forKey: .createdAt),
      updatedAt: try values.decode(Date.self, forKey: .updatedAt),
      jobId: try values.decodeIfPresent(String.self, forKey: .jobId),
      jobStatus: try values.decodeIfPresent(String.self, forKey: .jobStatus),
      phase: try values.decode(UploadPhase.self, forKey: .phase),
      transferId: try values.decodeIfPresent(UUID.self, forKey: .transferId),
      transferTaskId: try values.decodeIfPresent(Int.self, forKey: .transferTaskId),
      uploadAttempts: try values.decode(Int.self, forKey: .uploadAttempts),
      uploadGrantRequestId: try values.decodeIfPresent(UUID.self, forKey: .uploadGrantRequestId),
      lastFailureCode: try values.decodeIfPresent(String.self, forKey: .lastFailureCode),
      cancellationRequested: try values.decodeIfPresent(Bool.self, forKey: .cancellationRequested)
        ?? false,
      sourceTitle: try values.decodeIfPresent(String.self, forKey: .sourceTitle),
      sourceKind: try values.decodeIfPresent(JobSourceKind.self, forKey: .sourceKind),
      sourceURL: try values.decodeIfPresent(String.self, forKey: .sourceURL),
      clientStartedAt: try values.decodeIfPresent(Date.self, forKey: .clientStartedAt),
      displayName: try values.decodeIfPresent(String.self, forKey: .displayName),
      activeRunToken: try values.decodeIfPresent(UUID.self, forKey: .activeRunToken),
      policyVersion: try values.decodeIfPresent(Int.self, forKey: .policyVersion),
      preparationProfileId: try values.decodeIfPresent(String.self, forKey: .preparationProfileId),
      mediaSource: try values.decodeIfPresent(String.self, forKey: .mediaSource))
  }
}

enum JobRetryPhase: String, Codable, Sendable { case pending, submitted, newInputRequired }

struct JobRetryIntent: Codable, Equatable, Identifiable, Sendable {
  var id: UUID { requestId }
  let ownerUid: String
  let originalJobId: String
  let requestId: UUID
  let createdAt: Date
  var updatedAt: Date
  var phase: JobRetryPhase
  var result: JobMutation?
  var lastFailureCode: String?
}

enum ProcessingStoreFailure: Error, Equatable {
  case invalidPath, corruptStore, conflictingIntent, missingOperation, storage
}

/// All read/modify/write operations are serialized; only safe metadata is persisted.
actor ProcessingStore {
  private struct Snapshot: Codable {
    var version: Int
    let ownerUid: String
    var operations: [UploadOperation]
    var jobs: [Job]
    var retryIntents: [JobRetryIntent]? = nil
    var pipelines: [AudioPipelineIntent]? = nil
  }
  private let root: URL
  private let stagingRoot: URL
  private var snapshots: [String: Snapshot] = [:]

  init(root: URL, stagingRoot: URL) {
    self.root = root.standardizedFileURL.resolvingSymlinksInPath()
    self.stagingRoot = stagingRoot.standardizedFileURL.resolvingSymlinksInPath()
  }

  nonisolated static func ownerDirectoryName(_ uid: String) -> String {
    SHA256.hash(data: Data(uid.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  func operations(ownerUid: String) throws -> [UploadOperation] {
    try load(ownerUid).operations.sorted { $0.createdAt > $1.createdAt }
  }

  func pipelines(ownerUid: String) throws -> [AudioPipelineIntent] {
    (try load(ownerUid).pipelines ?? []).sorted { $0.clientStartedAt > $1.clientStartedAt }
  }

  func pipeline(id: UUID, ownerUid: String) throws -> AudioPipelineIntent? {
    try pipelines(ownerUid: ownerUid).first { $0.operationId == id }
  }

  func createPipeline(
    operationId: UUID, ownerUid: String, sourceKind: JobSourceKind,
    sourceTitle: String? = nil, clientStartedAt: Date = Date()
  ) throws -> AudioPipelineIntent {
    guard !ownerUid.isEmpty, sourceKind == .file else {
      throw ProcessingStoreFailure.invalidPath
    }
    var snapshot = try load(ownerUid)
    if let existing = snapshot.pipelines?.first(where: { $0.operationId == operationId }) {
      guard existing.sourceKind == sourceKind,
        existing.sourceTitle == sourceTitle, existing.clientStartedAt == clientStartedAt
      else { throw ProcessingStoreFailure.conflictingIntent }
      return existing
    }
    let intent = AudioPipelineIntent(
      operationId: operationId, ownerUid: ownerUid, sourceKind: sourceKind,
      sourceTitle: sourceTitle, displayName: sourceTitle,
      clientStartedAt: clientStartedAt, updatedAt: clientStartedAt,
      phase: .preparingInput)
    if snapshot.pipelines == nil { snapshot.pipelines = [] }
    snapshot.pipelines?.append(intent)
    snapshot.version = 2
    try persist(snapshot)
    return intent
  }

  @discardableResult
  func updatePipeline(
    id: UUID, ownerUid: String, _ change: @Sendable (inout AudioPipelineIntent) -> Void
  ) throws -> AudioPipelineIntent {
    var snapshot = try load(ownerUid)
    guard var values = snapshot.pipelines,
      let index = values.firstIndex(where: { $0.operationId == id })
    else { throw ProcessingStoreFailure.missingOperation }
    change(&values[index])
    values[index].updatedAt = Date()
    snapshot.pipelines = values
    snapshot.version = 2
    try persist(snapshot)
    return values[index]
  }

  func removePipeline(id: UUID, ownerUid: String) throws {
    var snapshot = try load(ownerUid)
    let count = snapshot.pipelines?.count ?? 0
    snapshot.pipelines?.removeAll { $0.operationId == id }
    guard snapshot.pipelines?.count != count else { throw ProcessingStoreFailure.missingOperation }
    snapshot.version = 2
    try persist(snapshot)
  }

  func removeOperation(id: UUID, ownerUid: String) throws {
    var snapshot = try load(ownerUid)
    guard let operation = snapshot.operations.first(where: { $0.operationId == id }) else { return }
    snapshot.operations.removeAll { $0.operationId == id }
    try persist(snapshot)
    let directory = try inputURL(for: operation).deletingLastPathComponent()
    try? FileManager.default.removeItem(at: directory)
  }

  /// Only an authenticated, persisted upload-complete receipt permits deletion.
  /// Unknown completion and uploadPending retain the immutable file for retry.
  func cleanupConfirmedInput(id: UUID, ownerUid: String) throws {
    guard let operation = try operation(id: id, ownerUid: ownerUid), operation.phase == .submitted,
      let status = operation.jobStatus, status != "awaiting_upload"
    else { return }
    let directory = try inputURL(for: operation).deletingLastPathComponent()
    if FileManager.default.fileExists(atPath: directory.path) {
      try FileManager.default.removeItem(at: directory)
    }
  }

  func operation(id: UUID, ownerUid: String) throws -> UploadOperation? {
    try load(ownerUid).operations.first { $0.operationId == id }
  }

  func cachedJobs(ownerUid: String) throws -> [Job] { try load(ownerUid).jobs }

  func saveJobs(_ jobs: [Job], ownerUid: String) throws {
    var snapshot = try load(ownerUid)
    snapshot.jobs = jobs
    try persist(snapshot)
  }

  func retries(ownerUid: String) throws -> [JobRetryIntent] {
    try load(ownerUid).retryIntents ?? []
  }

  func retryIntent(jobId: String, ownerUid: String) throws -> JobRetryIntent? {
    try retries(ownerUid: ownerUid).first { $0.originalJobId == jobId }
  }

  func createRetryIntent(jobId: String, ownerUid: String) throws -> JobRetryIntent {
    var snapshot = try load(ownerUid)
    if let existing = snapshot.retryIntents?.first(where: { $0.originalJobId == jobId }) {
      return existing
    }
    let now = Date()
    let intent = JobRetryIntent(
      ownerUid: ownerUid, originalJobId: jobId, requestId: UUID(),
      createdAt: now, updatedAt: now, phase: .pending, result: nil, lastFailureCode: nil)
    if snapshot.retryIntents == nil { snapshot.retryIntents = [] }
    snapshot.retryIntents?.append(intent)
    try persist(snapshot)
    return intent
  }

  @discardableResult
  func updateRetry(
    requestId: UUID, ownerUid: String,
    _ change: @Sendable (inout JobRetryIntent) -> Void
  ) throws -> JobRetryIntent {
    var snapshot = try load(ownerUid)
    guard var intents = snapshot.retryIntents,
      let index = intents.firstIndex(where: { $0.requestId == requestId })
    else { throw ProcessingStoreFailure.missingOperation }
    change(&intents[index])
    intents[index].updatedAt = Date()
    snapshot.retryIntents = intents
    try persist(snapshot)
    return intents[index]
  }

  func createOperation(prepared: PreparedInput) throws -> UploadOperation {
    guard !prepared.ownerUid.isEmpty else { throw ProcessingStoreFailure.invalidPath }
    let relative =
      Self.ownerDirectoryName(prepared.ownerUid) + "/"
      + prepared.operationId.uuidString.lowercased() + "/input." + prepared.declaration.extension
    let expected = stagingRoot.appendingPathComponent(relative).standardizedFileURL
    guard prepared.fileURL.isFileURL, prepared.fileURL.resolvingSymlinksInPath() == expected,
      expected.resolvingSymlinksInPath() == expected,
      Self.validExtension(prepared.declaration.extension)
    else { throw ProcessingStoreFailure.invalidPath }
    var snapshot = try load(prepared.ownerUid)
    if let existing = snapshot.operations.first(where: { $0.operationId == prepared.operationId }) {
      guard existing.input == prepared.declaration, existing.stagedRelativePath == relative else {
        throw ProcessingStoreFailure.conflictingIntent
      }
      return existing
    }
    let now = Date()
    let operation = UploadOperation(
      operationId: prepared.operationId, ownerUid: prepared.ownerUid,
      requestId: prepared.operationId, input: prepared.declaration, stagedRelativePath: relative,
      createdAt: now, updatedAt: now, jobId: nil, jobStatus: nil, phase: .reservationPending,
      transferId: nil, transferTaskId: nil, uploadAttempts: 0, lastFailureCode: nil,
      sourceTitle: prepared.sourceTitle, sourceKind: prepared.sourceKind,
      sourceURL: prepared.sourceURL,
      clientStartedAt: prepared.clientStartedAt, displayName: prepared.displayName,
      policyVersion: prepared.policyVersion, preparationProfileId: prepared.preparationProfileId,
      mediaSource: prepared.mediaSource)
    snapshot.operations.append(operation)
    try persist(snapshot)
    return operation
  }

  @discardableResult
  func update(id: UUID, ownerUid: String, _ change: @Sendable (inout UploadOperation) -> Void)
    throws
    -> UploadOperation
  {
    var snapshot = try load(ownerUid)
    guard let index = snapshot.operations.firstIndex(where: { $0.operationId == id }) else {
      throw ProcessingStoreFailure.missingOperation
    }
    change(&snapshot.operations[index])
    snapshot.operations[index].updatedAt = Date()
    try persist(snapshot)
    return snapshot.operations[index]
  }

  func inputURL(for operation: UploadOperation) throws -> URL {
    let expected =
      Self.ownerDirectoryName(operation.ownerUid) + "/"
      + operation.operationId.uuidString.lowercased() + "/input." + operation.input.extension
    guard operation.stagedRelativePath == expected, Self.validExtension(operation.input.extension)
    else {
      throw ProcessingStoreFailure.invalidPath
    }
    let url = stagingRoot.appendingPathComponent(expected).standardizedFileURL
    guard url.resolvingSymlinksInPath() == url else { throw ProcessingStoreFailure.invalidPath }
    return url
  }

  func multipartURL(for operation: UploadOperation, transferId: UUID) throws -> URL {
    try inputURL(for: operation).deletingLastPathComponent()
      .appendingPathComponent("upload-" + transferId.uuidString.lowercased() + ".multipart")
  }

  private static func validExtension(_ value: String) -> Bool {
    ["m4a", "mp4", "mp3", "aac", "ogg", "opus", "webm"].contains(value)
  }

  private var purgedOwners = Set<String>()

  func purge(ownerUid: String) throws {
    purgedOwners.insert(ownerUid)
    snapshots[ownerUid] = nil
    for directory in [
      fileURL(ownerUid).deletingLastPathComponent(),
      stagingRoot.appendingPathComponent(Self.ownerDirectoryName(ownerUid)),
    ] {
      if FileManager.default.fileExists(atPath: directory.path) {
        try FileManager.default.removeItem(at: directory)
      }
    }
  }

  private func load(_ owner: String) throws -> Snapshot {
    guard !purgedOwners.contains(owner) else { throw ProcessingStoreFailure.missingOperation }
    guard !owner.isEmpty else { throw ProcessingStoreFailure.invalidPath }
    if let snapshot = snapshots[owner] { return snapshot }
    let file = fileURL(owner)
    guard FileManager.default.fileExists(atPath: file.path) else {
      return Snapshot(version: 2, ownerUid: owner, operations: [], jobs: [])
    }
    do {
      var snapshot = try JSONDecoder().decode(Snapshot.self, from: Data(contentsOf: file))
      guard snapshot.version == 2, snapshot.ownerUid == owner,
        snapshot.operations.allSatisfy({ $0.ownerUid == owner }),
        (snapshot.retryIntents ?? []).allSatisfy({ $0.ownerUid == owner }),
        (snapshot.pipelines ?? []).allSatisfy({ $0.ownerUid == owner }),
        Set(snapshot.operations.map(\.operationId)).count == snapshot.operations.count
      else { throw ProcessingStoreFailure.corruptStore }
      snapshot.version = 2
      snapshots[owner] = snapshot
      return snapshot
    } catch { throw ProcessingStoreFailure.corruptStore }
  }

  private func persist(_ snapshot: Snapshot) throws {
    let directory = fileURL(snapshot.ownerUid).deletingLastPathComponent()
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      for var url in [root, directory] {
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)
      }
      try JSONEncoder().encode(snapshot).write(to: fileURL(snapshot.ownerUid), options: .atomic)
      snapshots[snapshot.ownerUid] = snapshot
    } catch { throw ProcessingStoreFailure.storage }
  }

  private func fileURL(_ owner: String) -> URL {
    root.appendingPathComponent(Self.ownerDirectoryName(owner), isDirectory: true)
      .appendingPathComponent("processing.json")
  }
}
