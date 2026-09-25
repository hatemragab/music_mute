import Combine
import Foundation

struct PipelineSourceFile: Sendable {
  let url: URL
  let title: String
}

enum AudioPipelineFailure: Error, Equatable {
  case sessionChanged
  case sourceNeedsReselection
}

@MainActor final class AudioPipelineCoordinator: ObservableObject {
  typealias FailureReporter =
    @MainActor (
      _ fence: SessionFence, _ operationID: UUID, _ jobID: String?, _ stage: ClientErrorStage,
      _ error: Error
    ) async -> Void

  var beforePreparation: @MainActor () async throws -> Void = {}
  @Published private(set) var pipelines: [AudioPipelineIntent] = []

  private enum Source {
    case file(URL, securityScoped: Bool, temporary: Bool)
  }

  private let store: ProcessingStore
  private let repository: ProcessingRepository
  private let preparer: AudioInputPreparer
  private let retrySleep: @Sendable (TimeInterval) async throws -> Void
  private let jitter: @Sendable () -> TimeInterval
  private let reportFailure: FailureReporter
  private let flushDiagnostics: @MainActor (SessionFence) async -> Void
  private let maxConcurrent: Int
  private var session: SessionFence?
  private var queued: [UUID] = []
  private var sources: [UUID: Source] = [:]
  private struct Running {
    let token: UUID
    let fence: SessionFence
    let task: Task<Void, Never>
  }
  private var running: [UUID: Running] = [:]
  private var transferSlots = Set<UUID>()
  private var subscriptions = Set<AnyCancellable>()

  init(
    store: ProcessingStore, repository: ProcessingRepository, preparer: AudioInputPreparer,
    maxConcurrent: Int = 2,
    retrySleep: @escaping @Sendable (TimeInterval) async throws -> Void = {
      try await Task.sleep(for: .seconds($0))
    },
    jitter: @escaping @Sendable () -> TimeInterval = { Double.random(in: 0...0.5) },
    reportFailure: @escaping FailureReporter = { _, _, _, _, _ in },
    flushDiagnostics: @escaping @MainActor (SessionFence) async -> Void = { _ in }
  ) {
    self.store = store
    self.repository = repository
    self.preparer = preparer
    self.maxConcurrent = max(1, maxConcurrent)
    self.retrySleep = retrySleep
    self.jitter = jitter
    self.reportFailure = reportFailure
    self.flushDiagnostics = flushDiagnostics
    repository.$operations.sink { [weak self] operations in
      self?.repositoryOperationsChanged(operations)
    }.store(in: &subscriptions)
  }

  func bind(_ fence: SessionFence?) async {
    guard fence != session else { return }
    let stopping = Array(running.values)
    session = fence
    for run in stopping { run.task.cancel() }
    running.removeAll()
    transferSlots.removeAll()
    queued.removeAll()
    for source in sources.values {
      if case .file(let url, _, let temporary) = source, temporary {
        PreparedMediaCleanup.discardPhotoCopy(url)
      }
    }
    sources.removeAll()
    pipelines.removeAll()
    for run in stopping { await run.task.value }
    guard session == fence else { return }
    guard session == fence, let fence else { return }
    await flushDiagnostics(fence)
    guard session == fence else { return }
    await publish(fence)
    let existingUploads = (try? await store.operations(ownerUid: fence.uid)) ?? []
    for upload in existingUploads
    where pipelines.allSatisfy({ $0.operationId != upload.operationId }) {
      _ = try? await store.createPipeline(
        operationId: upload.operationId, ownerUid: fence.uid,
        sourceKind: upload.sourceKind ?? .file, sourceTitle: upload.sourceTitle,
        clientStartedAt: upload.clientStartedAt ?? upload.createdAt)
      _ = try? await store.updatePipeline(id: upload.operationId, ownerUid: fence.uid) {
        $0.displayName = upload.displayName ?? upload.sourceTitle
        $0.jobId = upload.jobId
        $0.jobStatus = upload.jobStatus
        $0.cancellationRequested = upload.cancellationRequested
        $0.phase =
          upload.cancellationRequested
          ? .cancelling : upload.phase == .submitted ? .waitingProcessing : .uploadingInput
      }
    }
    await publish(fence)
    for intent in pipelines
    where !intent.phase.isTerminal && !intent.cancellationRequested
      && intent.phase != .awaitingConfirmation
    {
      let existing = try? await store.operation(id: intent.operationId, ownerUid: fence.uid)
      if intent.reviewInput != nil || existing != nil {
        enqueue(intent.operationId)
      } else {
        _ = try? await store.updatePipeline(id: intent.operationId, ownerUid: fence.uid) {
          $0.phase = .awaitingAppResume
          $0.lastFailureCode = "processing_reselect_input"
        }
      }
    }
    await publish(fence)
  }

