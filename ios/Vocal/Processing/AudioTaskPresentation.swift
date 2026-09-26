import Foundation

enum AudioStepState: Equatable, Sendable { case pending, active, complete, failed, cancelled }

struct AudioStepPresentation: Equatable, Identifiable, Sendable {
  let id: String
  let titleKey: String
  let state: AudioStepState
  let occurredAt: Date?
  var measurement: ServerStageMeasurement?
}

struct AudioTaskPresentation: Equatable, Identifiable, Sendable {
  let id: String
  let operationID: UUID?
  let reference: String?
  let jobID: String?
  let title: String
  let sourceTitle: String?
  let statusKey: String
  let isActive: Bool
  let isReady: Bool
  let canCancel: Bool
  let canRetry: Bool
  let canDelete: Bool
  let createdAt: Date
  let totalSeconds: Double?
  let totalApproximate: Bool
  let processingSeconds: Double?
  let processingApproximate: Bool
  let timeline: [AudioStepPresentation]
  var serverStageTimings: ServerStageTimings?
  var outputMessageKey: String?

  static func merge(
    pipelines: [AudioPipelineIntent], uploads: [UploadOperation], jobs: [Job]
  ) -> [AudioTaskPresentation] {
    let uploadsByOperation = Dictionary(uniqueKeysWithValues: uploads.map { ($0.operationId, $0) })
    let jobsByID = Dictionary(uniqueKeysWithValues: jobs.map { ($0.id, $0) })
    let jobsByRequest = Dictionary(
      jobs.compactMap { job in job.requestId.map { ($0.lowercased(), job) } },
      uniquingKeysWith: { first, _ in first })
    var consumed = Set<String>()
    var result = pipelines.map { intent -> AudioTaskPresentation in
      let job =
        intent.jobId.flatMap { jobsByID[$0] }
        ?? jobsByRequest[intent.operationId.uuidString.lowercased()]
      if let job { consumed.insert(job.id) }
      return make(intent: intent, upload: uploadsByOperation[intent.operationId], job: job)
    }
    result.append(
      contentsOf: jobs.filter { !consumed.contains($0.id) }.map {
        make(intent: nil, upload: nil, job: $0)
      })
    return result.sorted { $0.createdAt > $1.createdAt }
  }

  private static func make(
    intent: AudioPipelineIntent?, upload: UploadOperation?, job: Job?
  ) -> AudioTaskPresentation {
    let stage = resolvedStage(intent: intent, upload: upload, job: job)
    let title =
      [job?.displayName, intent?.displayName, job?.sourceTitle, intent?.sourceTitle]
      .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
      .first { !$0.isEmpty } ?? String(localized: "processing_untitled")
    let serverTiming = job?.serverStageTimings
    let separation = serverTiming?.stages.first(where: { $0.stage == "separation" })
    let processingSeconds =
      serverTiming != nil
      ? separation.map { Double($0.durationMs) / 1_000 }
      : job?.timing?.processingElapsedMs.map { Double($0) / 1_000 }
    return AudioTaskPresentation(
      id: job.map { "job:" + $0.id } ?? "operation:"
        + (intent?.operationId.uuidString ?? UUID().uuidString),
      operationID: intent?.operationId,
      reference: intent?.operationId.uuidString.lowercased() ?? job?.requestId,
      jobID: job?.id ?? intent?.jobId ?? upload?.jobId,
      title: title, sourceTitle: job?.sourceTitle ?? intent?.sourceTitle,
      statusKey: stage.statusKey,
      isActive: stage.isActive, isReady: stage == .ready,
      canCancel: stage.isActive && stage != .cancelling,
      canRetry: stage == .failed, canDelete: [.ready, .failed, .cancelled].contains(stage),
      createdAt: intent?.clientStartedAt ?? job?.createdAt ?? upload?.createdAt ?? Date(),
      totalSeconds: job?.serverStageTimings?.totalMs.map { Double($0) / 1_000 },
      totalApproximate: job?.serverStageTimings.map { !$0.totalComplete } ?? true,
      processingSeconds: processingSeconds,
      processingApproximate: serverTiming != nil
        ? separation.map { !$0.complete } ?? false
        : job?.timing?.processingElapsedApproximate ?? false,
      timeline: timeline(stage: stage, intent: intent, upload: upload, job: job),
      serverStageTimings: job?.serverStageTimings, outputMessageKey: nil)
  }

