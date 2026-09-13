import CryptoKit
import XCTest

@testable import Vocal

final class ProcessingMediaPolicyTests: XCTestCase {
  func testPolicyRejectsUnknownProfileAndAppliesLongJobPause() throws {
    let json = """
      {"schemaVersion":2,"acceptNewJobs":true,"acceptLongJobs":false,
       "limits":{"maxDurationSeconds":1800,"maxPreparedAudioBytes":100000000,
       "maxLocalSourceBytes":200000000,"maxPreparationSeconds":60,
       "longJobThresholdSeconds":600,"maxSourceDownloadBytes":80000000,
       "maxSourceDownloadSeconds":120},
       "preparationProfile":{"id":"preserve-or-aac-lc-256-v1","preserveCompatibleAudio":true,
       "fallbackConversion":{"codec":"aac-lc","outputContentType":"audio/mp4","targetBitrate":256000}}}
      """
    let response = try JSONDecoder().decode(ProcessingPolicyResponse.self, from: Data(json.utf8))
    XCTAssertEqual(try response.validated().maxDuration, 600)
    let unknown = json.replacingOccurrences(
      of: "preserve-or-aac-lc-256-v1", with: "unknown-profile")
    XCTAssertThrowsError(
      try JSONDecoder().decode(
        ProcessingPolicyResponse.self, from: Data(unknown.utf8)
      ).validated())
  }
  func testInclusivePreparedBoundaryAndLegacyExclusiveBoundary() {
    XCTAssertTrue(ProcessingMediaPolicy.expanded.accepts(bytes: 100_000_000, duration: 1800))
    XCTAssertFalse(ProcessingMediaPolicy.expanded.accepts(bytes: 100_000_001, duration: 1800))
    XCTAssertFalse(ProcessingMediaPolicy.expanded.accepts(bytes: 1, duration: 1800.001))
    XCTAssertFalse(ProcessingMediaPolicy.expanded.accepts(bytes: 1, duration: .nan))
    XCTAssertFalse(ProcessingMediaPolicy.legacy.accepts(bytes: 30_000_000, duration: 1))
    XCTAssertFalse(ProcessingMediaPolicy.legacy.accepts(bytes: 1, duration: 600))
  }
  func testPreparedUploadHonorsAcceptedVersionInsteadOfLegacyLimit() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let source = root.appendingPathComponent("audio.m4a")
    let data = Data([1, 2, 3])
    try data.write(to: source)
    let declaration = InputDeclaration(
      extension: "m4a", contentType: "audio/mp4", bytes: 3,
      durationSeconds: 1800, sha256: Data(SHA256.hash(data: data)).base64EncodedString())
    XCTAssertThrowsError(
      try S3MultipartFile.build(
        inputURL: source, declaration: declaration,
        destination: root.appendingPathComponent("legacy")))
    let result = try S3MultipartFile.build(
      inputURL: source, declaration: declaration,
      destination: root.appendingPathComponent("expanded"), policyVersion: 2)
    XCTAssertEqual(result.bytes, 3)
  }

  func testDefaultTrackDoesNotChooseFirstAndRejectsAmbiguity() throws {
    XCTAssertEqual(try MediaSourceInspector.selectTrack(ids: [7, 12], defaultID: 12), 12)
    XCTAssertEqual(try MediaSourceInspector.selectTrack(ids: [7], defaultID: nil), 7)
    XCTAssertThrowsError(try MediaSourceInspector.selectTrack(ids: [7, 12], defaultID: nil))
    XCTAssertThrowsError(try MediaSourceInspector.selectTrack(ids: [], defaultID: nil))
  }
  func testYouTubePreflightRejectsUnknownLiveAndOverLimit() throws {
    XCTAssertNoThrow(
      try YouTubePreflight.validate(duration: 1800, isLive: false, isUpcoming: false))
    XCTAssertThrowsError(
      try YouTubePreflight.validate(duration: nil, isLive: false, isUpcoming: false))
    XCTAssertThrowsError(
      try YouTubePreflight.validate(duration: 1800.001, isLive: false, isUpcoming: false))
    XCTAssertThrowsError(
      try YouTubePreflight.validate(duration: 1, isLive: true, isUpcoming: false))
    XCTAssertThrowsError(
      try YouTubePreflight.validate(duration: 1, isLive: false, isUpcoming: true))
    XCTAssertFalse(
      YouTubePreflight.isIndividualURL("https://youtube.com/watch?v=jNQXAC9IVRw&list=PL123"))
    XCTAssertTrue(YouTubePreflight.isIndividualURL("https://youtu.be/jNQXAC9IVRw"))
  }
}
