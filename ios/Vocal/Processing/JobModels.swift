import Foundation

struct InputDeclaration: Codable, Equatable, Sendable {
  let `extension`: String
  let contentType: String
  let bytes: Int64
  let durationSeconds: Double
  let sha256: String
}

enum JobSourceKind: String, Codable, Equatable, Sendable { case url, file }

struct JobSourceMetadata: Codable, Equatable, Sendable {
  let trimEnabled: Bool
  let policyVersion: Int?
  let preparationProfileId: String?
  let source: String?
  let sourceTitle: String?
  let sourceKind: JobSourceKind?
  let clientStartedAt: Date?
  let sourceURL: String?

  init(
    sourceTitle: String? = nil, sourceKind: JobSourceKind? = nil,
    clientStartedAt: Date? = nil, sourceURL: String? = nil,
    policyVersion: Int? = nil, preparationProfileId: String? = nil, source: String? = nil,
    trimEnabled: Bool = true
  ) {
    self.trimEnabled = trimEnabled
    self.policyVersion = policyVersion
    self.preparationProfileId = preparationProfileId
    self.source = source
    self.sourceTitle = sourceTitle
    self.sourceKind = sourceKind
    self.clientStartedAt = clientStartedAt
    self.sourceURL = sourceURL
  }
}

struct ServerStageMeasurement: Codable, Equatable, Sendable {
  let stage: String
  let durationMs: Int64
  let complete: Bool
}

struct ServerStageTimings: Codable, Equatable, Sendable {
  let totalMs: Int64?
  let totalComplete: Bool
  let stages: [ServerStageMeasurement]
}

struct JobTiming: Codable, Equatable, Sendable {
  let processingElapsedMs: Int64?
  let processingElapsedApproximate: Bool
  let totalElapsedMs: Int64?
  let totalElapsedApproximate: Bool
}

struct JobStages: Codable, Equatable, Sendable {
  let validatingAt: Date?
  let processingStartedAt: Date?
  let processingFinishedAt: Date?
  let uploadingResultAt: Date?
}

enum JobThumbnailURL {
  static func validated(_ value: String?) -> URL? {
    guard let value, value.utf8.count <= 2048,
      value.unicodeScalars.allSatisfy({ (33...126).contains($0.value) }),
      !value.contains("\\"), !value.contains("#"),
      let components = URLComponents(string: value), components.scheme == "https",
      components.host == "i.ytimg.com", components.user == nil, components.password == nil,
      components.port == nil, components.fragment == nil,
      components.percentEncodedPath.range(
        of: #"^/vi(?:_webp)?/[A-Za-z0-9_-]{11}/[A-Za-z0-9_-]{1,64}\.(?:jpg|webp)$"#,
        options: .regularExpression) != nil
    else { return nil }
    let parameters = components.queryItems ?? []
    guard parameters.count <= 2 else { return nil }
    var names: Set<String> = []
    for parameter in parameters {
      guard ["sqp", "rs"].contains(parameter.name), names.insert(parameter.name).inserted,
        let field = parameter.value,
        field.range(of: #"^[A-Za-z0-9_-]{1,1024}={0,2}$"#, options: .regularExpression) != nil
      else { return nil }
    }
    return URL(string: value)
  }
}

@propertyWrapper struct NullableJobThumbnail: Codable, Equatable, Sendable {
  var wrappedValue: String?

  init(wrappedValue: String?) {
    self.wrappedValue = JobThumbnailURL.validated(wrappedValue)?.absoluteString
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    self.init(wrappedValue: try? container.decode(String.self))
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(wrappedValue)
  }
}

extension KeyedDecodingContainer {
  func decode(_ type: NullableJobThumbnail.Type, forKey key: Key) throws -> NullableJobThumbnail {
    try decodeIfPresent(type, forKey: key) ?? NullableJobThumbnail(wrappedValue: nil)
  }
}

struct Job: Codable, Equatable, Identifiable, Sendable {
  var trimEnabled: Bool? = nil
  var comparisonRanges: [[Int64]]? = nil
  struct Input: Codable, Equatable, Sendable {
    let `extension`: String
    let bytes: Int64
    let durationSeconds: Double
  }
  struct Failure: Codable, Equatable, Sendable {
    let code: String
    let at: Date
  }
  let id: String
  // An unknown server state is retained so consumers can render it read-only.
  let status: String
  let createdAt: Date
  let updatedAt: Date
  let queuedAt: Date?
  let finishedAt: Date?
  let retryOfJobId: String?
  let input: Input
  let error: Failure?
  let canDownloadInput: Bool
  let canDownloadOutput: Bool
  let workerAvailable: Bool?
  let requestId: String?
  let sourceTitle: String?
  let displayName: String?
  let sourceKind: JobSourceKind?
  let serverTime: Date?
  let timing: JobTiming?
  let serverStageTimings: ServerStageTimings?
  let stages: JobStages?
  let queue: ProcessingQueue?
  let processingProgress: ProcessingProgress?
  @NullableJobThumbnail private(set) var thumbnailUrl: String? = nil