  // One resolved stage drives labels, actions and timeline, so a stale local
  // failure cannot expose Retry after the server has already completed the job.
  private static func resolvedStage(
    intent: AudioPipelineIntent?, upload: UploadOperation?, job: Job?
  ) -> Stage {
    let persisted = persistedStatus(intent: intent, upload: upload)
    let terminalStatuses = ["ready", "failed", "cancelled"]
    let status: String?
    if let live = job?.status, terminalStatuses.contains(live) {
      status = live
    } else if let persisted, terminalStatuses.contains(persisted) {
      status = persisted
    } else {
      status = job?.status ?? persisted
    }
    if let status, terminalStatuses.contains(status) {
      return serverStage(status)
    }
    if intent?.cancellationRequested == true || upload?.cancellationRequested == true
      || intent?.phase == .cancelling
    {
      return .cancelling
    }
    // The server cannot observe copying or the signed upload. Preserve those
    // local phases only while its reservation is awaiting input.
    if let status, status != "awaiting_upload" { return serverStage(status) }
    if let phase = intent?.phase,
      [.failed, .cancelled, .deleted, .awaitingAppResume].contains(phase)
    {
      return localStage(phase)
    }
    if let upload { return uploadStage(upload.phase) }
    if let intent { return localStage(intent.phase) }
    return status.map(serverStage) ?? .unknown
  }

  private static func persistedStatus(
    intent: AudioPipelineIntent?, upload: UploadOperation?
  ) -> String? {
    var samples: [(status: String, at: Date)] = []
    if let intent, let status = intent.jobStatus { samples.append((status, intent.updatedAt)) }
    if let upload, let status = upload.jobStatus { samples.append((status, upload.updatedAt)) }
    // Upload bookkeeping can outlive a newer reconciled terminal result. A
    // completed job never returns to queued under the same job identity.
    let terminal = samples.filter { ["ready", "failed", "cancelled"].contains($0.status) }
    return (terminal.isEmpty ? samples : terminal).max { $0.at < $1.at }?.status
  }

  private static func timeline(
    stage: Stage, intent: AudioPipelineIntent?, upload: UploadOperation?, job: Job?
  ) -> [AudioStepPresentation] {
    let sourceKind = intent?.sourceKind ?? job?.sourceKind ?? upload?.sourceKind
    let steps: [Stage] =
      (sourceKind == .url ? [.source, .download] : []) + [
        .prepare, .reserve, .upload, .confirm, .queued, .validating, .processing, .uploadingResult,
        .ready,
      ]
    let current = steps.firstIndex(of: stage == .awaitingUpload ? .upload : stage)
    let known = lastRecordedStage(job: job, upload: upload).flatMap { steps.firstIndex(of: $0) }
    let rank = current ?? known
    var result = steps.enumerated().map { index, step in
      let state: AudioStepState
      if stage == .ready || rank.map({ index < $0 }) == true {
        state = .complete
      } else if index == current {
        state = .active
      } else {
        state = .pending
      }
      let timingStage: String? =
        switch step {
        case .download: "source-download"
        case .queued: "queue"
        case .validating: "input-validation"
        case .processing: "separation"
        case .uploadingResult: "output-upload"
        default: nil
        }
      return AudioStepPresentation(
        id: step.timelineKey, titleKey: step.timelineKey, state: state,
        occurredAt: stageDate(step, job: job),
        measurement: job?.serverStageTimings?.stages.first(where: { $0.stage == timingStage }))
    }
    if current == nil {
      // A failure/cancellation need not retain its previous local phase. Show
      // the known outcome explicitly instead of inventing a failed step.
      let state: AudioStepState =
        stage == .failed
        ? .failed
        : stage == .cancelled
          ? .cancelled
          : stage.isActive ? .active : .pending
      result.insert(
        AudioStepPresentation(
          id: stage.statusKey, titleKey: stage.statusKey, state: state,
          occurredAt: stage.isActive ? nil : job?.finishedAt ?? intent?.completedAt),
        at: known.map { $0 + 1 } ?? 0)
    }
    return result
  }

