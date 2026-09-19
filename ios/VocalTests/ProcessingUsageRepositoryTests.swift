import XCTest

@testable import Vocal

final class ProcessingUsageRepositoryTests: XCTestCase {
  func testMonthlySnapshotSeparatesReservedFromUsedAndPreservesReset() throws {
    let json =
      #"{"schemaVersion":2,"plan":"standard","policyRevision":2,"overrideRevision":null,"effectivePolicySource":"global","overrideExpiresAt":null,"period":{"key":"2026-09","start":"2026-09-01T00:00:00Z","end":"2026-10-01T00:00:00Z","nextResetAt":"2026-10-01T00:00:00Z"},"processing":{"limitSeconds":7200,"usedSeconds":900,"reservedSeconds":600,"releasedSeconds":300,"remainingSeconds":5700},"usageRevision":4,"activeJobs":0,"maxProcessingJobs":1,"availability":{"status":"available","reason":null},"checkedAt":"2026-09-13T12:00:00Z"}"#
    let usage = try JSONDecoder.authDecoder().decode(ProcessingUsage.self, from: Data(json.utf8))
    try usage.validate()
    XCTAssertEqual(usage.processing.reservedSeconds, 600)
    XCTAssertEqual(usage.processing.usedSeconds, 900)
    XCTAssertEqual(usage.processing.releasedSeconds, 300)
    XCTAssertEqual(usage.processing.remainingSeconds, 5700)
    XCTAssertEqual(usage.period.nextResetAt, usage.period.end)
    XCTAssertThrowsError(
      try JSONDecoder.authDecoder().decode(
        ProcessingUsage.self, from: Data(json.replacingOccurrences(of: "5700", with: "9999").utf8)
      ).validate())
  }
  func testAdmissionMessagesAreStableAndNotRetryableRateLimits() {
    for code in ProcessingMediaMessage.serverCodes {
      XCTAssertEqual(
        processingErrorKey(JobsFailure.conflict(code: code)), "media_" + code.lowercased())
    }
  }
}
