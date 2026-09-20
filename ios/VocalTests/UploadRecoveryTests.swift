import Foundation
import XCTest

@testable import Vocal

@MainActor final class UploadRecoveryTests: XCTestCase {
  private var root: URL!
  private var staging: URL!
  private var store: ProcessingStore!
  private var api: UploadJobsFixture!
  private var transfers: UploadTransfersFixture!
  private var repository: ProcessingRepository!

  override func setUp() async throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    staging = root.appendingPathComponent("staging")
    store = ProcessingStore(root: root.appendingPathComponent("store"), stagingRoot: staging)
    api = UploadJobsFixture()
    transfers = UploadTransfersFixture()
    repository = ProcessingRepository(api: api, store: store, transfers: transfers)
    await repository.setSession(uid: "owner-a")
  }
  override func tearDown() async throws {
    try? FileManager.default.removeItem(at: root)
  }
  func testStaleSessionEnumerationCannotCancelNewBindingTransfer() async throws {
    let old = TransferContext(ownerUid: "owner-a", operationId: UUID(), transferId: UUID())
    let replacement = TransferContext(
      ownerUid: "owner-a", operationId: old.operationId, transferId: UUID())
    transfers.active = [old]
    var resume: CheckedContinuation<Void, Never>?
    transfers.beforeActive = {
      await withCheckedContinuation { resume = $0 }
    }
    let stale = Task { await repository.setSession(uid: "owner-b") }
    while resume == nil { await Task.yield() }
    transfers.active = []
    await repository.setSession(uid: "owner-a")
    transfers.active = [replacement]
    resume?.resume()
    await stale.value
    XCTAssertEqual(transfers.active.map(\.transferId), [replacement.transferId])
  }

  func testSessionCancellationTargetsCapturedTransferAfterEnumerationSuspends() async {
    let old = TransferContext(ownerUid: "owner-a", operationId: UUID(), transferId: UUID())
    let replacement = TransferContext(
      ownerUid: "owner-a", operationId: old.operationId, transferId: UUID())
    transfers.active = [old]
    transfers.beforeExactCancel = { [transfers] in
      transfers?.active = [replacement]
    }
    await repository.setSession(uid: "owner-b")
    XCTAssertEqual(transfers.active.map(\.transferId), [replacement.transferId])
  }

  func testLostCreateResponseAndRestartReplaySameRequestAndDeclaration() async throws {
    let input = try processingPrepared(root: staging)
    api.failCreateOnce = true
    do {
      _ = try await repository.submit(prepared: input)
      XCTFail("Expected lost create response")
    } catch {}
    let pending = try await requiredOperation(input)
    XCTAssertEqual(pending.phase, .reservationPending)
    let restarted = ProcessingRepository(api: api, store: store, transfers: transfers)
    await restarted.setSession(uid: "owner-a")
    try await restarted.resume(operationId: input.operationId)
    XCTAssertEqual(api.createInputs.count, 2)
    XCTAssertEqual(api.createInputs[0].0, api.createInputs[1].0)
    XCTAssertEqual(api.createInputs[0].1, api.createInputs[1].1)
    XCTAssertEqual(transfers.started.count, 1)
  }
  func testLostStorageResponseConfirmsBeforeAnyWholeFileRetry() async throws {
    let input = try processingPrepared(root: staging)
    _ = try await repository.submit(prepared: input)
    let context = try XCTUnwrap(transfers.started.first)
    await transfers.finish(context, status: nil, succeeded: false)
    XCTAssertEqual(api.confirmCount, 1)
    XCTAssertEqual(api.renewCount, 0)
    let operation = try await requiredOperation(input)
    XCTAssertEqual(operation.phase, .submitted)
  }
  func testLostConfirmResponsePersistsConfirmationForForeground() async throws {
    let input = try processingPrepared(root: staging)
    _ = try await repository.submit(prepared: input)
    api.failConfirmOnce = true
    await transfers.finish(try XCTUnwrap(transfers.started.first), status: 204, succeeded: true)
    let pending = try await requiredOperation(input)
    XCTAssertEqual(pending.phase, .confirmationPending)
    let restarted = ProcessingRepository(api: api, store: store, transfers: transfers)
    await restarted.setSession(uid: "owner-a")
    try await restarted.resume(operationId: input.operationId)
    XCTAssertEqual(api.confirmCount, 2)
    XCTAssertEqual(transfers.started.count, 1)
  }
  func testDuplicateSubmitAndStopFenceLateTransferCompletion() async throws {
    let input = try processingPrepared(root: staging)
    _ = try await repository.submit(prepared: input)
    _ = try await repository.submit(prepared: input)
    XCTAssertEqual(api.createInputs.count, 1)
    XCTAssertEqual(transfers.started.count, 1)
    let context = try XCTUnwrap(transfers.started.first)
    await repository.stopLocalTransfer(operationId: input.operationId)
    await transfers.finish(context, status: 204, succeeded: true)
    XCTAssertEqual(api.confirmCount, 0)
    let operation = try await requiredOperation(input)
    XCTAssertEqual(operation.phase, .stopped)
  }
  func testAccountSwitchKeepsOldCompletionPrivateAndRequiresExplicitResume() async throws {
    let input = try processingPrepared(root: staging)
    _ = try await repository.submit(prepared: input)
    let context = try XCTUnwrap(transfers.started.first)
    await repository.setSession(uid: "owner-b")
    await transfers.finish(context, status: 204, succeeded: true)
    XCTAssertTrue(repository.operations.isEmpty)
    XCTAssertEqual(api.confirmCount, 0)
    await repository.setSession(uid: "owner-a")
    await transfers.finish(context, status: 204, succeeded: true)
    XCTAssertEqual(api.confirmCount, 0)
    try await repository.resume(operationId: input.operationId)
    XCTAssertEqual(api.confirmCount, 1)
  }
  func testExpiredGrantRenewsAndMissingUploadAfterRestartConfirmsFirst() async throws {
    let input = try processingPrepared(root: staging)
    api.expiredCreateGrant = true
    _ = try await repository.submit(prepared: input)
    XCTAssertEqual(api.renewCount, 1)
    transfers.active = []
    api.uploadNotReadyOnce = true
    let restarted = ProcessingRepository(api: api, store: store, transfers: transfers)
    await restarted.setSession(uid: "owner-a")
    try await restarted.resume(operationId: input.operationId)
    XCTAssertEqual(api.confirmCount, 1)
    XCTAssertEqual(api.renewCount, 2)
    XCTAssertEqual(Set(api.renewRequestIds).count, 2)
    let recovered = try await requiredOperation(input)
    XCTAssertEqual(api.renewRequestIds.last, recovered.uploadGrantRequestId)
    XCTAssertEqual(transfers.started.count, 2)
  }
  func testFirstAuthenticatedBindingAdoptsExistingOwnerUploadAfterRestart() async throws {
    let input = try processingPrepared(root: staging)
    _ = try await repository.submit(prepared: input)
    let context = try XCTUnwrap(transfers.started.first)
    let restarted = ProcessingRepository(api: api, store: store, transfers: transfers)
    await restarted.setSession(uid: "owner-a")
    XCTAssertEqual(transfers.active, [context])
    try await restarted.resume(operationId: input.operationId)
    XCTAssertEqual(api.confirmCount, 0)
    XCTAssertEqual(transfers.started.count, 1)
    await transfers.finish(context, status: 204, succeeded: true)
    XCTAssertEqual(api.confirmCount, 1)
  }

  func testCompletionDuringEnqueueStillConfirmsWithoutForegroundRefresh() async throws {
    let input = try processingPrepared(root: staging)
    transfers.afterStart = { context in
      self.transfers.immediateTask = Task {
        await self.transfers.finish(context, status: 204, succeeded: true)
      }
      for _ in 0..<1000 {
        let saved = try? await self.store.operation(id: input.operationId, ownerUid: input.ownerUid)
        if saved?.phase == .confirmationPending { return }
        await Task.yield()
      }
      XCTFail("Completion was not durably received")
    }
    _ = try await repository.submit(prepared: input)
    await transfers.immediateTask?.value
    XCTAssertEqual(api.confirmCount, 1)
    let operation = try await requiredOperation(input)
    XCTAssertEqual(operation.phase, .submitted)
  }

  func testUploadAttemptBudgetSurvivesRestart() async throws {
    let input = try processingPrepared(root: staging)
    _ = try await store.createOperation(prepared: input)
    let jobId = api.id
    try await store.update(id: input.operationId, ownerUid: input.ownerUid) {
      $0.jobId = jobId
      $0.phase = .uploadPending
      $0.uploadAttempts = 5
    }
    for _ in 0..<2 {
      let restarted = ProcessingRepository(api: api, store: store, transfers: transfers)
      await restarted.setSession(uid: "owner-a")
      do {
        try await restarted.resume(operationId: input.operationId)
        XCTFail("Expected bounded retries")
      } catch { XCTAssertEqual(error as? ProcessingTransferFailure, .retryLimit) }
    }
    XCTAssertEqual(api.renewCount, 0)
    XCTAssertTrue(transfers.started.isEmpty)
  }

  func testMultipartDiskFailurePreservesInput() throws {
    let input = try processingPrepared(root: staging)
    let original = try Data(contentsOf: input.fileURL)
    let destination = root.appendingPathComponent("no-room.multipart")
    XCTAssertThrowsError(
      try S3MultipartFile.build(
        inputURL: input.fileURL, declaration: input.declaration,
        destination: destination, policyVersion: input.policyVersion,
        availableCapacity: { _ in 0 })
    ) { error in
      XCTAssertEqual(error as? ProcessingTransferFailure, .storage)
    }
    XCTAssertEqual(try Data(contentsOf: input.fileURL), original)
    XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
  }

  func testBackgroundCompletionWaitsForDurableReceiptAndDrainsOnce() async throws {
    let identifier = "com.hatem.vocal.processing.test." + UUID().uuidString
    let coordinator = BackgroundTransferCoordinator(identifier: identifier)
    let context = TransferContext(ownerUid: "owner-a", operationId: UUID(), transferId: UUID())
    let receiptStarted = expectation(description: "Receipt persistence started")
    let drained = expectation(description: "OS completion drained")
    var continuation: CheckedContinuation<Void, Never>?
    var completionCount = 0
    coordinator.onCompletion = { event in
      XCTAssertEqual(event.context, context)
      await withCheckedContinuation {
        continuation = $0
        receiptStarted.fulfill()
      }
    }
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }
    let task = session.uploadTask(
      with: URLRequest(url: URL(string: "https://storage.example")!), from: Data())
    task.taskDescription = String(data: try JSONEncoder().encode(context), encoding: .utf8)
    coordinator.urlSession(
      session, task: task, didCompleteWithError: URLError(.networkConnectionLost))
    coordinator.urlSessionDidFinishEvents(forBackgroundURLSession: session)
    XCTAssertTrue(
      coordinator.handleBackgroundEvents(identifier: identifier) {
        completionCount += 1
        drained.fulfill()
      })
    await fulfillment(of: [receiptStarted], timeout: 2)
    XCTAssertEqual(completionCount, 0)
    continuation?.resume()
    await fulfillment(of: [drained], timeout: 2)
    coordinator.urlSessionDidFinishEvents(forBackgroundURLSession: session)
    XCTAssertEqual(completionCount, 1)
  }

  private func requiredOperation(_ input: PreparedInput) async throws -> UploadOperation {
    let stored = try await store.operation(id: input.operationId, ownerUid: input.ownerUid)
    return try XCTUnwrap(stored)
  }
  func testWholeObjectUploadPreservesRawBytesAndSignedHeaders() throws {
    let prepared = try processingPrepared(root: staging)
    let grant = UploadGrant(
      method: .put,
      url: URL(string: "https://storage.example")!,
      headers: [
        "Content-Type": prepared.declaration.contentType,
        "x-amz-checksum-sha256": prepared.declaration.sha256,
        "If-None-Match": "*",
      ],
      expiresAt: Date().addingTimeInterval(300))
    let body = try S3MultipartFile.build(
      inputURL: prepared.fileURL, declaration: prepared.declaration,
      destination: root.appendingPathComponent("upload"),
      policyVersion: prepared.policyVersion,
      availableCapacity: { _ in 1_000_000 })
    let bytes = try Data(contentsOf: body.fileURL)
    XCTAssertEqual(bytes, try Data(contentsOf: prepared.fileURL))
    XCTAssertEqual(Int64(bytes.count), body.bytes)
    let request = try BackgroundTransferCoordinator.uploadRequest(grant: grant, multipart: body)
    XCTAssertEqual(request.httpMethod, "PUT")
    XCTAssertEqual(
      request.value(forHTTPHeaderField: "Content-Type"), prepared.declaration.contentType)
    XCTAssertEqual(
      request.value(forHTTPHeaderField: "x-amz-checksum-sha256"), prepared.declaration.sha256)
    XCTAssertEqual(request.value(forHTTPHeaderField: "If-None-Match"), "*")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Length"), String(body.bytes))
    XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
    XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
    XCTAssertFalse(request.httpShouldHandleCookies)
    try Data([1]).write(to: body.fileURL)
    XCTAssertThrowsError(try body.validate())
    try Data([1]).write(to: prepared.fileURL)
    XCTAssertThrowsError(
      try S3MultipartFile.build(
        inputURL: prepared.fileURL, declaration: prepared.declaration,
        destination: root.appendingPathComponent("changed"),
        policyVersion: prepared.policyVersion))
  }

  func testWholeObjectUploadRejectsCaseInsensitiveDuplicateHeaders() throws {
    let prepared = try processingPrepared(root: staging)
    let body = try S3MultipartFile.build(
      inputURL: prepared.fileURL, declaration: prepared.declaration,
      destination: root.appendingPathComponent("duplicate-header-upload"),
      policyVersion: prepared.policyVersion,
      availableCapacity: { _ in 1_000_000 })
    let grant = UploadGrant(
      method: .put,
      url: URL(string: "https://storage.example")!,
      headers: [
        "Content-Type": prepared.declaration.contentType,
        "content-type": prepared.declaration.contentType,
        "If-None-Match": "*",
      ],
      expiresAt: Date().addingTimeInterval(300))

    XCTAssertThrowsError(
      try BackgroundTransferCoordinator.uploadRequest(grant: grant, multipart: body)
    ) {
      XCTAssertEqual($0 as? ProcessingTransferFailure, .invalidGrant)
    }
  }
}