  @discardableResult
  func acceptFile(
    _ url: URL, eventID: UUID = UUID(), securityScoped: Bool = true, temporary: Bool = false
  ) async throws -> UUID {
    guard let fence = session else { throw AudioPipelineFailure.sessionChanged }
    if try await store.pipeline(id: eventID, ownerUid: fence.uid) != nil { return eventID }
    let title = url.deletingPathExtension().lastPathComponent
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let started = Date()
    _ = try await store.createPipeline(
      operationId: eventID, ownerUid: fence.uid, sourceKind: .file,
      sourceTitle: title.isEmpty ? nil : String(title.prefix(200)), clientStartedAt: started)
    try check(fence)
    sources[eventID] = .file(url, securityScoped: securityScoped, temporary: temporary)
    await publish(fence)
    enqueue(eventID)
    return eventID
  }

  func confirmProcessing(_ operationID: UUID, rightsConfirmed: Bool) async throws {
    guard rightsConfirmed, let fence = session,
      let intent = try await store.pipeline(id: operationID, ownerUid: fence.uid),
      intent.phase == .awaitingConfirmation, intent.reviewInput != nil,
      !intent.cancellationRequested
    else { throw JobsFailure.invalidInput }
    if let task = running[operationID]?.task { await task.value }
    try check(fence)
    _ = try await store.updatePipeline(id: operationID, ownerUid: fence.uid) {
      $0.cloudConsent = true
      $0.phase = .reservingJob
    }
    try check(fence)
    await publish(fence)
    enqueue(operationID)
  }

  func resume(_ operationID: UUID) async {
    guard let fence = session,
      let intent = try? await store.pipeline(id: operationID, ownerUid: fence.uid),
      !intent.cancellationRequested, intent.phase != .awaitingConfirmation
    else { return }
    if intent.phase == .failed || intent.phase == .awaitingAppResume {
      let hasUpload = (try? await store.operation(id: operationID, ownerUid: fence.uid)) != nil
      if !hasUpload {
        _ = try? await store.updatePipeline(id: operationID, ownerUid: fence.uid) {
          $0.phase = .awaitingAppResume
          $0.lastFailureCode = "processing_reselect_input"
        }
        await publish(fence)
        return
      }
      _ = try? await store.updatePipeline(id: operationID, ownerUid: fence.uid) {
        $0.phase = hasUpload ? .reservingJob : .preparingInput
        $0.completedAt = nil
        $0.retryAttempt = 0
        $0.nextRetryAt = nil
        $0.lastFailureCode = nil
        $0.activeRunToken = nil
      }
    }
    guard session == fence else { return }
    await publish(fence)
    enqueue(operationID)
  }

