package com.hatem.musicmute.processing

enum class AudioTaskStage {
    REVIEW, WAITING, DOWNLOADING_SOURCE, INSPECTING, PREPARING_INPUT, RESERVING_JOB, UPLOADING_INPUT,
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
    val lastReachedStage: AudioTaskStage = stage,
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
        AudioTaskStage.WAITING, AudioTaskStage.DOWNLOADING_SOURCE, AudioTaskStage.INSPECTING, AudioTaskStage.PREPARING_INPUT,
        AudioTaskStage.RESERVING_JOB, AudioTaskStage.UPLOADING_INPUT, AudioTaskStage.CONFIRMING_UPLOAD,
        AudioTaskStage.QUEUED, AudioTaskStage.VALIDATING, AudioTaskStage.PROCESSING,
        AudioTaskStage.UPLOADING_RESULT, AudioTaskStage.INTERRUPTED, AudioTaskStage.CANCELLING,
    )
    val transferred = when (stage) {
        AudioTaskStage.DOWNLOADING_SOURCE -> operation?.sourceDownloadedBytes?.coerceAtLeast(0)
        AudioTaskStage.UPLOADING_INPUT -> operation?.uploadedBytes?.coerceAtLeast(0)
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
        lastReachedStage = lastReachedStage(stage, operation, job),
    )
}

private fun resolvedTaskStage(operation: ProcessingOperation?, job: Job?): AudioTaskStage {
    if (operation?.awaitingCloudConsent == true && !operation.cancellationRequested) return AudioTaskStage.REVIEW
    // A reservation cannot return to awaiting_upload after confirmation. The
    // history poll may still contain the earlier reservation while upload work
    // has already persisted the confirmation response.
    val status = if (job?.status == "awaiting_upload" &&
        JobStatus.entries.any { it != JobStatus.AWAITING_UPLOAD && it.wireValue == operation?.serverStatus }
    ) operation?.serverStatus else job?.status ?: operation?.serverStatus
    val server = status?.let(::serverStage)
    if (server in setOf(AudioTaskStage.READY, AudioTaskStage.FAILED, AudioTaskStage.CANCELLED))
        return server!!
    val local = operation?.progressPhase?.let(::localStage)
    if (local == AudioTaskStage.CANCELLING) return local
    if (server == AudioTaskStage.WAITING &&
        local in setOf(
            AudioTaskStage.RESERVING_JOB,
            AudioTaskStage.UPLOADING_INPUT,
            AudioTaskStage.CONFIRMING_UPLOAD,
            AudioTaskStage.FAILED,
        )) return local!!
    return server ?: local ?: AudioTaskStage.UNKNOWN
}

private fun lastReachedStage(stage: AudioTaskStage, operation: ProcessingOperation?, job: Job?): AudioTaskStage {
    // Use durable evidence, not a remembered UI rank: reopening a failed job
    // must retain history, and a different job must never inherit its progress.
    val recorded = when {
        job?.stages?.uploadingResultAt != null || job?.stages?.processingFinishedAt != null -> AudioTaskStage.UPLOADING_RESULT
        job?.stages?.processingStartedAt != null -> AudioTaskStage.PROCESSING
        job?.stages?.validatingAt != null -> AudioTaskStage.VALIDATING
        job?.queuedAt != null -> AudioTaskStage.QUEUED
        else -> AudioTaskStage.UNKNOWN
    }
    val localEvidence = when {
        operation?.hasUploadedInput == true -> AudioTaskStage.CONFIRMING_UPLOAD
        job != null || operation?.jobId != null -> AudioTaskStage.UPLOADING_INPUT
        operation?.input != null -> AudioTaskStage.RESERVING_JOB
        operation?.sourceTotalBytes?.let { it > 0 && operation.sourceDownloadedBytes >= it } == true -> AudioTaskStage.PREPARING_INPUT
        else -> AudioTaskStage.UNKNOWN
    }
    return listOfNotNull(stage, recorded, localEvidence,
        operation?.serverStatus?.let(::serverStage), operation?.progressPhase?.let(::localStage),
        operation?.lastReachedPhase?.let(::localStage))
        .maxBy(::taskStageRank)
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
    ProcessingPhase.INSPECTING -> AudioTaskStage.INSPECTING
    ProcessingPhase.PREPARING_INPUT -> AudioTaskStage.PREPARING_INPUT
    ProcessingPhase.RESERVING -> AudioTaskStage.RESERVING_JOB
    ProcessingPhase.UPLOADING -> AudioTaskStage.UPLOADING_INPUT
    ProcessingPhase.CONFIRMING -> AudioTaskStage.CONFIRMING_UPLOAD
    ProcessingPhase.CANCELLING -> AudioTaskStage.CANCELLING
    ProcessingPhase.RETRY_WAIT -> AudioTaskStage.WAITING
    ProcessingPhase.PAUSED -> AudioTaskStage.FAILED
    ProcessingPhase.COMPLETE -> AudioTaskStage.UNKNOWN
}
