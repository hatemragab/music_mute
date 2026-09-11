package com.hatem.musicmute.processing

enum class AudioTaskStage {
    REVIEW, WAITING, DOWNLOADING_SOURCE, PREPARING_INPUT, RESERVING_JOB, UPLOADING_INPUT,
    CONFIRMING_UPLOAD, QUEUED, VALIDATING, PROCESSING, UPLOADING_RESULT, INTERRUPTED,
    CANCELLING, READY, FAILED, CANCELLED, UNKNOWN,
}

data class AudioTaskPresentation(
    val operationId: String?,
    val jobId: String?,
    val displayName: String,
    val sourceTitle: String?,
    val sourceKind: SourceKind?,
    val stage: AudioTaskStage,
    val active: Boolean,
    val progressFraction: Float?,
    val transferredBytes: Long?,
    val totalBytes: Long?,
    val totalElapsedMs: Long?,
    val totalElapsedApproximate: Boolean,
    val processingElapsedMs: Long?,
    val processingElapsedApproximate: Boolean,
    val workerAvailable: Boolean?,
    val canCancel: Boolean,
    val canRetry: Boolean,
    val canDelete: Boolean,
    val canPlay: Boolean,
    val audioDurationMs: Long? = null,
    val errorCode: String? = null,
    val problem: JobsProblem? = null,
    val localProblem: ProcessingLocalProblem? = null,
)

fun audioTaskPresentations(
    operations: List<ProcessingOperation>,
    jobs: List<Job>,
    nowMillis: Long,
): List<AudioTaskPresentation> {
    val operationsByJob = operations.filter { it.jobId != null }.associateBy { it.jobId }
    val operationsByRequest = operations.associateBy { it.requestId }
    val merged = jobs.map { job ->
        val operation = operationsByJob[job.id] ?: job.requestId?.let(operationsByRequest::get)
        presentation(operation, job, nowMillis)
    }.toMutableList()
    val represented = merged.mapNotNull { it.operationId }.toSet()
    operations.filterNot { it.operationId in represented || it.pendingDelete }
        .forEach { merged += presentation(it, null, nowMillis) }
    return merged.sortedByDescending { task ->
        jobs.firstOrNull { it.id == task.jobId }?.createdAt?.toEpochMilli()
            ?: operations.firstOrNull { it.operationId == task.operationId }?.acceptedAtMillis
            ?: 0
    }
}

private fun presentation(
    operation: ProcessingOperation?,
    job: Job?,
    nowMillis: Long,
): AudioTaskPresentation {
    val stage = resolvedTaskStage(operation, job)
    val active = stage in setOf(
        AudioTaskStage.WAITING, AudioTaskStage.DOWNLOADING_SOURCE, AudioTaskStage.PREPARING_INPUT,
        AudioTaskStage.RESERVING_JOB, AudioTaskStage.UPLOADING_INPUT, AudioTaskStage.CONFIRMING_UPLOAD,
        AudioTaskStage.QUEUED, AudioTaskStage.VALIDATING, AudioTaskStage.PROCESSING,
        AudioTaskStage.UPLOADING_RESULT, AudioTaskStage.INTERRUPTED, AudioTaskStage.CANCELLING,
    )
    val transferred = when (stage) {
        AudioTaskStage.DOWNLOADING_SOURCE -> operation?.sourceDownloadedBytes?.takeIf { it > 0 }
        AudioTaskStage.UPLOADING_INPUT -> operation?.uploadedBytes?.takeIf { it > 0 }
        else -> null
    }
    val total = when (stage) {
        AudioTaskStage.DOWNLOADING_SOURCE -> operation?.sourceTotalBytes
        AudioTaskStage.UPLOADING_INPUT -> operation?.input?.bytes
        else -> null
    }
    val progress = if (transferred != null && total != null && total > 0)
        (transferred.toDouble() / total).toFloat().coerceIn(0f, 1f) else null
    val localElapsed = operation?.clientStartedAtMillis?.takeIf { it > 0 }?.let {
        val end = if (active) nowMillis else job?.finishedAt?.toEpochMilli()
        end?.let { endMillis -> (endMillis - it).coerceAtLeast(0) }
    }
    val display = operation?.displayName?.takeIf { it.isNotBlank() }
        ?: job?.displayName?.takeIf { it.isNotBlank() }
        ?: job?.sourceTitle?.takeIf { it.isNotBlank() }
        ?: "Audio"
    return AudioTaskPresentation(
        operationId = operation?.operationId,
        jobId = job?.id ?: operation?.jobId,
        displayName = display,
        sourceTitle = operation?.sourceTitle?.takeIf { it.isNotBlank() } ?: job?.sourceTitle,
        sourceKind = operation?.sourceKind ?: job?.sourceKind?.let { value ->
            SourceKind.entries.firstOrNull { it.wireValue == value }
        },
        stage = stage,
        active = active,
        progressFraction = progress,
        transferredBytes = transferred,
        totalBytes = total,
        totalElapsedMs = job?.timing?.totalElapsedMs ?: localElapsed,
        totalElapsedApproximate = job?.timing?.totalElapsedApproximate ?: active,
        processingElapsedMs = job?.timing?.processingElapsedMs,
        processingElapsedApproximate = job?.timing?.processingElapsedApproximate ?: false,
        workerAvailable = job?.workerAvailable,
        canCancel = active,
        canRetry = stage == AudioTaskStage.FAILED || (!active && operation?.localProblem != null),
        canDelete = stage in setOf(AudioTaskStage.READY, AudioTaskStage.FAILED, AudioTaskStage.CANCELLED) ||
            (!active && job == null),
        canPlay = stage == AudioTaskStage.READY && job?.canDownloadOutput == true,
        audioDurationMs = (job?.input?.durationSeconds ?: operation?.input?.durationSeconds)
            ?.takeIf { it.isFinite() && it > 0 && it < Long.MAX_VALUE / 1_000.0 }
            ?.let { (it * 1_000).toLong() },
        errorCode = if (stage == AudioTaskStage.FAILED) job?.error?.code else null,
        problem = if (stage == AudioTaskStage.FAILED || stage == AudioTaskStage.WAITING) operation?.problem else null,
        localProblem = if (stage == AudioTaskStage.FAILED) operation?.localProblem else null,
    )
}

