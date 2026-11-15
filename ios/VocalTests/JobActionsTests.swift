import Foundation
import XCTest

@testable import Vocal

@MainActor final class JobActionsTests: XCTestCase {
  private var root: URL!
  private var staging: URL!
  private var store: ProcessingStore!
  private var api: ActionJobsFixture!
  private var transfers: ActionTransfersFixture!
  private var repository: ProcessingRepository!

  override func setUp() async throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    staging = root.appendingPathComponent("staging")
    store = ProcessingStore(root: root.appendingPathComponent("store"), stagingRoot: staging)
    api = ActionJobsFixture()
    transfers = ActionTransfersFixture()
    repository = ProcessingRepository(api: api, store: store, transfers: transfers)
    await repository.setSession(uid: "owner-a")
  }
  override func tearDown() async throws { try? FileManager.default.removeItem(at: root) }

  func testCancellationResolvesUncertainReservationWithOriginalRequestId() async throws {
    let input = try processingPrepared(root: staging)
    api.failCreateOnce = true
    do {
      _ = try await repository.submit(prepared: input)
      XCTFail("Expected uncertain reservation")
    } catch {}
    let result = try await repository.cancelOperation(operationId: input.operationId)
    XCTAssertEqual(result?.status, "cancel_requested")
    XCTAssertEqual(api.creates.count, 2)
    XCTAssertEqual(api.creates[0], api.creates[1])
    XCTAssertEqual(api.cancelCount, 1)
    XCTAssertEqual(transfers.started.count, 0)
    let saved = try await stored(input)
    XCTAssertTrue(saved.cancellationRequested)
    XCTAssertEqual(saved.jobStatus, "cancel_requested")
  }

  func testFailedCancelPersistsIntentWithoutInventingCancelledAndResumesAfterRestart() async throws
  {
    let input = try processingPrepared(root: staging)
    _ = try await repository.submit(prepared: input)
    api.failCancelOnce = true
    api.detailStatus = "awaiting_upload"
    do {
      _ = try await repository.cancel(jobId: api.id)
      XCTFail("Expected offline cancel")
    } catch { XCTAssertEqual(error as? AuthFailure, .offline) }
    let pending = try await stored(input)
    XCTAssertTrue(pending.cancellationRequested)
    XCTAssertEqual(pending.phase, .stopped)
    XCTAssertEqual(pending.jobStatus, "awaiting_upload")
    await transfers.finish(try XCTUnwrap(transfers.started.first))
    XCTAssertEqual(api.confirmCount, 0)
    let restarted = ProcessingRepository(api: api, store: store, transfers: transfers)
    await restarted.setSession(uid: "owner-a")
    await restarted.resumePending()
    XCTAssertEqual(api.cancelCount, 2)
    let acknowledged = try await stored(input)
    XCTAssertEqual(acknowledged.jobStatus, "cancel_requested")
    XCTAssertEqual(acknowledged.phase, .submitted)
  }

  func testReadyCancellationRaceKeepsReadyResult() async throws {
    let input = try processingPrepared(root: staging)
    _ = try await repository.submit(prepared: input)
    api.cancelStatus = "ready"
    let result = try await repository.cancel(jobId: api.id)
    XCTAssertEqual(result.status, "ready")
    let saved = try await stored(input)
    XCTAssertEqual(saved.jobStatus, "ready")
  }

  func testRetryResponseLossReusesPersistedUUIDAndRetainsOldFailedJob() async throws {
    try await store.saveJobs([processingJob(id: api.id, status: "failed")], ownerUid: "owner-a")
    api.failRetryOnce = true
    do {
      _ = try await repository.retry(jobId: api.id)
      XCTFail("Expected lost retry response")
    } catch {}
    let first = try XCTUnwrap(api.retries.first)
    let restarted = ProcessingRepository(api: api, store: store, transfers: transfers)
    await restarted.setSession(uid: "owner-a")
    let result = try await restarted.retry(jobId: api.id)
    XCTAssertEqual(result.id, api.retriedId)
    XCTAssertEqual(result.retryOfJobId, api.id)
    XCTAssertEqual(api.retries, [first, first])
    let again = try await restarted.retry(jobId: api.id)
    XCTAssertEqual(again.id, result.id)
    XCTAssertEqual(api.retries.count, 2)
    let jobs = try await store.cachedJobs(ownerUid: "owner-a")
    XCTAssertEqual(jobs.first?.id, api.id)
    XCTAssertEqual(jobs.first?.status, "failed")
  }

  func testInvalidInputRetryIsNotRepeatedAndInterruptedJobCannotRetry() async throws {
    api.requiresNewInput = true
    for _ in 0..<2 {
      do {
        _ = try await repository.retry(jobId: api.id)
        XCTFail("Expected replacement input")
      } catch { XCTAssertEqual(error as? JobsFailure, .conflict(code: "NEW_INPUT_REQUIRED")) }
    }
    XCTAssertEqual(api.retries.count, 1)
    api.detailStatus = "interrupted"
    do {
      _ = try await repository.retry(jobId: api.retriedId)
      XCTFail("Interrupted is recovery")
    } catch { XCTAssertEqual(error as? JobsFailure, .conflict(code: "JOB_STATE_CONFLICT")) }
    XCTAssertEqual(api.retries.count, 1)
  }

  func testConcurrentRetryCoalescesAndLateSameUidResultIsFenced() async throws {
    let started = expectation(description: "Retry request started")
    var continuation: CheckedContinuation<Void, Never>?
    api.beforeRetry = {
      await withCheckedContinuation {
        continuation = $0
        started.fulfill()
      }
    }
    let first = Task { try await self.repository.retry(jobId: self.api.id) }
    await fulfillment(of: [started], timeout: 2)
    let second = Task { try await self.repository.retry(jobId: self.api.id) }
    await Task.yield()
    let previousFence = repository.session
    let rebind = Task { await self.repository.setSession(uid: "owner-a") }
    for _ in 0..<1_000 {
      if repository.session != previousFence { break }
      await Task.yield()
    }
    XCTAssertNotEqual(repository.session, previousFence)
    continuation?.resume()
    await rebind.value
    for task in [first, second] {
      do {
        _ = try await task.value
        XCTFail("Expected stale session fence")
      } catch { XCTAssertTrue(error is CancellationError) }
    }
    XCTAssertEqual(api.retries.count, 1)
    XCTAssertTrue(repository.operations.isEmpty)
  }

  func testAccountSwitchDuringCancellationPersistenceNeverStopsNewOwnerTransfers() async throws {
    let input = try processingPrepared(root: staging)
    _ = try await store.createOperation(prepared: input)
    let entered = expectation(description: "Store actor held")
    let gate = DispatchSemaphore(value: 0)
    let blockedStore = store!
    let blocker = Task.detached {
      try await blockedStore.update(id: input.operationId, ownerUid: input.ownerUid) { _ in
        entered.fulfill()
        gate.wait()
      }
    }
    await fulfillment(of: [entered], timeout: 2)
    let cancel = Task { try await self.repository.cancelOperation(operationId: input.operationId) }
    await Task.yield()
    let rebind = Task { await self.repository.setSession(uid: "owner-b") }
    for _ in 0..<1000 {
      if repository.session?.uid == "owner-b" { break }
      await Task.yield()
    }
    XCTAssertEqual(repository.session?.uid, "owner-b")
    gate.signal()
    _ = try await blocker.value
    await rebind.value
    _ = try? await cancel.value
    XCTAssertFalse(transfers.cancelledOwners.contains("owner-b"))
    XCTAssertEqual(api.cancelCount, 0)
  }

  func testCancellationDuringCreateDoesNotCancelUnderNewAccount() async throws {
    let input = try processingPrepared(root: staging)
    let started = expectation(description: "Create started")
    var continuation: CheckedContinuation<Void, Never>?
    api.beforeCreate = {
      await withCheckedContinuation {
        continuation = $0
        started.fulfill()
      }
    }
    let submit = Task { try await self.repository.submit(prepared: input) }
    await fulfillment(of: [started], timeout: 2)
    let cancel = Task { try await self.repository.cancelOperation(operationId: input.operationId) }
    for _ in 0..<1000 {
      if (try await stored(input)).cancellationRequested { break }
      await Task.yield()
    }
    let rebind = Task { await self.repository.setSession(uid: "owner-b") }
    for _ in 0..<1_000 {
      if repository.session?.uid == "owner-b" { break }
      await Task.yield()
    }
    XCTAssertEqual(repository.session?.uid, "owner-b")
    continuation?.resume()
    await rebind.value
    _ = try? await submit.value
    _ = try? await cancel.value
    XCTAssertEqual(api.cancelCount, 0)
    XCTAssertTrue(repository.operations.isEmpty)
    let saved = try await stored(input)
    XCTAssertEqual(saved.jobId, api.id)
    XCTAssertTrue(saved.cancellationRequested)
  }

  private func stored(_ input: PreparedInput) async throws -> UploadOperation {
    let value = try await store.operation(id: input.operationId, ownerUid: input.ownerUid)
    return try XCTUnwrap(value)
  }
}

