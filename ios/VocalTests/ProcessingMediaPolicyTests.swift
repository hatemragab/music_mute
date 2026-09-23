import CryptoKit
import XCTest

@testable import Vocal

final class ProcessingMediaPolicyTests: XCTestCase {
  private let responseJSON = """
    {"schemaVersion":2,"acceptNewJobs":true,"acceptLongJobs":true,
     "limits":{"maxDurationSeconds":1200,"maxPreparedAudioBytes":50000000,
     "maxLocalSourceBytes":200000000,"maxPreparationSeconds":120,
     "longJobThresholdSeconds":600,"maxSourceDownloadBytes":50000000,
     "maxSourceDownloadSeconds":120},
     "preparationProfile":{"id":"audio-cap-aac-lc-160-v1","preserveCompatibleAudio":true,
     "fallbackConversion":{"codec":"aac-lc","outputContentType":"audio/mp4","targetBitrate":160000}}}
    """

  func testBackendPolicyValidatesWithoutExpandingOfflineCeilings() throws {
    let response = try JSONDecoder().decode(
      ProcessingPolicyResponse.self, from: Data(responseJSON.utf8))
    let policy = try response.validated()
    XCTAssertEqual(policy, .standard)

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
      try S3MultipartFile.build(
        inputURL: source, declaration: declaration,
        destination: root.appendingPathComponent("missing-version")))
    let result = try S3MultipartFile.build(
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

  func testYouTubePreflightUsesTheInclusiveStandardDuration() throws {
    XCTAssertNoThrow(
      try YouTubePreflight.validate(duration: 1_200, isLive: false, isUpcoming: false))
    XCTAssertThrowsError(
      try YouTubePreflight.validate(duration: nil, isLive: false, isUpcoming: false))
    XCTAssertThrowsError(
      try YouTubePreflight.validate(duration: 1_200.001, isLive: false, isUpcoming: false))
    XCTAssertThrowsError(
      try YouTubePreflight.validate(duration: 1, isLive: true, isUpcoming: false))
    XCTAssertThrowsError(
      try YouTubePreflight.validate(duration: 1, isLive: false, isUpcoming: true))
  }
}