  func cancel(_ operationID: UUID) async {
    guard let fence = session,
      let intent = try? await store.pipeline(id: operationID, ownerUid: fence.uid),
      !intent.phase.isTerminal
    else { return }
    _ = try? await store.updatePipeline(id: operationID, ownerUid: fence.uid) {
      $0.cancellationRequested = true
      $0.activeRunToken = nil
      $0.phase = .cancelling
      $0.lastFailureCode = nil
    }
    let stopping = running[operationID]
    stopping?.task.cancel()
    queued.removeAll { $0 == operationID }
    await publish(fence)
    await stopping?.task.value
    guard session == fence else { return }
    do {
      if intent.jobId == nil, let input = intent.reviewInput {
        try await preparer.discard(input)
        _ = try await store.updatePipeline(id: operationID, ownerUid: fence.uid) {
          $0.reviewInput = nil
          $0.phase = .cancelled
          $0.completedAt = Date()
        }
        await publish(fence)
        return
      }
      let result = try await repository.cancelOperation(operationId: operationID)
      try check(fence)
      _ = try await store.updatePipeline(id: operationID, ownerUid: fence.uid) {
        $0.jobId = result?.id ?? $0.jobId
        $0.jobStatus = result?.status ?? "cancelled"
        switch result?.status {
        case "ready":
          $0.phase = .ready
          $0.completedAt = Date()
        case "cancelled":
          $0.phase = .cancelled
          $0.completedAt = Date()
        default:
          $0.phase = .cancelling
        }
      }
    } catch ProcessingStoreFailure.missingOperation {
      _ = try? await store.updatePipeline(id: operationID, ownerUid: fence.uid) {
        $0.phase = .cancelled
        $0.jobStatus = "cancelled"
        $0.completedAt = Date()
      }
    } catch is CancellationError {
    } catch {
      _ = try? await store.updatePipeline(id: operationID, ownerUid: fence.uid) {
        $0.phase = .cancelling
        $0.lastFailureCode = "processing_cancel_pending"
      }
    }
    await publish(fence)
  }

  func reconcile(_ jobs: [Job]) async {
    guard let fence = session else { return }
    let byID = Dictionary(uniqueKeysWithValues: jobs.map { ($0.id, $0) })
    let byRequest = Dictionary(
      jobs.compactMap { job in job.requestId.map { ($0.lowercased(), job) } },
      uniquingKeysWith: { first, _ in first })
    for intent in pipelines {
      guard
        let job = intent.jobId.flatMap({ byID[$0] })
          ?? byRequest[intent.operationId.uuidString.lowercased()]
      else { continue }
      _ = try? await store.updatePipeline(id: intent.operationId, ownerUid: fence.uid) {
        if $0.phase.isTerminal,
          !["ready", "failed", "cancelled"].contains(job.status)
        {
          // A cached or racing cloud response cannot move a locally persisted terminal
          // result back into an active state.
          return
        }
        $0.jobId = job.id
        $0.jobStatus = job.status
        if job.status == "ready" {
          $0.phase = .ready
          $0.completedAt = $0.completedAt ?? job.finishedAt ?? Date()
        } else if job.status == "failed" {
          $0.phase = .failed
          $0.completedAt = job.finishedAt ?? Date()
        } else if job.status == "cancelled" {
          $0.phase = .cancelled
          $0.completedAt = job.finishedAt ?? Date()
        } else if job.status == "cancel_requested" || $0.cancellationRequested {
          $0.phase = .cancelling
        } else if job.status == "awaiting_upload",
          [
            .preparingInput, .reservingJob, .uploadingInput, .confirmingUpload,
            .awaitingAppResume, .failed,
          ].contains($0.phase)
        {
          // The server only knows that input is still missing. Keep the more
          // specific local transfer/recovery state so Retry resumes the source pipeline.
        } else {
          $0.phase = .waitingProcessing
        }
      }
    }
    await publish(fence)
  }