@MainActor private final class ActionJobsFixture: JobsAPI {
  let id = "68c000000000000000000001"
  let retriedId = "68c000000000000000000002"
  var creates: [UUID] = []
  var retries: [UUID] = []
  var cancelCount = 0
  var confirmCount = 0
  var failCreateOnce = false
  var failCancelOnce = false
  var failRetryOnce = false
  var requiresNewInput = false
  var cancelStatus = "cancel_requested"
  var detailStatus = "failed"
  var beforeCreate: (() async -> Void)?
  var beforeRetry: (() async -> Void)?
  func create(requestId: UUID, input: InputDeclaration) async throws -> CreateReservation {
    creates.append(requestId)
    await beforeCreate?()
    if failCreateOnce {
      failCreateOnce = false
      throw AuthFailure.offline
    }
    return CreateReservation(
      id: id, status: "awaiting_upload", upload: try await renewUpload(id: id))
  }
  func renewUpload(id: String) async throws -> UploadGrant {
    UploadGrant(
      method: .put, url: URL(string: "https://storage.example")!,
      headers: [
        "Content-Type": "audio/mpeg", "x-amz-checksum-sha256": "fixture", "If-None-Match": "*",
      ],
      expiresAt: Date().addingTimeInterval(600))
  }
  func confirmUpload(id: String) async throws -> JobMutation {
    confirmCount += 1
    return JobMutation(id: id, status: "queued", retryOfJobId: nil)
  }
  func detail(id: String) async throws -> Job { processingJob(id: id, status: detailStatus) }
  func list(cursor: String?, status: String?) async throws -> JobPage {
    JobPage(items: [], nextCursor: nil)
  }
  func cancel(id: String) async throws -> JobMutation {
    cancelCount += 1
    if failCancelOnce {
      failCancelOnce = false
      throw AuthFailure.offline
    }
    return JobMutation(id: id, status: cancelStatus, retryOfJobId: nil)
  }
  func retry(id: String, requestId: UUID) async throws -> JobMutation {
    retries.append(requestId)
    await beforeRetry?()
    if failRetryOnce {
      failRetryOnce = false
      throw AuthFailure.offline
    }
    if requiresNewInput { throw JobsFailure.conflict(code: "NEW_INPUT_REQUIRED") }
    return JobMutation(id: retriedId, status: "queued", retryOfJobId: id)
  }
  func download(id: String, artifact: String) async throws -> DownloadGrant {
    throw JobsFailure.notFound
  }
}

@MainActor private final class ActionTransfersFixture: BackgroundTransferring {
  var onCompletion: ((TransferCompletion) async -> Void)?
  var onProgress: ((TransferContext, TransferProgressSnapshot) -> Void)?
  var started: [TransferContext] = []
  var active: [TransferContext] = []
  var cancelledOwners: [String] = []
  func startUpload(file: S3MultipartFile, grant: UploadGrant, context: TransferContext) async throws
    -> Int
  {
    started.append(context)
    active.append(context)
    return started.count
  }
  func activeTransfers() async -> [TransferContext] { active }
  func cancel(context: TransferContext) async {
    await cancel(ownerUid: context.ownerUid, operationId: context.operationId)
  }
  func cancel(ownerUid: String, operationId: UUID?) async {
    cancelledOwners.append(ownerUid)
    active.removeAll {
      $0.ownerUid == ownerUid && (operationId == nil || $0.operationId == operationId)
    }
  }
  func finish(_ context: TransferContext) async {
    await onCompletion?(TransferCompletion(context: context, statusCode: 204, succeeded: true))
  }
}
