import CryptoKit
import XCTest

@testable import Vocal

final class ProcessingMediaPolicyTests: XCTestCase {
  private let responseJSON = """
    {"schemaVersion":2,"acceptNewJobs":true,"acceptLongJobs":true,
     "limits":{"maxDurationSeconds":1200,"maxPreparedAudioBytes":50000000,
     "maxLocalSourceBytes":200000000,"maxPreparationSeconds":120,
     "longJobThresholdSeconds":600},
     "preparationProfile":{"id":"audio-cap-aac-lc-160-v1","preserveCompatibleAudio":true,
     "fallbackConversion":{"codec":"aac-lc","outputContentType":"audio/mp4","targetBitrate":160000}}}
    """

  func testBackendPolicyValidatesWithoutExpandingOfflineCeilings() throws {
    let response = try JSONDecoder().decode(
      ProcessingPolicyResponse.self, from: Data(responseJSON.utf8))
    let policy = try response.validated()
    XCTAssertEqual(policy, .standard)
    XCTAssertNil(response.linkImportVisible)
    XCTAssertNil(response.linkImportPolicyRevision)

    let expanded = responseJSON.replacingOccurrences(
      of: "\"maxPreparedAudioBytes\":50000000",
      with: "\"maxPreparedAudioBytes\":50000001")
    XCTAssertThrowsError(
      try JSONDecoder().decode(
        ProcessingPolicyResponse.self, from: Data(expanded.utf8)
      ).validated())
  }

  func testUnknownProfileAndVersionAreRejected() throws {
    let unknownProfile = responseJSON.replacingOccurrences(
      of: "audio-cap-aac-lc-160-v1", with: "unknown-profile")
    XCTAssertThrowsError(
      try JSONDecoder().decode(
        ProcessingPolicyResponse.self, from: Data(unknownProfile.utf8)
      ).validated())
    let unknownVersion = responseJSON.replacingOccurrences(
      of: "\"schemaVersion\":2", with: "\"schemaVersion\":1")
    XCTAssertThrowsError(
      try JSONDecoder().decode(
        ProcessingPolicyResponse.self, from: Data(unknownVersion.utf8)
      ).validated())
  }

  func testInclusivePreparedBoundaries() {
    XCTAssertTrue(ProcessingMediaPolicy.standard.accepts(bytes: 49_999_999, duration: 1_199.999))
    XCTAssertTrue(ProcessingMediaPolicy.standard.accepts(bytes: 50_000_000, duration: 1_200))
    XCTAssertFalse(ProcessingMediaPolicy.standard.accepts(bytes: 50_000_001, duration: 1_200))
    XCTAssertFalse(ProcessingMediaPolicy.standard.accepts(bytes: 1, duration: 1_200.001))
    XCTAssertFalse(ProcessingMediaPolicy.standard.accepts(bytes: 1, duration: .nan))
  }

  func testPreparedUploadRequiresTheStandardPolicyVersion() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let source = root.appendingPathComponent("audio.m4a")
    let data = Data([1, 2, 3])
    try data.write(to: source)
    let declaration = InputDeclaration(
      extension: "m4a", contentType: "audio/mp4", bytes: 3,
      durationSeconds: 1_200, sha256: Data(SHA256.hash(data: data)).base64EncodedString())
    XCTAssertThrowsError(
      try ObjectStorageUploadFile.build(
        inputURL: source, declaration: declaration,
        destination: root.appendingPathComponent("missing-version")))
    let result = try ObjectStorageUploadFile.build(
      inputURL: source, declaration: declaration,
      destination: root.appendingPathComponent("standard"), policyVersion: 2)
    XCTAssertEqual(result.bytes, 3)
  }

  func testDefaultTrackDoesNotChooseFirstAndRejectsAmbiguity() throws {
    XCTAssertEqual(try MediaSourceInspector.selectTrack(ids: [7, 12], defaultID: 12), 12)
    XCTAssertEqual(try MediaSourceInspector.selectTrack(ids: [7], defaultID: nil), 7)
    XCTAssertThrowsError(try MediaSourceInspector.selectTrack(ids: [7, 12], defaultID: nil))
    XCTAssertThrowsError(try MediaSourceInspector.selectTrack(ids: [], defaultID: nil))
  }

  func testNativeVisibilityFieldsDecodeFromSnakeCaseWireWithoutChangingMediaLimits() throws {
    let payload = try policyFixture(visible: true, revision: 4, country: "US")
    let wire = try XCTUnwrap(ApiWireJSON.request(JSONEncoder().encode(payload)))
    let decoded = try JSONDecoder.authDecoder().decode(
      ProcessingPolicyResponse.self, from: ApiWireJSON.response(wire))
    XCTAssertEqual(decoded.linkImportEnabled, true)
    XCTAssertEqual(decoded.linkImportDisabledCountries, ["EG"])
    XCTAssertEqual(decoded.visitorCountry, "US")
    XCTAssertEqual(decoded.linkImportVisible, true)
    XCTAssertEqual(decoded.linkImportReason, "allowed")
    XCTAssertEqual(decoded.linkImportPolicyRevision, 4)
    XCTAssertEqual(try decoded.validated(), .standard)
  }

}

