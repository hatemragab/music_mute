import Foundation

struct ProcessingMediaPolicy: Codable, Equatable, Sendable {
  let version: Int
  let maxDuration: Double
  let maxBytes: Int64
  let inclusive: Bool
  let maxSourceBytes: Int64?
  let maxPreparationSeconds: Double?
  let profileID: String?
  var maxSourceDownloadBytes: Int64? = nil
  var maxSourceDownloadSeconds: Double? = nil

  static let legacy = Self(
    version: 1, maxDuration: 600, maxBytes: 30_000_000,
    inclusive: false, maxSourceBytes: nil, maxPreparationSeconds: nil, profileID: nil)
  static let expanded = Self(
    version: 2, maxDuration: 1800, maxBytes: 100_000_000,
    inclusive: true, maxSourceBytes: nil, maxPreparationSeconds: nil,
    profileID: nil)

  func accepts(bytes: Int64, duration: Double) -> Bool {
    bytes > 0 && duration.isFinite && duration > 0
      && (inclusive
        ? bytes <= maxBytes && duration <= maxDuration : bytes < maxBytes && duration < maxDuration)
  }
}

struct ProcessingPolicyResponse: Decodable, Sendable {
  struct Limits: Decodable, Sendable {
    let maxDurationSeconds: Double
    let maxPreparedAudioBytes: Int64
    let maxLocalSourceBytes: Int64?
    let maxPreparationSeconds: Double?
    let maxSourceDownloadBytes: Int64?
    let maxSourceDownloadSeconds: Double?
    let longJobThresholdSeconds: Double
  }
  struct Profile: Decodable, Sendable {
    struct Conversion: Decodable, Sendable {
      let codec: String
      let outputContentType: String
      let targetBitrate: Int
    }
    let id: String
    let preserveCompatibleAudio: Bool
    let fallbackConversion: Conversion
  }
  let schemaVersion: Int
  let acceptNewJobs: Bool
  let acceptLongJobs: Bool
  let limits: Limits
  let preparationProfile: Profile

  func validated() throws -> ProcessingMediaPolicy {
    guard schemaVersion == 2, limits.maxDurationSeconds.isFinite,
      limits.maxDurationSeconds > 0, limits.maxDurationSeconds <= 1800,
      limits.maxPreparedAudioBytes > 0, limits.maxPreparedAudioBytes <= 100_000_000,
      preparationProfile.id == "preserve-or-aac-lc-256-v1",
      preparationProfile.preserveCompatibleAudio,
      preparationProfile.fallbackConversion.codec == "aac-lc",
      preparationProfile.fallbackConversion.outputContentType == "audio/mp4",
      preparationProfile.fallbackConversion.targetBitrate == 256_000,
      limits.longJobThresholdSeconds.isFinite, limits.longJobThresholdSeconds > 0,
      limits.maxLocalSourceBytes.map({ $0 > 0 }) ?? true,
      limits.maxPreparationSeconds.map({ $0.isFinite && $0 > 0 }) ?? true,
      limits.maxSourceDownloadBytes.map({ $0 > 0 }) ?? true,
      limits.maxSourceDownloadSeconds.map({ $0.isFinite && $0 > 0 }) ?? true
    else { throw JobsFailure.malformedResponse }
    return ProcessingMediaPolicy(
      version: 2,
      maxDuration: acceptLongJobs
        ? limits.maxDurationSeconds
        : min(limits.maxDurationSeconds, limits.longJobThresholdSeconds),
      maxBytes: limits.maxPreparedAudioBytes, inclusive: true,
      maxSourceBytes: limits.maxLocalSourceBytes,
      maxPreparationSeconds: limits.maxPreparationSeconds,
      profileID: preparationProfile.id,
      maxSourceDownloadBytes: limits.maxSourceDownloadBytes,
      maxSourceDownloadSeconds: limits.maxSourceDownloadSeconds)
  }
}