@MainActor private final class UploadJobsFixture: JobsAPI {
  var createInputs: [(UUID, InputDeclaration)] = []
  var failCreateOnce = false
  var failConfirmOnce = false
  var uploadNotReadyOnce = false
  var expiredCreateGrant = false
  var confirmCount = 0
  var renewCount = 0
  var renewRequestIds: [UUID] = []
  let id = "68c000000000000000000001"
  func grant(expired: Bool = false) -> UploadGrant {
    UploadGrant(
      method: .put, url: URL(string: "https://storage.example")!,
      headers: [
        "Content-Type": "audio/mpeg", "x-amz-checksum-sha256": "fixture", "If-None-Match": "*",
      ],
      expiresAt: Date().addingTimeInterval(expired ? -60 : 600))
  }
  func create(requestId: UUID, input: InputDeclaration) async throws -> CreateReservation {
    createInputs.append((requestId, input))
    if failCreateOnce {
      failCreateOnce = false
      throw AuthFailure.offline
    }
    return CreateReservation(
      id: id, status: "awaiting_upload", upload: grant(expired: expiredCreateGrant))
  }
  func renewUpload(id: String) async throws -> UploadGrant {
    renewCount += 1
    return grant()
  }
  func renewUpload(id: String, requestId: UUID) async throws -> UploadGrant {
    renewRequestIds.append(requestId)
    return try await renewUpload(id: id)
  }
  func confirmUpload(id: String) async throws -> JobMutation {
    confirmCount += 1
    if failConfirmOnce {
      failConfirmOnce = false
      throw AuthFailure.offline
    }
    if uploadNotReadyOnce {
      uploadNotReadyOnce = false
      throw JobsFailure.conflict(code: "UPLOAD_NOT_READY")
    }
    return JobMutation(id: id, status: "queued", retryOfJobId: nil)
  }
  func detail(id: String) async throws -> Job { processingJob(id: id) }
  func list(cursor: String?, status: String?) async throws -> JobPage {
    JobPage(items: [], nextCursor: nil)
  }
  func cancel(id: String) async throws -> JobMutation {
    JobMutation(id: id, status: "cancelled", retryOfJobId: nil)
  }
  func retry(id: String, requestId: UUID) async throws -> JobMutation {
    JobMutation(id: id, status: "queued", retryOfJobId: id)
  }
  func download(id: String, artifact: String) async throws -> DownloadGrant {
    throw JobsFailure.notFound
  }
}

