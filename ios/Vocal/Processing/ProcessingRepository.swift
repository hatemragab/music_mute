import Combine
import Foundation

struct SessionFence: Equatable, Sendable {
  let uid: String
  let epoch: UInt64
}

func acceptsCallback(captured: SessionFence, current: SessionFence?) -> Bool { captured == current }

@MainActor final class ProcessingRepository: ObservableObject {
  @Published private(set) var operations: [UploadOperation] = []
  @Published private(set) var transferProgress: [UUID: TransferProgressSnapshot] = [:]
  @Published private(set) var retryIntents: [JobRetryIntent] = []
  @Published private(set) var lastFailureCode: String?
  private(set) var session: SessionFence?
  private var epoch: UInt64 = 0
  private let api: JobsAPI
  let store: ProcessingStore
  private let transfers: BackgroundTransferring
  private struct RunningOperation {
    let token: UUID
    let task: Task<UploadOperation, Error>
  }
  private var running: [UUID: RunningOperation] = [:]
  private var transferFences: [UUID: SessionFence] = [:]
  private struct RunningMutation {
    let token: UUID
    let task: Task<JobMutation, Error>
  }
  private var mutations: [String: RunningMutation] = [:]
  var onFailure: AudioPipelineCoordinator.FailureReporter = { _, _, _, _, _ in }

  init(api: JobsAPI, store: ProcessingStore, transfers: BackgroundTransferring) {
    self.api = api
    self.store = store
    self.transfers = transfers
    transfers.onCompletion = { [weak self] event in await self?.completed(event) }
    transfers.onProgress = { [weak self] context, progress in
      guard let self, let fence = self.transferFences[context.transferId],
        acceptsCallback(captured: fence, current: self.session)
      else { return }
      self.transferProgress[context.operationId] = progress
    }
  }

  /// Every binding is a new epoch, including reauthentication by the same UID.
  func setSession(uid: String?) async {
    let initialBinding = epoch == 0
    epoch &+= 1
    let bindingEpoch = epoch
    let captured = uid.map { SessionFence(uid: $0, epoch: epoch) }
    session = captured
    let stoppingOperations = Array(running.values)
    for operation in stoppingOperations { operation.task.cancel() }
    running.removeAll()
    let stoppingMutations = Array(mutations.values)
    for mutation in stoppingMutations { mutation.task.cancel() }
    mutations.removeAll()
    transferFences.removeAll()
    operations = []
    retryIntents = []
    transferProgress = [:]
    lastFailureCode = nil
    for operation in stoppingOperations { _ = try? await operation.task.value }
    for mutation in stoppingMutations { _ = try? await mutation.task.value }
    guard epoch == bindingEpoch else { return }
    let active = await transfers.activeTransfers()
    guard epoch == bindingEpoch else { return }
    for context in active {
      guard epoch == bindingEpoch else { return }
      if initialBinding, let captured, context.ownerUid == captured.uid,
        let operation = try? await store.operation(id: context.operationId, ownerUid: captured.uid),
        operation.transferId == context.transferId, operation.phase == .uploading,
        acceptsCallback(captured: captured, current: session)
      {
        // A new process adopts an existing authenticated owner's OS task without
        // re-uploading bytes. A real rebind, even to the same UID, never adopts it.
        transferFences[context.transferId] = captured
      } else {
        guard epoch == bindingEpoch else { return }
        await transfers.cancel(context: context)
      }
    }
    guard let captured, acceptsCallback(captured: captured, current: session) else { return }
    await publish(captured)
  }

  func submit(prepared: PreparedInput) async throws -> UploadOperation {
    let fence = try requireSession(owner: prepared.ownerUid)
    let operation = try await store.createOperation(prepared: prepared)
    try check(fence)
    await publish(fence)
    return try await start(operationId: operation.operationId, fence: fence)
  }

