import Foundation

struct ProcessingUsage: Decodable, Equatable, Sendable {
  struct Replenishment: Decodable, Equatable, Sendable {
    let at: Date
    let audioSeconds: Double
  }
  let policyRevision: Int
  let allowanceAudioSeconds: Double
  let usedAudioSeconds: Double
  let reservedAudioSeconds: Double
  let remainingAudioSeconds: Double
  let activeJobs: Int
  let maxActiveJobs: Int
  let nextReplenishmentAt: Date?
  let replenishments: [Replenishment]
  let availability: String
  let checkedAt: Date

  func validate() throws {
    guard
      [allowanceAudioSeconds, usedAudioSeconds, reservedAudioSeconds, remainingAudioSeconds]
        .allSatisfy({ $0.isFinite && $0 >= 0 }), activeJobs >= 0, maxActiveJobs > 0,
      remainingAudioSeconds <= allowanceAudioSeconds,
      ["available", "busy", "paused", "unavailable"].contains(availability),
      replenishments.count <= 100,
      replenishments.allSatisfy({ $0.audioSeconds.isFinite && $0.audioSeconds > 0 })
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
    if usage.activeJobs >= usage.maxActiveJobs {
      throw JobsFailure.conflict(code: "PROCESSING_LIMIT_REACHED")
    }
    if usage.remainingAudioSeconds <= 0 {
      throw JobsFailure.conflict(code: "PROCESSING_ALLOWANCE_EXHAUSTED")
    }
    if usage.availability == "busy" { throw JobsFailure.conflict(code: "PROCESSING_QUEUE_FULL") }
    if usage.availability != "available" {
      throw JobsFailure.conflict(code: "PROCESSING_CAPACITY_UNAVAILABLE")
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