  init(
    id: String, status: String, createdAt: Date, updatedAt: Date, queuedAt: Date?,
    finishedAt: Date?, retryOfJobId: String?, input: Input, error: Failure?,
    canDownloadInput: Bool, canDownloadOutput: Bool, workerAvailable: Bool?,
    requestId: String? = nil, sourceTitle: String? = nil, displayName: String? = nil,
    sourceKind: JobSourceKind? = nil, serverTime: Date? = nil, timing: JobTiming? = nil,
    stages: JobStages? = nil, queue: ProcessingQueue? = nil,
    processingProgress: ProcessingProgress? = nil,
    serverStageTimings: ServerStageTimings? = nil, thumbnailUrl: String? = nil
  ) {
    self.id = id
    self.status = status
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.queuedAt = queuedAt
    self.finishedAt = finishedAt
    self.retryOfJobId = retryOfJobId
    self.input = input
    self.error = error
    self.canDownloadInput = canDownloadInput
    self.canDownloadOutput = canDownloadOutput
    self.workerAvailable = workerAvailable
    self.requestId = requestId
    self.sourceTitle = sourceTitle
    self.displayName = displayName
    self.sourceKind = sourceKind
    self.serverTime = serverTime
    self.timing = timing
    self.serverStageTimings = serverStageTimings
    self.stages = stages
    self.queue = queue
    self.processingProgress = processingProgress
    self.thumbnailUrl = JobThumbnailURL.validated(thumbnailUrl)?.absoluteString
  }

  var thumbnailURL: URL? { JobThumbnailURL.validated(thumbnailUrl) }

  var preferredName: String {
    let value = displayName ?? sourceTitle
    return value?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
      ? value! : String(localized: "processing_untitled")
  }
}

struct ProcessingQueue: Codable, Equatable, Sendable {
  let state: String
  let position: Int?
  let jobsAhead: Int?
  let reason: String?
  let asOf: Date
}

struct ProcessingProgress: Codable, Equatable, Sendable {
  let phase: String
  let phasePercent: Double?
  let stale: Bool
}

struct JobPage: Codable, Equatable, Sendable {
  let items: [Job]
  let nextCursor: String?
}

enum UploadMethod: String, Codable, Equatable, Sendable { case put = "PUT" }

struct UploadGrant: Codable, Equatable, Sendable {
  let method: UploadMethod
  let url: URL
  let headers: [String: String]
  let expiresAt: Date
}

struct DownloadGrant: Codable, Equatable, Sendable {
  let url: URL
  let expiresAt: Date
}

struct CreateReservation: Codable, Equatable, Sendable {
  let id: String
  let status: String
  let upload: UploadGrant?
  let requestId: String?

  init(id: String, status: String, upload: UploadGrant?, requestId: String? = nil) {
    self.id = id
    self.status = status
    self.upload = upload
    self.requestId = requestId
  }
}

struct JobMutation: Codable, Equatable, Sendable {
  let id: String
  let status: String
  let retryOfJobId: String?
}

enum JobsFailure: Error, Equatable, Sendable {
  case invalidInput
  case installationRequired
  case forbidden(code: String?)
  case notFound
  case conflict(code: String?)
  case rateLimited(retryAfter: TimeInterval)
  case serviceUnavailable
  case redirectRejected
  case malformedResponse
}

enum ClientErrorStage: String, Codable, CaseIterable, Sendable {
  case unknown = "UNKNOWN"
  case sourceIntake = "SOURCE_INTAKE"
  case downloadingSource = "DOWNLOADING_SOURCE"
  case preparingInput = "PREPARING_INPUT"
  case reservingJob = "RESERVING_JOB"
  case uploadingInput = "UPLOADING_INPUT"
  case confirmingUpload = "CONFIRMING_UPLOAD"
  case refreshingJob = "REFRESHING_JOB"
  case cancelling = "CANCELLING"
  case retrying = "RETRYING"
  case fetchingOutput = "FETCHING_OUTPUT"
  case playback = "PLAYBACK"
  case exporting = "EXPORTING"
}

enum ClientErrorCode: String, Codable, CaseIterable, Sendable {
  case unknown = "UNKNOWN"
  case network = "NETWORK"
  case timeout = "TIMEOUT"
  case authentication = "AUTHENTICATION"
  case invalidMedia = "INVALID_MEDIA"
  case sourceUnavailable = "SOURCE_UNAVAILABLE"
  case storage = "STORAGE"
  case server = "SERVER"
  case jobNotFound = "JOB_NOT_FOUND"
  case jobConflict = "JOB_CONFLICT"
  case checksumMismatch = "CHECKSUM_MISMATCH"
  case localIO = "LOCAL_IO"
}

enum ClientPlatform: String, Codable, Sendable { case ios, android }

struct ClientErrorEvent: Codable, Equatable, Identifiable, Sendable {
  var id: UUID { eventId }
  let eventId: UUID
  let operationId: UUID
  let jobId: String?
  let stage: ClientErrorStage
  let code: ClientErrorCode
  let retryable: Bool
  let platform: ClientPlatform
  let appVersion: String
  let osVersion: String
  let occurredAt: Date
  let httpStatus: Int?
}

struct ClientErrorReceipt: Codable, Equatable, Sendable { let eventId: String }