  func resume(operationId: UUID) async throws {
    let fence = try requireSession()
    if let operation = try await store.operation(id: operationId, ownerUid: fence.uid),
      operation.cancellationRequested, operation.phase == .stopped
    {
      _ = try await cancellation(operationId: operationId, fence: fence)
    } else {
      _ = try await start(operationId: operationId, fence: fence)
    }
  }

  func resumePending() async {
    guard let fence = session else { return }
    await publish(fence)
    let pending = operations.filter {
      $0.phase != .submitted && ($0.phase != .stopped || $0.cancellationRequested)
    }
    for operation in pending {
      guard acceptsCallback(captured: fence, current: session) else { return }
      do {
        if operation.cancellationRequested {
          _ = try await cancellation(operationId: operation.operationId, fence: fence)
        } else {
          _ = try await start(operationId: operation.operationId, fence: fence)
        }
      } catch {
        // A durable phase remains available for the next foreground or manual retry.
      }
    }
    for intent in retryIntents where intent.phase == .pending {
      guard acceptsCallback(captured: fence, current: session) else { return }
      _ = try? await retry(jobId: intent.originalJobId)
    }
  }

  /// Replays durable server mutations. Transfer work is scheduled by AudioPipelineCoordinator
  /// so restored uploads continue to respect its concurrency limit.
  func resumePendingMutations() async {
    guard let fence = session else { return }
    await publish(fence)
    for operation in operations where operation.cancellationRequested {
      guard acceptsCallback(captured: fence, current: session) else { return }
      _ = try? await cancellation(operationId: operation.operationId, fence: fence)
    }
    for intent in retryIntents where intent.phase == .pending {
      guard acceptsCallback(captured: fence, current: session) else { return }
      _ = try? await retry(jobId: intent.originalJobId)
    }
  }

  func stopLocalTransfer(operationId: UUID) async {
    guard let fence = session else { return }
    let stopping = running.removeValue(forKey: operationId)?.task
    stopping?.cancel()
    do {
      let operation = try await store.update(id: operationId, ownerUid: fence.uid) {
        $0.phase = .stopped
        $0.transferTaskId = nil
        $0.activeRunToken = nil
      }
      if let id = operation.transferId { transferFences.removeValue(forKey: id) }
    } catch {
      if acceptsCallback(captured: fence, current: session) {
        lastFailureCode = "processing_storage_error"
      }
    }
    await transfers.cancel(ownerUid: fence.uid, operationId: operationId)
    _ = try? await stopping?.value
    guard acceptsCallback(captured: fence, current: session) else { return }
    transferProgress.removeValue(forKey: operationId)
    await publish(fence)
  }

  func cancel(jobId: String) async throws -> JobMutation {
    let fence = try requireSession()
    let owned = try await store.operations(ownerUid: fence.uid)
    try check(fence)
    if let operation = owned.first(where: { $0.jobId == jobId }) {
      return try await cancellation(operationId: operation.operationId, fence: fence)
    }
    return try await mutate(key: "cancel-job:" + jobId, fence: fence) {
      let result = try await self.cancelCloud(jobId: jobId, fence: fence)
      try self.check(fence)
      return result
    }
  }

  func cancelOperation(operationId: UUID) async throws -> JobMutation? {
    try await cancellation(operationId: operationId, fence: requireSession())
  }

  func retry(jobId: String) async throws -> JobMutation {
    let fence = try requireSession()
    return try await mutate(key: "retry:" + jobId, fence: fence) {
      try await self.runRetry(jobId: jobId, fence: fence)
    }
  }

  func rename(jobId: String, displayName: String) async throws -> Job {
    let fence = try requireSession()
    let job = try await api.rename(id: jobId, displayName: displayName)
    try check(fence)
    var jobs = try await store.cachedJobs(ownerUid: fence.uid)
    if let index = jobs.firstIndex(where: { $0.id == job.id }) {
      jobs[index] = job
      try await store.saveJobs(jobs, ownerUid: fence.uid)
    }
    return job
  }