private fun resolvedTaskStage(operation: ProcessingOperation?, job: Job?): AudioTaskStage {
    if (operation?.awaitingCloudConsent == true && !operation.cancellationRequested) return AudioTaskStage.REVIEW
    val server = (job?.status ?: operation?.serverStatus)?.let(::serverStage)
    if (server in setOf(AudioTaskStage.READY, AudioTaskStage.FAILED, AudioTaskStage.CANCELLED))
        return server!!
    val local = operation?.phase?.let(::localStage)
    if (local == AudioTaskStage.CANCELLING) return local
    if (server == AudioTaskStage.WAITING &&
        local in setOf(
            AudioTaskStage.UPLOADING_INPUT,
            AudioTaskStage.CONFIRMING_UPLOAD,
            AudioTaskStage.FAILED,
        )) return local!!
    return server ?: local ?: AudioTaskStage.UNKNOWN
}

private fun serverStage(status: String): AudioTaskStage = when (status) {
    "awaiting_upload" -> AudioTaskStage.WAITING
    "queued" -> AudioTaskStage.QUEUED
    "validating" -> AudioTaskStage.VALIDATING
    "processing" -> AudioTaskStage.PROCESSING
    "uploading_result" -> AudioTaskStage.UPLOADING_RESULT
    "interrupted" -> AudioTaskStage.INTERRUPTED
    "cancel_requested" -> AudioTaskStage.CANCELLING
    "ready" -> AudioTaskStage.READY
    "failed" -> AudioTaskStage.FAILED
    "cancelled" -> AudioTaskStage.CANCELLED
    else -> AudioTaskStage.UNKNOWN
}

private fun localStage(phase: ProcessingPhase): AudioTaskStage = when (phase) {
    ProcessingPhase.SOURCE_INTAKE, ProcessingPhase.SOURCE_QUEUED, ProcessingPhase.WAITING ->
        AudioTaskStage.WAITING
    ProcessingPhase.DOWNLOADING_SOURCE -> AudioTaskStage.DOWNLOADING_SOURCE
    ProcessingPhase.PREPARING_INPUT -> AudioTaskStage.PREPARING_INPUT
    ProcessingPhase.RESERVING -> AudioTaskStage.RESERVING_JOB
    ProcessingPhase.UPLOADING -> AudioTaskStage.UPLOADING_INPUT
    ProcessingPhase.CONFIRMING -> AudioTaskStage.CONFIRMING_UPLOAD
    ProcessingPhase.CANCELLING -> AudioTaskStage.CANCELLING
    ProcessingPhase.RETRY_WAIT -> AudioTaskStage.WAITING
    ProcessingPhase.PAUSED -> AudioTaskStage.FAILED
    ProcessingPhase.COMPLETE -> AudioTaskStage.UNKNOWN
}
