import XCTest

@testable import Vocal

final class ProcessingUsageRepositoryTests: XCTestCase {
  func testMonthlySnapshotSeparatesReservedFromUsedAndPreservesReset() throws {
    let json =
      #"{"schemaVersion":2,"plan":"standard","policyRevision":2,"overrideRevision":null,"effectivePolicySource":"global","overrideExpiresAt":null,"period":{"key":"2026-09","start":"2026-09-01T00:00:00Z","end":"2026-10-01T00:00:00Z","nextResetAt":"2026-10-01T00:00:00Z"},"processing":{"limitSeconds":7200,"usedSeconds":900,"reservedSeconds":600,"releasedSeconds":300,"remainingSeconds":5700},"uploads":{"dailyGrantLimit":30,"dailyGrants":1,"dailyRemainingGrants":29,"dailyResetAt":"2026-09-14T00:00:00Z","monthlyGrantLimit":200,"monthlyGrants":10,"monthlyRemainingGrants":190,"monthlyByteLimit":1000000000,"confirmedBytes":50000000,"monthlyRemainingBytes":950000000,"monthlyResetAt":"2026-10-01T00:00:00Z"},"storage":{"limitBytes":1000000000,"retainedBytes":100000000,"remainingBytes":900000000},"effectiveLimits":{"maxDurationSeconds":1200,"maxPreparedAudioBytes":50000000,"maxClientInputAttempts":5,"signedUrlTtlSeconds":600},"downloads":{"monthlyGrantLimit":150,"monthlyGrants":5,"monthlyRemainingGrants":145,"monthlyByteLimit":10000000000,"estimatedBytes":250000000,"monthlyRemainingBytes":9750000000,"monthlyResetAt":"2026-10-01T00:00:00Z"},"usageRevision":4,"waitingJobs":0,"maxWaitingJobs":3,"processingJobs":1,"maxProcessingJobs":1,"availability":{"status":"available","reason":null},"checkedAt":"2026-09-13T12:00:00Z"}"#
    let usage = try JSONDecoder.authDecoder().decode(ProcessingUsage.self, from: Data(json.utf8))
    try usage.validate()
    XCTAssertEqual(usage.processing.reservedSeconds, 600)
    XCTAssertEqual(usage.processing.usedSeconds, 900)
    XCTAssertEqual(usage.processing.releasedSeconds, 300)
    XCTAssertEqual(usage.processing.remainingSeconds, 5700)
    XCTAssertEqual(usage.uploads.monthlyGrants, 10)
    XCTAssertEqual(usage.downloads.estimatedBytes, 250_000_000)
    XCTAssertEqual(usage.storage.retainedBytes, 100_000_000)
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