  func delete(jobId: String) async throws {
    let fence = try requireSession()
    try await api.delete(id: jobId)
    try check(fence)
    let jobs = try await store.cachedJobs(ownerUid: fence.uid).filter { $0.id != jobId }
    try await store.saveJobs(jobs, ownerUid: fence.uid)
  }

  private func cancellation(operationId: UUID, fence: SessionFence) async throws -> JobMutation {
    try await mutate(key: "cancel-upload:" + operationId.uuidString, fence: fence) {
      try await self.runCancellation(operationId: operationId, fence: fence)
    }
  }

  private func mutate(
    key: String, fence: SessionFence,
    action: @escaping @MainActor () async throws -> JobMutation
  ) async throws -> JobMutation {
    try check(fence)
    if let existing = mutations[key] { return try await existing.task.value }
    let token = UUID()
    let task = Task { @MainActor in try await action() }
    mutations[key] = RunningMutation(token: token, task: task)
    defer { if mutations[key]?.token == token { mutations.removeValue(forKey: key) } }
    return try await withTaskCancellationHandler(
      operation: { try await task.value }, onCancel: { task.cancel() })
  }

  private func runCancellation(operationId: UUID, fence: SessionFence) async throws -> JobMutation {
    try check(fence)
    let uploading = running[operationId]?.task
    do {
      try await store.update(id: operationId, ownerUid: fence.uid) {
        $0.cancellationRequested = true
        $0.phase = .stopped
        $0.activeRunToken = nil
      }
    } catch {
      if acceptsCallback(captured: fence, current: session) {
        await stopLocalTransfer(operationId: operationId)
      }
      throw error
    }
    // Disk persistence may have yielded to an account change. Never recapture the
    // new session through the public stop entry point for an old cancellation.
    try check(fence)
    await stopLocalTransfer(operationId: operationId)
    // A late create response may carry the reservation we must cancel. Wait for its
    // local bookkeeping before replaying the same persisted idempotency key if needed.
    _ = try? await uploading?.value
    try check(fence)
    do {
      guard var operation = try await store.operation(id: operationId, ownerUid: fence.uid) else {
        throw ProcessingStoreFailure.missingOperation
      }
      if operation.jobId == nil {
        let reservation = try await api.create(
          requestId: operation.requestId, input: operation.input,
          metadata: JobSourceMetadata(
            sourceTitle: operation.sourceTitle, sourceKind: operation.sourceKind,
            clientStartedAt: operation.clientStartedAt, sourceURL: operation.sourceURL))
        operation = try await store.update(id: operationId, ownerUid: fence.uid) {
          $0.jobId = reservation.id
          $0.jobStatus = reservation.status
        }
      }
      try check(fence)
      guard let jobId = operation.jobId else { throw ProcessingStoreFailure.corruptStore }
      let result = try await cancelCloud(jobId: jobId, fence: fence)
      try await store.update(id: operationId, ownerUid: fence.uid) {
        $0.jobStatus = result.status
        $0.phase = .submitted
        $0.lastFailureCode = nil
      }
      try check(fence)
      await publish(fence)
      return result
    } catch {
      let code = Self.failureCode(error)
      _ = try? await store.update(id: operationId, ownerUid: fence.uid) {
        $0.lastFailureCode = code
      }
      if acceptsCallback(captured: fence, current: session) {
        lastFailureCode = code
        await publish(fence)
      }
      throw error
    }
  }

  private func cancelCloud(jobId: String, fence: SessionFence) async throws -> JobMutation {
    do { return try await api.cancel(id: jobId) } catch {
      try check(fence)
      // An uncertain response can follow an accepted cancel or a ready race.
      if let job = try? await api.detail(id: jobId),
        ["cancel_requested", "cancelled", "ready"].contains(job.status)
      {
        try check(fence)
        return JobMutation(id: job.id, status: job.status, retryOfJobId: job.retryOfJobId)
      }
      throw error
    }
  }