  func rename(_ operationID: UUID, to rawName: String) async throws {
    guard let fence = session else { throw AudioPipelineFailure.sessionChanged }
    let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty, name.unicodeScalars.count <= 200,
      name.unicodeScalars.allSatisfy({ $0.properties.generalCategory != .control })
    else { throw JobsFailure.invalidInput }
    let intent = try await store.updatePipeline(id: operationID, ownerUid: fence.uid) {
      $0.displayName = name
    }
    try check(fence)
    if let jobID = intent.jobId {
      let job = try await repository.rename(jobId: jobID, displayName: name)
      try check(fence)
      _ = try await store.updatePipeline(id: operationID, ownerUid: fence.uid) {
        $0.displayName = job.displayName ?? name
      }
    }
    await publish(fence)
  }

  func remove(_ operationID: UUID, serverDeletionConfirmed: Bool = false) async throws {
    guard let fence = session,
      let intent = try await store.pipeline(id: operationID, ownerUid: fence.uid),
      intent.phase.isTerminal || (serverDeletionConfirmed && intent.jobId != nil)
    else { throw JobsFailure.conflict(code: "JOB_ACTIVE") }
    try await store.removePipeline(id: operationID, ownerUid: fence.uid)
    try await store.removeOperation(id: operationID, ownerUid: fence.uid)
    try check(fence)
    sources[operationID] = nil
    transferSlots.remove(operationID)
    await publish(fence)
  }

  private func enqueue(_ id: UUID) {
    guard running[id] == nil, !queued.contains(id) else { return }
    queued.append(id)
    startAvailable()
  }

  private func startAvailable() {
    while running.count + transferSlots.count < maxConcurrent, !queued.isEmpty,
      let fence = session
    {
      let id = queued.removeFirst()
      let token = UUID()
      let task = Task { @MainActor [weak self] in
        await self?.runWithRetries(id, token: token, fence: fence)
        self?.finished(id, token: token, fence: fence)
      }
      running[id] = Running(token: token, fence: fence, task: task)
    }
  }

  private func finished(_ id: UUID, token: UUID, fence: SessionFence) {
    guard running[id]?.token == token, running[id]?.fence == fence, session == fence else { return }
    running[id] = nil
    if let operation = repository.operations.first(where: { $0.operationId == id }),
      operation.phase != .submitted, operation.phase != .stopped
    {
      transferSlots.insert(id)
    }
    if case .file(let url, _, let temporary) = sources[id], temporary {
      PreparedMediaCleanup.discardPhotoCopy(url)
    }
    sources[id] = nil
    startAvailable()
  }

  private func repositoryOperationsChanged(_ operations: [UploadOperation]) {
    let active = Set(
      operations.filter { $0.phase != .submitted && $0.phase != .stopped }.map(\.operationId))
    transferSlots.formIntersection(active)
    startAvailable()
  }