@MainActor private final class UploadTransfersFixture: BackgroundTransferring {
  var onCompletion: ((TransferCompletion) async -> Void)?
  var onProgress: ((TransferContext, TransferProgressSnapshot) -> Void)?
  var started: [TransferContext] = []
  var active: [TransferContext] = []
  var beforeActive: (() async -> Void)?
  var afterStart: ((TransferContext) async -> Void)?
  var immediateTask: Task<Void, Never>?
  func startUpload(file: S3MultipartFile, grant: UploadGrant, context: TransferContext) async throws
    -> Int
  {
    try file.validate()
    started.append(context)
    active.append(context)
    await afterStart?(context)
    return started.count
  }
  func activeTransfers() async -> [TransferContext] {
    let snapshot = active
    let hook = beforeActive
    beforeActive = nil
    await hook?()
    return snapshot
  }
  var beforeExactCancel: (() async -> Void)?
  func cancel(context: TransferContext) async {
    await beforeExactCancel?()
    active.removeAll { $0.transferId == context.transferId }
  }
  func cancel(ownerUid: String, operationId: UUID?) async {
    active.removeAll {
      $0.ownerUid == ownerUid && (operationId == nil || $0.operationId == operationId)
    }
  }
  func finish(_ context: TransferContext, status: Int?, succeeded: Bool) async {
    active.removeAll { $0.transferId == context.transferId }
    await onCompletion?(
      TransferCompletion(context: context, statusCode: status, succeeded: succeeded))
  }
}