  private func runRetry(jobId: String, fence: SessionFence) async throws -> JobMutation {
    var intent = try await store.retryIntent(jobId: jobId, ownerUid: fence.uid)
    try check(fence)
    if intent == nil {
      let job = try await api.detail(id: jobId)
      try check(fence)
      guard job.status == "failed" else { throw JobsFailure.conflict(code: "JOB_STATE_CONFLICT") }
      intent = try await store.createRetryIntent(jobId: jobId, ownerUid: fence.uid)
    }
    guard let intent else { throw ProcessingStoreFailure.missingOperation }
    if let result = intent.result { return result }
    if intent.phase == .newInputRequired { throw JobsFailure.conflict(code: "NEW_INPUT_REQUIRED") }
    try check(fence)
    do {
      let result = try await api.retry(id: jobId, requestId: intent.requestId)
      try await store.updateRetry(requestId: intent.requestId, ownerUid: fence.uid) {
        $0.result = result
        $0.phase = .submitted
        $0.lastFailureCode = nil
      }
      try check(fence)
      await publish(fence)
      return result
    } catch {
      let requiresInput = (error as? JobsFailure) == .conflict(code: "NEW_INPUT_REQUIRED")
      let code = requiresInput ? "processing_new_input_required" : Self.failureCode(error)
      _ = try? await store.updateRetry(requestId: intent.requestId, ownerUid: fence.uid) {
        if $0.result == nil {
          $0.phase = requiresInput ? .newInputRequired : .pending
          $0.lastFailureCode = code
        }
      }
      if acceptsCallback(captured: fence, current: session) {
        lastFailureCode = code
        await publish(fence)
      }
      throw error
    }
  }

  private func start(operationId: UUID, fence: SessionFence) async throws -> UploadOperation {
    try check(fence)
    if let existing = running[operationId] { return try await existing.task.value }
    let token = UUID()
    let task = Task { @MainActor in
      let claimed = try await self.store.update(id: operationId, ownerUid: fence.uid) {
        guard !$0.cancellationRequested else { return }
        $0.activeRunToken = token
      }
      guard claimed.activeRunToken == token else { throw CancellationError() }
      return try await self.run(operationId: operationId, token: token, fence: fence)
    }
    running[operationId] = RunningOperation(token: token, task: task)
    defer {
      if running[operationId]?.token == token { running.removeValue(forKey: operationId) }
    }
    return try await withTaskCancellationHandler(
      operation: { try await task.value }, onCancel: { task.cancel() })
  }