  private func runWithRetries(_ id: UUID, token: UUID, fence: SessionFence) async {
    do {
      let claimed = try await store.updatePipeline(id: id, ownerUid: fence.uid) {
        guard !$0.cancellationRequested else { return }
        $0.activeRunToken = token
      }
      guard claimed.activeRunToken == token else { throw CancellationError() }
      try checkRun(id, token: token, fence: fence)
      while true {
        if let intent = try await store.pipeline(id: id, ownerUid: fence.uid),
          let retryAt = intent.nextRetryAt, retryAt > Date()
        {
          try await retrySleep(retryAt.timeIntervalSinceNow)
          try checkRun(id, token: token, fence: fence)
        }
        do {
          try await run(id, token: token, fence: fence)
          return
        } catch is CancellationError {
          return
        } catch {
          try checkRun(id, token: token, fence: fence)
          guard var intent = try await store.pipeline(id: id, ownerUid: fence.uid),
            !intent.cancellationRequested
          else { return }
          if Self.isConnectivityAbsence(error) {
            let failedAt = Self.clientStage(intent.phase)
            _ = try await mutateRun(id, token: token, fence: fence) {
              $0.phase = .awaitingAppResume
              $0.nextRetryAt = nil
              $0.lastFailureCode = "processing_error_offline"
            }
            await publish(fence)
            await report(error, operationID: id, fence: fence, stage: failedAt)
            return
          }
          guard Self.isTransient(error), intent.retryAttempt < 3 else { throw error }
          let code = Self.failureCode(error)
          let baseDelay: TimeInterval
          if case JobsFailure.rateLimited(let seconds) = error {
            baseDelay = seconds
          } else {
            baseDelay = pow(2, Double(intent.retryAttempt))
          }
          let retryDate = Date().addingTimeInterval(baseDelay + jitter())
          intent = try await mutateRun(id, token: token, fence: fence) {
            $0.retryAttempt += 1
            $0.nextRetryAt = retryDate
            $0.lastFailureCode = code
          }
          await publish(fence)
          try await retrySleep(max(0, intent.nextRetryAt?.timeIntervalSinceNow ?? 0))
        }
      }
    } catch is CancellationError {
    } catch {
      let failedAt =
        (try? await store.pipeline(id: id, ownerUid: fence.uid)).map {
          Self.clientStage($0.phase)
        } ?? .unknown
      let code = Self.failureCode(error)
      _ = try? await mutateRun(id, token: token, fence: fence) {
        guard !$0.cancellationRequested else { return }
        $0.phase = .failed
        $0.completedAt = Date()
        $0.lastFailureCode = code
      }
      await publish(fence)
      if running[id]?.token == token, session == fence {
        await report(error, operationID: id, fence: fence, stage: failedAt)
      }
    }
  }

  private func run(_ id: UUID, token: UUID, fence: SessionFence) async throws {
    try checkRun(id, token: token, fence: fence)
    guard let intent = try await store.pipeline(id: id, ownerUid: fence.uid),
      !intent.cancellationRequested
    else { throw CancellationError() }
    if let existing = try await store.operation(id: id, ownerUid: fence.uid) {
      try await repository.resume(operationId: id)
      try checkRun(id, token: token, fence: fence)
      _ = try await mutateRun(id, token: token, fence: fence) {
        $0.jobId = existing.jobId
        $0.jobStatus = existing.jobStatus
        $0.phase = existing.phase == .submitted ? .waitingProcessing : .uploadingInput
        $0.lastFailureCode = nil
      }
      await publish(fence)
      return
    }

    let prepared: PreparedInput
    if let reviewed = intent.reviewInput {
      prepared = reviewed
    } else {
      try await beforePreparation()
      try checkRun(id, token: token, fence: fence)
      let source = sources[id]
      guard let source else { throw AudioPipelineFailure.sourceNeedsReselection }
      let sourceFile: PipelineSourceFile
      let needsSecurityScope: Bool
      switch source {
      case .file(let file, let securityScoped, _):
        sourceFile = PipelineSourceFile(
          url: file, title: intent.sourceTitle ?? file.lastPathComponent)
        needsSecurityScope = securityScoped
        _ = try await mutateRun(id, token: token, fence: fence) {
          $0.phase = .inspectingSource
        }
      }
      await publish(fence)
      try checkRun(id, token: token, fence: fence)
      guard let current = try await store.pipeline(id: id, ownerUid: fence.uid),
        !current.cancellationRequested
      else { throw CancellationError() }
      prepared = try await MediaPreparationCoordinator.run { [preparer] in
        try await preparer.prepare(
          sourceURL: sourceFile.url, ownerUid: fence.uid, securityScoped: needsSecurityScope,
          operationId: id, sourceTitle: current.sourceTitle ?? sourceFile.title,
          sourceKind: current.sourceKind, clientStartedAt: current.clientStartedAt,
          displayName: current.displayName,
          onPreparation: { [weak self] in
            guard let self else { throw CancellationError() }
            _ = try await self.mutateRun(id, token: token, fence: fence) {
              $0.phase = .preparingInput
            }
            await self.publish(fence)
          })
      }
      try checkRun(id, token: token, fence: fence)
    }
    if intent.cloudConsent != true {
      _ = try await mutateRun(id, token: token, fence: fence) {
        $0.reviewInput = prepared
        $0.phase = .awaitingConfirmation
      }
      await publish(fence)
      return
    }
    _ = try await mutateRun(id, token: token, fence: fence) {
      $0.phase = .reservingJob
    }
    await publish(fence)
    let uploaded = try await repository.submit(prepared: prepared)
    try checkRun(id, token: token, fence: fence)
    _ = try await mutateRun(id, token: token, fence: fence) {
      $0.jobId = uploaded.jobId
      $0.jobStatus = uploaded.jobStatus
      $0.phase = uploaded.phase == .submitted ? .waitingProcessing : .uploadingInput
      $0.retryAttempt = 0
      $0.nextRetryAt = nil
      $0.lastFailureCode = nil
    }
    await publish(fence)
  }