@MainActor final class ProcessingPolicyCacheTests: XCTestCase {
  func testGuestAndOwnerCachesNeverShareVisibilityOrRevision() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let cache = root.appendingPathComponent("Policy/policy.json")
    let api = PolicyJobsFixture()
    let repository = ProcessingPolicyRepository(api: api, cacheFile: cache)
    api.checkout = { try policyFixture(visible: true, revision: 3) }
    await repository.checkout()
    repository.bindOwner("hidden/owner")
    XCTAssertNil(repository.value)
    api.checkout = { try policyFixture(visible: false, revision: 9) }
    await repository.checkout()
    repository.bindOwner("visible-owner")
    XCTAssertNil(repository.value)
    api.checkout = { try policyFixture(visible: true, revision: 4) }
    await repository.checkout()
    repository.bindOwner("hidden/owner")
    XCTAssertEqual(repository.value?.linkImportVisible, false)
    XCTAssertEqual(repository.value?.effectiveRevision, 9)
    repository.bindOwner("visible-owner")
    XCTAssertEqual(repository.value?.linkImportVisible, true)
    XCTAssertEqual(repository.value?.effectiveRevision, 4)
    repository.bindOwner(nil)
    XCTAssertEqual(repository.value?.linkImportVisible, true)
    XCTAssertEqual(repository.value?.effectiveRevision, 3)
    let reopened = ProcessingPolicyRepository(api: api, cacheFile: cache)
    reopened.bindOwner("hidden/owner")
    api.checkout = { throw AuthFailure.offline }
    await reopened.checkout()
    XCTAssertEqual(reopened.value?.linkImportVisible, false)
    reopened.bindOwner("new-owner")
    XCTAssertNil(reopened.value)
    reopened.bindOwner(nil)
    XCTAssertEqual(reopened.value?.linkImportVisible, true)
  }

  func testCurrentLegacyPayloadHidesVisibleCacheAndOlderPayloadIsIgnored() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let cache = root.appendingPathComponent("Policy/policy.json")
    let api = PolicyJobsFixture()
    api.checkout = { try policyFixture(visible: true, revision: 7) }
    let initial = ProcessingPolicyRepository(api: api, cacheFile: cache)
    await initial.checkout()
    let reopened = ProcessingPolicyRepository(api: api, cacheFile: cache)
    XCTAssertEqual(reopened.value?.linkImportVisible, true)
    var legacy = try XCTUnwrap(
      JSONSerialization.jsonObject(
        with: JSONEncoder().encode(policyFixture(visible: false, revision: 7))) as? [String: Any])
    for key in legacy.keys.filter({ $0.hasPrefix("linkImport") }) {
      legacy.removeValue(forKey: key)
    }
    legacy["revision"] = 6
    let older = try JSONDecoder().decode(
      ProcessingPolicyResponse.self, from: JSONSerialization.data(withJSONObject: legacy))
    api.checkout = { older }
    await reopened.checkout()
    XCTAssertEqual(reopened.value?.linkImportVisible, true)
    legacy["revision"] = 7
    let current = try JSONDecoder().decode(
      ProcessingPolicyResponse.self, from: JSONSerialization.data(withJSONObject: legacy))
    api.checkout = { current }
    await reopened.checkout()
    XCTAssertNotEqual(reopened.value?.linkImportVisible, true)
    XCTAssertEqual(reopened.value?.effectiveRevision, 7)
    let cached = try JSONDecoder().decode(
      ProcessingPolicyResponse.self, from: Data(contentsOf: cache))
    XCTAssertNotEqual(cached.linkImportVisible, true)
    XCTAssertEqual(cached.revision, 7)
  }

  func testFreshOfflineLaunchHidesAndLastGoodPayloadSurvivesOfflineRelaunch() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let cache = root.appendingPathComponent("Policy/policy.json")
    let api = PolicyJobsFixture()
    let fresh = ProcessingPolicyRepository(api: api, cacheFile: cache)
    XCTAssertNil(fresh.value)
    await fresh.checkout()
    XCTAssertNil(fresh.value)
    api.checkout = { try policyFixture(visible: true, revision: 8) }
    await fresh.checkout()
    XCTAssertEqual(fresh.value?.linkImportVisible, true)
    XCTAssertTrue(FileManager.default.fileExists(atPath: cache.path))
    XCTAssertEqual(
      try cache.deletingLastPathComponent().resourceValues(forKeys: [.isExcludedFromBackupKey])
        .isExcludedFromBackup, true)
    api.checkout = { throw AuthFailure.offline }
    let restarted = ProcessingPolicyRepository(api: api, cacheFile: cache)
    await restarted.checkout()
    XCTAssertEqual(restarted.value?.linkImportVisible, true)
    XCTAssertEqual(restarted.value?.linkImportPolicyRevision, 8)
    XCTAssertEqual(try restarted.value?.validated(), .standard)
  }

  func testPolicySnapshotsChangeVisibilityAndRejectOlderAndMalformedPayloads() async throws {
    let api = PolicyJobsFixture()
    let repository = ProcessingPolicyRepository(api: api)
    repository.bindOwner("owner")
    try api.push(visible: true, revision: 3)
    await settle()
    XCTAssertEqual(repository.value?.linkImportVisible, true)
    try api.push(visible: false, revision: 4)
    await settle()
    XCTAssertEqual(repository.value?.linkImportVisible, false)
    try api.push(visible: true, revision: 3)
    api.continuations.last?.yield(Data("{}".utf8))
    await settle()
    XCTAssertEqual(repository.value?.linkImportVisible, false)
    try api.push(visible: true, revision: 5)
    await settle()
    XCTAssertEqual(repository.value?.linkImportVisible, true)
    repository.bindOwner(nil)
  }

  func testSlowCheckoutCannotReplaceNewerSnapshotOrItsCountryDecision() async throws {
    let api = PolicyJobsFixture()
    let repository = ProcessingPolicyRepository(api: api)
    repository.bindOwner("owner")
    var pending: CheckedContinuation<ProcessingPolicyResponse, Error>?
    api.checkout = { try await withCheckedThrowingContinuation { pending = $0 } }
    let request = Task { await repository.checkout() }
    await settle()
    XCTAssertNotNil(pending)
    try api.push(visible: false, revision: 6, country: "EG")
    await settle()
    pending?.resume(returning: try policyFixture(visible: true, revision: 6, country: "US"))
    await request.value
    XCTAssertEqual(repository.value?.linkImportVisible, false)
    XCTAssertEqual(repository.value?.visitorCountry, "EG")
    // A later foreground checkout can observe a new country at the same revision.
    api.checkout = { try policyFixture(visible: true, revision: 6, country: "US") }
    await repository.checkout()
    XCTAssertEqual(repository.value?.linkImportVisible, true)
    XCTAssertEqual(repository.value?.visitorCountry, "US")
    repository.bindOwner(nil)
  }

  func testOwnerChangeFencesAnOldCheckoutAndSubscription() async throws {
    let api = PolicyJobsFixture()
    let repository = ProcessingPolicyRepository(api: api)
    repository.bindOwner("first")
    var pending: CheckedContinuation<ProcessingPolicyResponse, Error>?
    api.checkout = { try await withCheckedThrowingContinuation { pending = $0 } }
    let request = Task { await repository.checkout() }
    await settle()
    repository.bindOwner("second")
    api.continuations.first?.yield(
      try JSONEncoder().encode(policyFixture(visible: true, revision: 20)))
    try api.push(visible: false, revision: 2)
    await settle()
    pending?.resume(returning: try policyFixture(visible: true, revision: 20))
    await request.value
    XCTAssertEqual(repository.value?.linkImportVisible, false)
    XCTAssertEqual(repository.value?.linkImportPolicyRevision, 2)
    repository.bindOwner(nil)
  }

  func testNewestCheckoutWinsWhenRequestsFinishOutOfOrder() async throws {
    let api = PolicyJobsFixture()
    let repository = ProcessingPolicyRepository(api: api)
    var pending: [CheckedContinuation<ProcessingPolicyResponse, Error>] = []
    api.checkout = { try await withCheckedThrowingContinuation { pending.append($0) } }
    let first = Task { await repository.checkout() }
    await settle()
    let second = Task { await repository.checkout() }
    await settle()
    XCTAssertEqual(pending.count, 2)
    guard pending.count == 2 else { return }
    pending[1].resume(returning: try policyFixture(visible: false, revision: 3))
    await second.value
    pending[0].resume(returning: try policyFixture(visible: true, revision: 3))
    await first.value
    XCTAssertEqual(repository.value?.linkImportVisible, false)
  }

  private func settle() async {
    for _ in 0..<200 { await Task.yield() }
  }
}