  private func run(operationId: UUID, token: UUID, fence: SessionFence) async throws
    -> UploadOperation
  {
    var grant: UploadGrant?
    do {
      while true {
        try checkRun(operationId, token: token, fence: fence)
        guard let operation = try await store.operation(id: operationId, ownerUid: fence.uid) else {
          throw ProcessingStoreFailure.missingOperation
        }
        try checkRun(operationId, token: token, fence: fence)
        switch operation.phase {
        case .submitted, .stopped: return operation
        case .reservationPending:
          let reservation = try await api.create(
            requestId: operation.requestId, input: operation.input,
            metadata: JobSourceMetadata(
              sourceTitle: operation.sourceTitle, sourceKind: operation.sourceKind,
              clientStartedAt: operation.clientStartedAt, sourceURL: operation.sourceURL))
          // Save an acknowledged reservation even if its session became stale while waiting.
          // It remains owned by the captured UID and never enters a new session's visible state.
          try await store.update(id: operationId, ownerUid: fence.uid) {
            if $0.jobId == nil { $0.jobId = reservation.id }
            guard $0.activeRunToken == token else { return }
            $0.jobStatus = reservation.status
            if !$0.cancellationRequested, $0.phase != .stopped {
              $0.phase = reservation.status == "awaiting_upload" ? .uploadPending : .submitted
            }
            $0.lastFailureCode = nil
          }
          try checkRun(operationId, token: token, fence: fence)
          grant = reservation.upload
          await publish(fence)
        case .uploading:
          let active = await transfers.activeTransfers()
          try checkRun(operationId, token: token, fence: fence)
          if let context = active.first(where: {
            $0.ownerUid == fence.uid && $0.operationId == operationId
              && $0.transferId == operation.transferId
          }) {
            transferFences[context.transferId] = fence
            return operation
          }
          _ = try await mutateRun(operationId, token: token, fence: fence) {
            if $0.phase == .uploading {
              $0.phase = .confirmationPending
              $0.transferTaskId = nil
            }
          }
        case .confirmationPending:
          guard let jobId = operation.jobId else { throw ProcessingStoreFailure.corruptStore }
          do {
            let mutation = try await api.confirmUpload(id: jobId)
            _ = try await mutateRun(operationId, token: token, fence: fence) {
              $0.jobStatus = mutation.status
              if $0.phase != .stopped { $0.phase = .submitted }
              $0.lastFailureCode = nil
            }
          } catch let failure as JobsFailure {
            guard case .conflict = failure else { throw failure }
            try checkRun(operationId, token: token, fence: fence)
            let job = try await api.detail(id: jobId)
            _ = try await mutateRun(operationId, token: token, fence: fence) {
              $0.jobStatus = job.status
              if $0.phase != .stopped {
                $0.phase = job.status == "awaiting_upload" ? .uploadPending : .submitted
              }
            }
          }
          try checkRun(operationId, token: token, fence: fence)
          await publish(fence)
        case .uploadPending:
          guard let jobId = operation.jobId else { throw ProcessingStoreFailure.corruptStore }
          guard operation.uploadAttempts < 3 else { throw ProcessingTransferFailure.retryLimit }
          if grant == nil || grant!.expiresAt <= Date() {
            grant = try await api.renewUpload(id: jobId)
          }
          try checkRun(operationId, token: token, fence: fence)
          guard let currentGrant = grant, currentGrant.expiresAt > Date() else {
            throw ProcessingTransferFailure.expiredGrant
          }
          let transferId = UUID()
          let inputURL = try await store.inputURL(for: operation)
          let destination = try await store.multipartURL(for: operation, transferId: transferId)
          let builder = Task.detached(priority: .utility) {
            try S3MultipartFile.build(
              inputURL: inputURL, declaration: operation.input,
              destination: destination)
          }
          let multipart = try await withTaskCancellationHandler(
            operation: { try await builder.value }, onCancel: { builder.cancel() })
          try checkRun(operationId, token: token, fence: fence)
          let context = TransferContext(
            ownerUid: fence.uid, operationId: operationId, transferId: transferId)
          let prepared = try await mutateRun(operationId, token: token, fence: fence) {
            guard $0.phase == .uploadPending else { return }
            $0.transferId = transferId
            $0.transferTaskId = nil
            $0.uploadAttempts += 1
            $0.phase = .uploading
            $0.lastFailureCode = nil
          }
          try checkRun(operationId, token: token, fence: fence)
          guard prepared.phase == .uploading, prepared.transferId == transferId else {
            return prepared
          }
          transferFences[transferId] = fence
          let taskId: Int
          do {
            taskId = try await transfers.startUpload(
              file: multipart, grant: currentGrant, context: context)
          } catch {
            _ = try await mutateRun(operationId, token: token, fence: fence) {
              if $0.transferId == transferId && $0.phase == .uploading {
                $0.phase = .confirmationPending
              }
            }
            throw error
          }
          let result = try await mutateRun(operationId, token: token, fence: fence) {
            if $0.transferId == transferId && $0.phase == .uploading { $0.transferTaskId = taskId }
          }
          try checkRun(operationId, token: token, fence: fence)
          await publish(fence)
          return result
        }
      }
    } catch {
      let code = Self.failureCode(error)
      _ = try? await mutateRun(operationId, token: token, fence: fence) {
        $0.lastFailureCode = code
      }
      if running[operationId]?.token == token,
        acceptsCallback(captured: fence, current: session)
      {
        lastFailureCode = code
        await publish(fence)
      }
      throw error
    }
  }

