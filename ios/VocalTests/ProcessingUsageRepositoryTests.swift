import XCTest

@testable import Vocal

final class ProcessingUsageRepositoryTests: XCTestCase {
  func testRollingSnapshotSeparatesReservedFromUsedAndPreservesReplenishments() throws {
    let json =
      #"{"policyRevision":2,"allowanceAudioSeconds":3600,"usedAudioSeconds":900,"reservedAudioSeconds":600,"remainingAudioSeconds":2100,"activeJobs":1,"maxActiveJobs":1,"nextReplenishmentAt":"2026-09-14T11:00:00Z","replenishments":[{"at":"2026-09-14T11:00:00Z","audioSeconds":300},{"at":"2026-09-14T12:00:00Z","audioSeconds":600}],"availability":"available","checkedAt":"2026-09-13T12:00:00Z"}"#
    let usage = try JSONDecoder.authDecoder().decode(ProcessingUsage.self, from: Data(json.utf8))
    try usage.validate()
    XCTAssertEqual(usage.reservedAudioSeconds, 600)
    XCTAssertEqual(usage.usedAudioSeconds, 900)
    XCTAssertEqual(usage.replenishments.count, 2)
    XCTAssertEqual(usage.remainingAudioSeconds, 2100)
    XCTAssertThrowsError(
      try JSONDecoder.authDecoder().decode(
        ProcessingUsage.self, from: Data(json.replacingOccurrences(of: "2100", with: "9999").utf8)
      ).validate())
  }
  func testAdmissionMessagesAreStableAndNotRetryableRateLimits() {
    for code in ProcessingMediaMessage.serverCodes {
      XCTAssertEqual(
        processingErrorKey(JobsFailure.conflict(code: code)), "media_" + code.lowercased())
    }
  }
}