private func policyFixture(visible: Bool, revision: Int, country: String = "US") throws
  -> ProcessingPolicyResponse
{
  let payload = """
    {"schemaVersion":2,"acceptNewJobs":true,"acceptLongJobs":true,
    "limits":{"maxDurationSeconds":1200,"maxPreparedAudioBytes":50000000,
    "maxLocalSourceBytes":200000000,"maxPreparationSeconds":120,"longJobThresholdSeconds":600},
    "preparationProfile":{"id":"audio-cap-aac-lc-160-v1","preserveCompatibleAudio":true,
    "fallbackConversion":{"codec":"aac-lc","outputContentType":"audio/mp4","targetBitrate":160000}},
    "linkImportEnabled":true,"linkImportDisabledCountries":["EG"],"visitorCountry":"\(country)",
    "linkImportVisible":\(visible),"linkImportReason":"\(visible ? "allowed" : "country_hidden")",
    "linkImportPolicyRevision":\(revision)}
    """
  return try JSONDecoder().decode(ProcessingPolicyResponse.self, from: Data(payload.utf8))
}

@MainActor private final class PolicyJobsFixture: JobsAPI {
  var checkout: () async throws -> ProcessingPolicyResponse = { throw AuthFailure.offline }
  var continuations: [AsyncThrowingStream<Data, Error>.Continuation] = []
  func processingPolicy() async throws -> ProcessingPolicyResponse { try await checkout() }
  func watchProcessingPolicy() -> AsyncThrowingStream<Data, Error>? {
    AsyncThrowingStream { continuations.append($0) }
  }
  func push(visible: Bool, revision: Int, country: String = "US") throws {
    continuations.last?.yield(
      try JSONEncoder().encode(
        policyFixture(visible: visible, revision: revision, country: country)))
  }
  func create(requestId: UUID, input: InputDeclaration) async throws -> CreateReservation {
    throw JobsFailure.notFound
  }
  func renewUpload(id: String) async throws -> UploadGrant { throw JobsFailure.notFound }
  func confirmUpload(id: String) async throws -> JobMutation { throw JobsFailure.notFound }
  func list(cursor: String?, status: String?) async throws -> JobPage { throw JobsFailure.notFound }
  func detail(id: String) async throws -> Job { throw JobsFailure.notFound }
  func cancel(id: String) async throws -> JobMutation { throw JobsFailure.notFound }
  func retry(id: String, requestId: UUID) async throws -> JobMutation { throw JobsFailure.notFound }
  func download(id: String, artifact: String) async throws -> DownloadGrant {
    throw JobsFailure.notFound
  }
}
