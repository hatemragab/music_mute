import Foundation

struct ProcessingMediaPolicy: Codable, Equatable, Sendable {
  let version: Int
  let maxDuration: Double
  let maxBytes: Int64
  let maxSourceBytes: Int64?
  let maxPreparationSeconds: Double?
  let profileID: String?

  static let standard = Self(
    version: 2, maxDuration: 1_200, maxBytes: 50_000_000,
    maxSourceBytes: 200_000_000, maxPreparationSeconds: 120,
    profileID: "audio-cap-aac-lc-160-v1")

  func accepts(bytes: Int64, duration: Double) -> Bool {
    bytes > 0 && duration.isFinite && duration > 0
      && bytes <= maxBytes && duration <= maxDuration
  }
}

struct ProcessingPolicyResponse: Decodable, Sendable {
  struct Limits: Decodable, Sendable {
    let maxDurationSeconds: Double
    let maxPreparedAudioBytes: Int64
    let maxLocalSourceBytes: Int64?
    let maxPreparationSeconds: Double?
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
      limits.maxDurationSeconds > 0,
      limits.maxDurationSeconds <= ProcessingMediaPolicy.standard.maxDuration,
      limits.maxPreparedAudioBytes > 0,
      limits.maxPreparedAudioBytes <= ProcessingMediaPolicy.standard.maxBytes,
      preparationProfile.id == "audio-cap-aac-lc-160-v1",
      preparationProfile.preserveCompatibleAudio,
      preparationProfile.fallbackConversion.codec == "aac-lc",
      preparationProfile.fallbackConversion.outputContentType == "audio/mp4",
      preparationProfile.fallbackConversion.targetBitrate == 160_000,
      limits.longJobThresholdSeconds.isFinite, limits.longJobThresholdSeconds > 0,
      limits.maxLocalSourceBytes.map({
        $0 > 0 && $0 <= ProcessingMediaPolicy.standard.maxSourceBytes!
      }) == true,
      limits.maxPreparationSeconds.map({
        $0.isFinite && $0 > 0
          && $0 <= ProcessingMediaPolicy.standard.maxPreparationSeconds!
      }) == true
    else { throw JobsFailure.malformedResponse }
    return ProcessingMediaPolicy(
      version: 2,
      maxDuration: acceptLongJobs
        ? limits.maxDurationSeconds
        : min(limits.maxDurationSeconds, limits.longJobThresholdSeconds),
      maxBytes: limits.maxPreparedAudioBytes,
      maxSourceBytes: limits.maxLocalSourceBytes,
      maxPreparationSeconds: limits.maxPreparationSeconds,
      profileID: preparationProfile.id)
  }
}