  private func completed(_ event: TransferCompletion) async {
    let context = event.context
    let captured = transferFences.removeValue(forKey: context.transferId)
    do {
      let operation = try await store.update(id: context.operationId, ownerUid: context.ownerUid) {
        guard $0.transferId == context.transferId,
          $0.phase == .uploading || $0.phase == .confirmationPending
        else { return }
        // Even a lost/error response may follow a successful S3 write. Confirm first.
        $0.phase = .confirmationPending
        $0.transferTaskId = nil
        $0.lastFailureCode = event.succeeded ? nil : "processing_upload_uncertain"
      }
      guard operation.transferId == context.transferId, operation.phase == .confirmationPending,
        let captured, acceptsCallback(captured: captured, current: session)
      else { return }
      transferProgress.removeValue(forKey: context.operationId)
      await publish(captured)
      // Completion may race the final enqueue bookkeeping. Wait for that operation to
      // release its slot, then perform confirmation as a new operation rather than merely
      // coalescing with the already-finishing enqueue task.
      if let enqueuing = running[context.operationId] {
        _ = try? await enqueuing.task.value
        if running[context.operationId]?.token == enqueuing.token {
          running.removeValue(forKey: context.operationId)
        }
      }
      try check(captured)
      _ = try await start(operationId: context.operationId, fence: captured)
    } catch {
      // URLSession's background completion is drained after this durable receipt attempt.
      // Existing uploading state also recovers via confirmation if the receipt write failed.
      if let captured, acceptsCallback(captured: captured, current: session) {
        lastFailureCode = Self.failureCode(error)
        let jobID = await operationJobID(context.operationId, ownerUid: captured.uid)
        await onFailure(
          captured, context.operationId, jobID, .confirmingUpload, error)
      }
    }
  }

  private func operationJobID(_ operationId: UUID, ownerUid: String) async -> String? {
    let operation = try? await store.operation(id: operationId, ownerUid: ownerUid)
    return operation?.jobId
  }

  private func requireSession(owner: String? = nil) throws -> SessionFence {
    guard let session, owner == nil || owner == session.uid else {
      throw AuthFailure.sessionExpired
    }
    return session
  }

  private func check(_ fence: SessionFence) throws {
    try Task.checkCancellation()
    guard acceptsCallback(captured: fence, current: session) else { throw CancellationError() }
  }

  private func checkRun(_ operationId: UUID, token: UUID, fence: SessionFence) throws {
    try check(fence)
    guard running[operationId]?.token == token else { throw CancellationError() }
  }

  private func mutateRun(
    _ operationId: UUID, token: UUID, fence: SessionFence,
    _ change: @escaping @Sendable (inout UploadOperation) -> Void
  ) async throws -> UploadOperation {
    try checkRun(operationId, token: token, fence: fence)
    let operation = try await store.update(id: operationId, ownerUid: fence.uid) {
      guard $0.activeRunToken == token else { return }
      change(&$0)
    }
    try checkRun(operationId, token: token, fence: fence)
    guard operation.activeRunToken == token else { throw CancellationError() }
    return operation
  }

  private func publish(_ fence: SessionFence) async {
    do {
      let saved = try await store.operations(ownerUid: fence.uid)
      let savedRetries = try await store.retries(ownerUid: fence.uid)
      guard acceptsCallback(captured: fence, current: session) else { return }
      operations = saved
      retryIntents = savedRetries
    } catch {
      if acceptsCallback(captured: fence, current: session) {
        lastFailureCode = "processing_storage_error"
      }
    }
  }

  private static func failureCode(_ error: Error) -> String {
    if error is CancellationError { return "processing_interrupted" }
    if let failure = error as? AuthFailure, failure == .offline { return "processing_offline" }
    if error is ProcessingStoreFailure { return "processing_storage_error" }
    if let failure = error as? ProcessingTransferFailure {
      switch failure {
      case .storage: return "processing_storage_error"
      case .invalidInput, .corruptMultipart: return "processing_invalid_input"
      case .retryLimit: return "processing_upload_retry_limit"
      default: return "processing_upload_error"
      }
    }
    return "processing_service_unavailable"
  }
}
