package com.hatem.musicmute.ui

import com.hatem.musicmute.R
import com.hatem.musicmute.processing.JobsProblem
import com.hatem.musicmute.processing.AudioTaskStage
import com.hatem.musicmute.processing.AudioTaskPresentation
import com.hatem.musicmute.processing.ProcessingLocalProblem

internal fun audioTaskFailureLabel(task: AudioTaskPresentation): Int? {
    if (task.errorCode != null) return when (task.errorCode) {
        "INVALID_AUDIO" -> R.string.processing_reason_invalid
        "INPUT_TOO_LONG" -> R.string.processing_reason_too_long
        "INPUT_CHECKSUM_MISMATCH" -> R.string.processing_reason_checksum
        "DOWNLOAD_FAILED" -> R.string.processing_reason_download
        "OUTPUT_UPLOAD_FAILED" -> R.string.processing_reason_upload
        "OUTPUT_INVALID" -> R.string.processing_reason_output
        "SEPARATOR_FAILED" -> R.string.processing_reason_separator
        else -> R.string.processing_error_failed
    }
    task.problem?.let { return processingFailureLabel(it) }
    return when (task.localProblem) {
        ProcessingLocalProblem.STORAGE -> R.string.processing_error_storage
        ProcessingLocalProblem.INPUT_CHANGED -> R.string.processing_reason_invalid
        ProcessingLocalProblem.TRANSFER -> R.string.processing_reason_download
        ProcessingLocalProblem.RETRY_EXHAUSTED -> R.string.processing_reason_retries
        ProcessingLocalProblem.UNKNOWN_STATE -> R.string.processing_error_state
        null -> if (task.stage == AudioTaskStage.FAILED) R.string.processing_error_failed else null
    }
}

internal fun processingStatusLabel(status: String): Int = when (status) {
    "awaiting_upload" -> R.string.processing_awaiting_upload
    "queued" -> R.string.processing_queued
    "validating" -> R.string.processing_validating
    "processing" -> R.string.processing_processing
    "uploading_result" -> R.string.processing_uploading_result
    "interrupted" -> R.string.processing_interrupted
    "cancel_requested" -> R.string.processing_cancel_requested
    "ready" -> R.string.processing_ready
    "failed" -> R.string.processing_failed
    "cancelled" -> R.string.processing_cancelled
    else -> R.string.processing_unknown
}

internal fun processingFailureLabel(problem: JobsProblem): Int = when (problem) {
    JobsProblem.OFFLINE -> R.string.processing_error_offline
    JobsProblem.UNAUTHENTICATED -> R.string.processing_error_auth
    JobsProblem.INVALID_INPUT -> R.string.processing_error_input
    JobsProblem.JOB_NOT_FOUND -> R.string.processing_error_missing
    JobsProblem.NEW_INPUT_REQUIRED -> R.string.processing_error_retry_input
    JobsProblem.RATE_LIMITED -> R.string.processing_error_rate
    JobsProblem.IDEMPOTENCY_CONFLICT, JobsProblem.JOB_STATE_CONFLICT, JobsProblem.JOB_ACTIVE,
    JobsProblem.UPLOAD_NOT_READY -> R.string.processing_error_state
    JobsProblem.SERVICE_UNAVAILABLE -> R.string.processing_error_service
    else -> R.string.processing_error_policy
}

internal fun audioTaskStageLabel(stage: AudioTaskStage): Int = when (stage) {
    AudioTaskStage.WAITING -> R.string.audio_task_waiting
    AudioTaskStage.DOWNLOADING_SOURCE -> R.string.audio_task_downloading
    AudioTaskStage.PREPARING_INPUT -> R.string.audio_task_preparing
    AudioTaskStage.RESERVING_JOB -> R.string.audio_task_reserving
    AudioTaskStage.UPLOADING_INPUT -> R.string.audio_task_uploading
    AudioTaskStage.CONFIRMING_UPLOAD -> R.string.audio_task_confirming
    AudioTaskStage.QUEUED -> R.string.processing_queued
    AudioTaskStage.VALIDATING -> R.string.processing_validating
    AudioTaskStage.PROCESSING -> R.string.processing_processing
    AudioTaskStage.UPLOADING_RESULT -> R.string.processing_uploading_result
    AudioTaskStage.INTERRUPTED -> R.string.processing_interrupted
    AudioTaskStage.CANCELLING -> R.string.audio_task_cancelling
    AudioTaskStage.READY -> R.string.processing_ready
    AudioTaskStage.FAILED -> R.string.processing_failed
    AudioTaskStage.CANCELLED -> R.string.processing_cancelled
    AudioTaskStage.REVIEW -> R.string.audio_review_title
        AudioTaskStage.UNKNOWN -> R.string.processing_unknown
}