  private func publish(_ fence: SessionFence) async {
    guard let values = try? await store.pipelines(ownerUid: fence.uid), session == fence else {
      return
    }
    pipelines = values
  }

  private func report(
    _ error: Error, operationID: UUID, fence: SessionFence, stage: ClientErrorStage
  ) async {
    guard running[operationID] != nil, session == fence,
      let intent = try? await store.pipeline(id: operationID, ownerUid: fence.uid)
    else { return }
    await reportFailure(fence, operationID, intent.jobId, stage, error)
  }

  private static func clientStage(_ phase: AudioPipelinePhase) -> ClientErrorStage {
    switch phase {
    case .inspectingSource, .preparingInput: return .preparingInput
    case .reservingJob: return .reservingJob
    case .uploadingInput: return .uploadingInput
    case .confirmingUpload: return .confirmingUpload
    case .cancelling: return .cancelling
    default: return .unknown
    }
  }

  private func check(_ fence: SessionFence) throws {
    try Task.checkCancellation()
    guard session == fence, repository.session == fence else {
      throw CancellationError()
    }
  }

  private func checkRun(_ id: UUID, token: UUID, fence: SessionFence) throws {
    try check(fence)
    guard running[id]?.token == token else { throw CancellationError() }
  }

  private func mutateRun(
    _ id: UUID, token: UUID, fence: SessionFence,
    _ change: @escaping @Sendable (inout AudioPipelineIntent) -> Void
  ) async throws -> AudioPipelineIntent {
    try checkRun(id, token: token, fence: fence)
    let intent = try await store.updatePipeline(id: id, ownerUid: fence.uid) {
      guard $0.activeRunToken == token else { return }
      change(&$0)
    }
    try checkRun(id, token: token, fence: fence)
    guard intent.activeRunToken == token else { throw CancellationError() }
    return intent
  }

  private static func isTransient(_ error: Error) -> Bool {
    if error is URLError { return true }
    if let auth = error as? AuthFailure { return auth == .offline }
    if let jobs = error as? JobsFailure {
      if case .rateLimited = jobs { return true }
      return jobs == .serviceUnavailable
    }
    return false
  }

  private static func isConnectivityAbsence(_ error: Error) -> Bool {
    if (error as? AuthFailure) == .offline { return true }
    guard let urlError = error as? URLError else { return false }
    return [.notConnectedToInternet, .networkConnectionLost, .dataNotAllowed].contains(
      urlError.code)
  }

  private static func failureCode(_ error: Error) -> String {
    if let key = ProcessingMediaMessage.key(error) { return key }
    if error is AudioPipelineFailure { return "processing_reselect_input" }
    if error is AudioInputPreparationError { return "processing_error_input" }
    if error is URLError || (error as? AuthFailure) == .offline {
      return "processing_error_offline"
    }
    if error is ProcessingStoreFailure { return "processing_error_storage" }
    return "processing_error_service"
  }
}
