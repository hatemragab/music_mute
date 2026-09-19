import Foundation

struct ProcessingUsage: Decodable, Equatable, Sendable {
  struct Period: Decodable, Equatable, Sendable {
    let key: String
    let start: Date
    let end: Date
    let nextResetAt: Date
  }
  struct Processing: Decodable, Equatable, Sendable {
    let limitSeconds: Double
    let usedSeconds: Double
    let reservedSeconds: Double
    let releasedSeconds: Double
    let remainingSeconds: Double
  }
  struct Availability: Decodable, Equatable, Sendable {
    let status: String
    let reason: String?
  }
  let schemaVersion: Int
  let plan: String
  let policyRevision: Int
  let overrideRevision: Int?
  let effectivePolicySource: String
  let overrideExpiresAt: Date?
  let period: Period
  let processing: Processing
  let usageRevision: Int
  let activeJobs: Int
  let maxProcessingJobs: Int
  let availability: Availability
  let checkedAt: Date

  func validate() throws {
    let amounts = [
      processing.limitSeconds, processing.usedSeconds, processing.reservedSeconds,
      processing.releasedSeconds, processing.remainingSeconds,
    ]
    guard
      schemaVersion == 2, plan == "standard", policyRevision >= 0,
      overrideRevision.map({ $0 > 0 }) ?? true, usageRevision >= 0,
      ["global", "account_override"].contains(effectivePolicySource),
      amounts.allSatisfy({ $0.isFinite && $0 >= 0 }),
      processing.remainingSeconds <= processing.limitSeconds,
      activeJobs >= 0, maxProcessingJobs > 0, period.start < period.end,
      period.nextResetAt == period.end,
      ["available", "blocked"].contains(availability.status),
      [nil, "paused", "monthly_limit_reached", "active_job_limit"].contains(availability.reason),
      (availability.status == "available") == (availability.reason == nil)
    else { throw JobsFailure.malformedResponse }
  }
}

@MainActor final class ProcessingUsageRepository: ObservableObject {
  @Published private(set) var usage: ProcessingUsage?
  private let api: JobsAPI
  private var owner: String?
  private var receivedAt: Date?
  init(api: JobsAPI) { self.api = api }
  func bind(_ owner: String?) {
    self.owner = owner
    usage = nil
    receivedAt = nil
  }
  func refresh() async {
    guard let captured = owner else { return }
    do {
      let value = try await api.processingUsage()
      try value.validate()
      guard owner == captured else { return }
      usage = value
      receivedAt = Date()
    } catch { if owner == captured { usage = nil } }
  }
  func checkAvailability() throws {
    guard let usage, let receivedAt, abs(receivedAt.timeIntervalSinceNow) < 120 else { return }
    if usage.activeJobs >= usage.maxProcessingJobs {
      throw JobsFailure.conflict(code: "PROCESSING_LIMIT_REACHED")
    }
    if usage.processing.remainingSeconds <= 0 {
      throw JobsFailure.conflict(code: "PROCESSING_ALLOWANCE_EXHAUSTED")
    }
    switch usage.availability.reason {
    case "monthly_limit_reached":
      throw JobsFailure.conflict(code: "PROCESSING_ALLOWANCE_EXHAUSTED")
    case "active_job_limit":
      throw JobsFailure.conflict(code: "PROCESSING_LIMIT_REACHED")
    case "paused":
      throw JobsFailure.conflict(code: "PROCESSING_CAPACITY_UNAVAILABLE")
    default:
      break
    }
  }
}

enum ProcessingMediaMessage {
  static let serverCodes: Set<String> = [
    "MEDIA_TOO_LONG", "MEDIA_TOO_LARGE", "MEDIA_NO_AUDIO",
    "MEDIA_DEFAULT_TRACK_UNAVAILABLE", "MEDIA_UNSUPPORTED", "MEDIA_DURATION_UNKNOWN",
    "YOUTUBE_PLAYLIST_UNSUPPORTED", "YOUTUBE_LIVE_UNSUPPORTED", "PROCESSING_ALLOWANCE_EXHAUSTED",
    "PROCESSING_QUEUE_FULL", "PROCESSING_POLICY_INCOMPATIBLE", "PROCESSING_CAPACITY_UNAVAILABLE",
    "PROCESSING_LIMIT_REACHED",
  ]
  static func key(_ error: Error) -> String? {
    if case JobsFailure.conflict(let code) = error, let code, serverCodes.contains(code) {
      return "media_" + code.lowercased()
    }
    guard let error = error as? AudioInputPreparationError else { return nil }
    switch error {
    case .noAudio: return "media_media_no_audio"
    case .defaultTrackUnavailable: return "media_media_default_track_unavailable"
    case .durationUnknown: return "media_media_duration_unknown"
    case .tooLong: return "media_media_too_long"
    case .invalidSize: return "media_media_too_large"
    case .unsupportedFormat: return "media_media_unsupported"
    case .policyUnavailable: return "media_processing_policy_incompatible"
    case .youtubeLive: return "media_youtube_live_unsupported"
    case .youtubePlaylist: return "media_youtube_playlist_unsupported"
    case .youtubeMetadataUnavailable: return "media_youtube_metadata_unavailable"
    case .interrupted: return "media_interrupted"
    default: return nil
    }
  }
}
