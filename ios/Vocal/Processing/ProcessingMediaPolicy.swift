import CryptoKit
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

struct ProcessingPolicyResponse: Codable, Sendable {
  struct Limits: Codable, Sendable {
    let maxDurationSeconds: Double
    let maxPreparedAudioBytes: Int64
    let maxLocalSourceBytes: Int64?
    let maxPreparationSeconds: Double?
    let longJobThresholdSeconds: Double
  }
  struct Profile: Codable, Sendable {
    struct Conversion: Codable, Sendable {
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
  let revision: Int?
  let linkImportEnabled: Bool?
  let linkImportDisabledCountries: [String]?
  let visitorCountry: String?
  let linkImportVisible: Bool?
  let linkImportReason: String?
  let linkImportPolicyRevision: Int?

  var effectiveRevision: Int { linkImportPolicyRevision ?? revision ?? 0 }

  private enum CodingKeys: String, CodingKey {
    case schemaVersion, acceptNewJobs, acceptLongJobs, limits, preparationProfile, revision
    case linkImportEnabled, linkImportDisabledCountries, visitorCountry
    case linkImportVisible, linkImportReason, linkImportPolicyRevision
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    schemaVersion = try values.decode(Int.self, forKey: .schemaVersion)
    acceptNewJobs = try values.decode(Bool.self, forKey: .acceptNewJobs)
    acceptLongJobs = try values.decode(Bool.self, forKey: .acceptLongJobs)
    limits = try values.decode(Limits.self, forKey: .limits)
    preparationProfile = try values.decode(Profile.self, forKey: .preparationProfile)
    revision = try values.decodeIfPresent(Int.self, forKey: .revision)
    linkImportEnabled = try values.decodeIfPresent(Bool.self, forKey: .linkImportEnabled)
    linkImportDisabledCountries = try values.decodeIfPresent(
      [String].self, forKey: .linkImportDisabledCountries)
    visitorCountry = try values.decodeIfPresent(String.self, forKey: .visitorCountry)
    linkImportVisible = try values.decodeIfPresent(Bool.self, forKey: .linkImportVisible)
    linkImportReason = try values.decodeIfPresent(String.self, forKey: .linkImportReason)
    linkImportPolicyRevision = try values.decodeIfPresent(
      Int.self, forKey: .linkImportPolicyRevision)
  }

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

/// Guest and owner caches stay separate; visibility never participates in admission.
@MainActor final class ProcessingPolicyRepository {
  private(set) var value: ProcessingPolicyResponse?
  var onChange: (ProcessingPolicyResponse) async -> Void = { _ in }
  private let api: JobsAPI
  private let cacheFile: URL?
  private var owner: String?
  private var generation: UInt64 = 0
  private var checkoutSequence: UInt64 = 0
  private var snapshotSequence: UInt64 = 0
  private var live: Task<Void, Never>?

  init(api: JobsAPI, cacheFile: URL? = nil) {
    self.api = api
    self.cacheFile = cacheFile
    value = readCache()
  }

  private var scopedCacheFile: URL? {
    guard let cacheFile, let owner else { return cacheFile }
    let digest = SHA256.hash(data: Data(owner.utf8)).map { String(format: "%02x", $0) }.joined()
    return cacheFile.deletingLastPathComponent().appendingPathComponent("owner-\(digest).json")
  }

  private func readCache() -> ProcessingPolicyResponse? {
    guard let file = scopedCacheFile, let data = try? Data(contentsOf: file),
      data.count <= 256 * 1024,
      let response = try? JSONDecoder().decode(ProcessingPolicyResponse.self, from: data),
      (try? response.validated()) != nil
    else { return nil }
    return response
  }

  func bindOwner(_ owner: String?, watch: Bool = true) {
    generation &+= 1
    checkoutSequence &+= 1
    live?.cancel()
    live = nil
    if self.owner != owner {
      self.owner = owner
      value = readCache()
    }
    guard watch, owner != nil, let stream = api.watchProcessingPolicy() else { return }
    let captured = generation
    live = Task { [weak self] in
      do {
        for try await data in stream {
          guard let self, !Task.isCancelled, captured == self.generation else { return }
          guard
            let response = try? JSONDecoder.authDecoder().decode(
              ProcessingPolicyResponse.self, from: data),
            (try? response.validated()) != nil
          else { continue }
          guard self.accepts(response) else { continue }
          self.snapshotSequence &+= 1
          await self.apply(response)
        }
      } catch {
        // A failed stream keeps the last good policy; the shared socket reconnects itself.
      }
    }
  }

  func restoreCachedPolicy() async {
    if let value { await onChange(value) }
  }

  func checkout() async {
    checkoutSequence &+= 1
    let request = checkoutSequence
    let captured = generation
    let snapshots = snapshotSequence
    do {
      let response = try await api.processingPolicy()
      _ = try response.validated()
      guard !Task.isCancelled, captured == generation, request == checkoutSequence,
        accepts(response)
      else { return }
      // A snapshot received during this checkout wins at the same revision, including
      // country observations. A strictly newer checkout revision can still advance it.
      if snapshots != snapshotSequence,
        response.effectiveRevision <= (value?.effectiveRevision ?? 0)
      {
        return
      }
      await apply(response)
    } catch {
      // Offline reopen and invalid responses retain the installation's last good payload.
    }
  }

  private func accepts(_ response: ProcessingPolicyResponse) -> Bool {
    response.effectiveRevision >= (value?.effectiveRevision ?? 0)
  }

  private func apply(_ response: ProcessingPolicyResponse) async {
    value = response
    if let cacheFile = scopedCacheFile, let data = try? JSONEncoder().encode(response) {
      do {
        let directory = cacheFile.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var privateDirectory = directory
        var resources = URLResourceValues()
        resources.isExcludedFromBackup = true
        try privateDirectory.setResourceValues(resources)
        try data.write(
          to: cacheFile, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      } catch {
        // A cache write failure must not interrupt live policy application or existing work.
      }
    }
    await onChange(response)
  }

  deinit { live?.cancel() }
}
