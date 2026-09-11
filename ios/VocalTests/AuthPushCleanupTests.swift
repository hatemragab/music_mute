import XCTest

@testable import Vocal

@MainActor final class AuthPushCleanupTests: XCTestCase {
  func testOldIdentitySurvivesCleanupThenClears() async {
    var identity: String? = "old-owner"
    await performBoundedSignOutCleanup(
      before: {
        XCTAssertEqual(identity, "old-owner")
        await Task.yield()
        XCTAssertEqual(identity, "old-owner")
      }, clearIdentity: { identity = nil })
    XCTAssertNil(identity)
  }

  func testOfflineAndTimeoutNeverPreventClearingIdentity() async {
    var cleared = false
    await performBoundedSignOutCleanup(
      before: { throw AuthFailure.offline }, clearIdentity: { cleared = true })
    XCTAssertTrue(cleared)
    cleared = false
    await performBoundedSignOutCleanup(
      before: { try await Task.sleep(nanoseconds: 10_000_000_000) },
      clearIdentity: { cleared = true }, timeoutNanoseconds: 10_000_000)
    XCTAssertTrue(cleared)
  }
}
