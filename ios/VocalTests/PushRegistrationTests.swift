import Foundation
import XCTest

@testable import Vocal

@MainActor final class PushRegistrationTests: XCTestCase {
  private let installation = "d7ea7de6-52e9-4b96-8834-3b517941bdb0"
  private let jobID = "68c000000000000000000001"
  private var session: PushSession?
  private var uid: String? = "owner"
  private let api = PushAPIFixture()
  private let jobs = PushJobsFixture()
  private var hint: [AnyHashable: Any] {
    [
      "type": "audio_job_outcome", "jobId": jobID,
      "eventId": "notification:68c000000000000000000002:68c000000000000000000003:7",
      "outcome": "ready",
    ]
  }
  private func coordinator(enabled: Bool = true) -> PushRegistrationCoordinator {
    PushRegistrationCoordinator(
      api: api, jobs: jobs, session: { self.session }, identityUID: { self.uid },
      tokenSource: { "sdk-token" }, enabled: enabled)
  }
  private func authenticated() {
    session = PushSession(uid: "owner", epoch: 1, installationID: installation)
  }

  func testFCMTokenWaitsForPermissionAPNsAndDeviceBootstrap() async {
    let push = coordinator()
    push.receivedFCMToken("first-token")
    await push.synchronize()
    XCTAssertTrue(api.tokens.isEmpty)
    push.permissionChanged(granted: true)
    push.apnsTokenReady()
    await push.synchronize()
    XCTAssertTrue(api.tokens.isEmpty)
    authenticated()
    push.sessionChanged()
    await push.synchronize()
    XCTAssertEqual(api.tokens, ["first-token"])
    push.receivedFCMToken("rotated-token")
    await push.synchronize()
    XCTAssertEqual(api.tokens.last, "rotated-token")
  }

  func testDeniedPermissionAndSimulatorTransportNeverRequestToken() async {
    authenticated()
    var reads = 0
    let push = PushRegistrationCoordinator(
      api: api, jobs: jobs, session: { self.session }, identityUID: { self.uid },
      tokenSource: {
        reads += 1
        return "sdk-token"
      }, enabled: true)
    push.apnsTokenReady()
    push.permissionChanged(granted: false)
    await push.synchronize()
    XCTAssertEqual(reads, 0)
    let disabled = coordinator(enabled: false)
    disabled.permissionChanged(granted: true)
    disabled.apnsTokenReady()
    disabled.receivedFCMToken("token")
    await disabled.synchronize()
    XCTAssertTrue(api.tokens.isEmpty)
  }

  func testAPNsFailureBlocksBindingAndForegroundRetriesOfflineRegistration() async {
    authenticated()
    let push = coordinator()
    push.permissionChanged(granted: true)
    push.apnsTokenReady()
    push.apnsRegistrationFailed()
    push.receivedFCMToken("token")
    await push.synchronize()
    XCTAssertTrue(api.tokens.isEmpty)
    api.failRegistration = true
    push.apnsTokenReady()
    await push.synchronize()
    XCTAssertFalse(api.tokens.isEmpty)
    api.failRegistration = false
    push.foreground()
    await push.synchronize()
    XCTAssertEqual(api.tokens.last, "token")
  }

  func testConditionalLogoutRetainsOldRevisionAcrossSessionNilAndNeverReplays() async {
    authenticated()
    let push = coordinator()
    push.permissionChanged(granted: true)
    push.apnsTokenReady()
    await push.synchronize()
    session = nil
    push.sessionChanged()
    api.failDeactivation = true
    await push.beforeSignOut(uid: "owner", installationID: installation)
    XCTAssertEqual(api.revisions, [7])
    uid = "other"
    session = PushSession(uid: "other", epoch: 2, installationID: installation)
    push.sessionChanged()
    await push.synchronize()
    push.foreground()
    await push.synchronize()
    XCTAssertEqual(api.revisions, [7])
  }

  func testNoAcknowledgedBindingNeverSendsUnguardedCleanup() async {
    await coordinator().beforeSignOut(uid: "owner", installationID: installation)
    XCTAssertTrue(api.revisions.isEmpty)
  }