  private static func lastRecordedStage(job: Job?, upload: UploadOperation?) -> Stage? {
    if job?.stages?.uploadingResultAt != nil { return .uploadingResult }
    if job?.stages?.processingStartedAt != nil { return .processing }
    if job?.stages?.validatingAt != nil { return .validating }
    if job?.queuedAt != nil { return .queued }
    if let upload, upload.phase != .stopped { return uploadStage(upload.phase) }
    if job != nil { return .upload }
    return nil
  }

  private static func stageDate(_ stage: Stage, job: Job?) -> Date? {
    switch stage {
    case .reserve: return job?.createdAt
    case .queued: return job?.queuedAt
    case .validating: return job?.stages?.validatingAt
    case .processing: return job?.stages?.processingStartedAt
    case .uploadingResult: return job?.stages?.uploadingResultAt
    case .ready: return job?.status == "ready" ? job?.finishedAt : nil
    default: return nil
    }
  }

  private static func serverStage(_ status: String) -> Stage {
    switch status {
    case "awaiting_upload": return .awaitingUpload
    case "queued": return .queued
    case "validating": return .validating
    case "processing": return .processing
    case "uploading_result": return .uploadingResult
    case "interrupted": return .interrupted
    case "cancel_requested": return .cancelling
    case "ready": return .ready
    case "failed": return .failed
    case "cancelled": return .cancelled
    default: return .unknown
    }
  }

  private static func uploadStage(_ phase: UploadPhase) -> Stage {
    switch phase {
    case .reservationPending: return .reserve
    case .uploadPending, .uploading: return .upload
    case .confirmationPending: return .confirm
    case .submitted: return .queued
    case .stopped: return .failed
    }
  }

  private static func localStage(_ phase: AudioPipelinePhase) -> Stage {
    switch phase {
    case .inspectingSource: return .inspect
    case .preparingInput: return .prepare
    case .reservingJob: return .reserve
    case .uploadingInput: return .upload
    case .confirmingUpload: return .confirm
    case .waitingProcessing: return .queued
    case .ready: return .ready
    case .awaitingAppResume: return .awaitingAppResume
    case .awaitingConfirmation: return .review
    case .cancelling: return .cancelling
    case .failed: return .failed
    case .cancelled: return .cancelled
    case .deleted: return .deleted
    }
  }

  private enum Stage {
    case inspect
    case source, download, prepare, reserve, upload, confirm, queued, validating, processing
    case uploadingResult, ready, awaitingUpload, awaitingAppResume, interrupted, cancelling
    case failed, cancelled, deleted, unknown, review

    var isActive: Bool {
      ![.ready, .failed, .cancelled, .deleted, .unknown].contains(self)
    }

    var timelineKey: String {
      switch self {
      case .source: return "processing_step_source"
      case .download: return "processing_step_download"
      default: return statusKey
      }
    }

    var statusKey: String {
      switch self {
      case .source: return "processing_finding_audio"
      case .download: return "processing_finding_downloading"
      case .inspect: return "media_inspecting"
      case .prepare: return "processing_preparing"
      case .reserve: return "processing_reserving"
      case .upload: return "processing_uploading_audio"
      case .confirm: return "processing_checking_upload"
      case .queued: return "processing_queued"
      case .validating: return "processing_validating"
      case .processing: return "processing_processing"
      case .uploadingResult: return "processing_uploading_result"
      case .ready: return "processing_ready"
      case .awaitingUpload: return "processing_awaiting_upload"
      case .awaitingAppResume: return "processing_awaiting_app"
      case .review: return "import_review_title"
      case .interrupted: return "processing_interrupted"
      case .cancelling: return "processing_cancelling"
      case .failed: return "processing_failed"
      case .cancelled: return "processing_cancelled"
      case .deleted: return "processing_deleted"
      case .unknown: return "processing_unknown"
      }
    }
  }
}