  func testColdTapWaitsForLoginThenFetchesOwnerAndDeduplicates() async throws {
    // Local injected hints remain testable without APNs/FCM.
    let push = coordinator(enabled: false)
    push.rememberTap(hint)
    let beforeLogin = try await push.resolvePendingTap()
    XCTAssertNil(beforeLogin)
    XCTAssertEqual(jobs.reads, 0)
    authenticated()
    push.sessionChanged()
    let job = try await push.resolvePendingTap()
    XCTAssertEqual(job?.id, jobID)
    push.rememberTap(hint)
    let duplicate = try await push.resolvePendingTap()
    XCTAssertNil(duplicate)
    XCTAssertEqual(jobs.reads, 1)
  }

  func testMalformedAndForeignOwnerHintsDoNotNavigate() async throws {
    authenticated()
    let push = coordinator()
    var invalid = hint
    invalid["jobId"] = "../other"
    push.rememberTap(invalid)
    XCTAssertNil(push.pendingTap)
    invalid = hint
    invalid["outcome"] = "cancelled"
    push.rememberTap(invalid)
    XCTAssertNil(push.pendingTap)
    push.rememberTap(hint)
    jobs.notFound = true
    let result = try await push.resolvePendingTap()
    XCTAssertNil(result)
    XCTAssertNil(push.pendingTap)
  }

  func testForegroundSuppressesPresentationAndOnlyPublishesRefreshHint() async {
    authenticated()
    let push = coordinator()
    let delegate = NotificationDelegate(coordinator: push, transportEnabled: false)
    XCTAssertTrue(delegate.receiveForeground(hint).isEmpty)
    XCTAssertEqual(push.refreshHint?.jobID, jobID)
    XCTAssertEqual(jobs.reads, 0)
  }

  func testAccountSwitchDuringOwnerFetchDiscardsOldResponse() async throws {
    authenticated()
    let push = coordinator()
    let started = expectation(description: "detail started")
    jobs.beforeDetail = {
      started.fulfill()
      try? await Task.sleep(nanoseconds: 30_000_000)
    }
    push.rememberTap(hint)
    let task = Task { try await push.resolvePendingTap() }
    await fulfillment(of: [started], timeout: 1)
    uid = "other"
    session = PushSession(uid: "other", epoch: 2, installationID: installation)
    push.sessionChanged()
    let result = try await task.value
    XCTAssertNil(result)
  }
}

@MainActor private final class PushAPIFixture: PushRegistrationAPI {
  var tokens: [String] = []
  var revisions: [Int64] = []
  var failRegistration = false
  var failDeactivation = false
  func register(installationID: String, token: String) async throws -> PushBinding {
    tokens.append(token)
    if failRegistration { throw AuthFailure.offline }
    return PushBinding(installationID: installationID, active: true, bindingRevision: 7)
  }
  func deactivate(installationID: String, expectedBindingRevision: Int64) async throws {
    revisions.append(expectedBindingRevision)
    if failDeactivation { throw AuthFailure.offline }
  }
}

@MainActor private final class PushJobsFixture: JobsAPI {
  var reads = 0
  var notFound = false
  var beforeDetail: (() async -> Void)?
  func detail(id: String) async throws -> Job {
    reads += 1
    await beforeDetail?()
    if notFound { throw JobsFailure.notFound }
    return Job(
      id: id, status: "ready", createdAt: Date(), updatedAt: Date(), queuedAt: nil, finishedAt: nil,
      retryOfJobId: nil, input: .init(extension: "mp3", bytes: 1, durationSeconds: 1), error: nil,
      canDownloadInput: true, canDownloadOutput: true, workerAvailable: true)
  }
  func create(requestId: UUID, input: InputDeclaration) async throws -> CreateReservation {
    fatalError()
  }
  func renewUpload(id: String) async throws -> UploadGrant { fatalError() }
  func confirmUpload(id: String) async throws -> JobMutation { fatalError() }
  func list(cursor: String?, status: String?) async throws -> JobPage { fatalError() }
  func cancel(id: String) async throws -> JobMutation { fatalError() }
  func retry(id: String, requestId: UUID) async throws -> JobMutation { fatalError() }
  func download(id: String, artifact: String) async throws -> DownloadGrant { fatalError() }
}
