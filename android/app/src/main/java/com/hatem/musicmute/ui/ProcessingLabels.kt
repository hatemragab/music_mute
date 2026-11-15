package com.hatem.musicmute.ui

import com.hatem.musicmute.R
import com.hatem.musicmute.processing.JobsProblem
import com.hatem.musicmute.processing.AudioTaskStage
import com.hatem.musicmute.processing.AudioTaskPresentation
import com.hatem.musicmute.processing.ProcessingLocalProblem

internal fun audioTaskFailureLabel(task: AudioTaskPresentation): Int? {
    if (task.errorCode != null) return when (task.errorCode) {
        "UPLOAD_EXPIRED" -> R.string.processing_reason_upload_expired
        "INVALID_AUDIO" -> R.string.processing_reason_invalid
        "MEDIA_TOO_LONG" -> R.string.media_error_too_long
        "MEDIA_TOO_LARGE" -> R.string.media_error_too_large
        "MEDIA_NO_AUDIO" -> R.string.media_error_no_audio
        "MEDIA_UNSUPPORTED", "MEDIA_DURATION_UNKNOWN" -> R.string.media_error_unsupported
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
        ProcessingLocalProblem.RESELECT_SOURCE -> R.string.media_error_reselect
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
    JobsProblem.MEDIA_TOO_LONG -> R.string.media_error_too_long
    JobsProblem.MEDIA_TOO_LARGE -> R.string.media_error_too_large
    JobsProblem.MEDIA_NO_AUDIO -> R.string.media_error_no_audio
    JobsProblem.MEDIA_DEFAULT_TRACK_UNAVAILABLE -> R.string.media_error_default_track
    JobsProblem.MEDIA_UNSUPPORTED -> R.string.media_error_unsupported
    JobsProblem.MEDIA_DURATION_UNKNOWN -> R.string.media_error_duration
    JobsProblem.YOUTUBE_PLAYLIST_UNSUPPORTED -> R.string.media_error_playlist
    JobsProblem.YOUTUBE_LIVE_UNSUPPORTED -> R.string.media_error_live
    JobsProblem.PROCESSING_ALLOWANCE_EXHAUSTED -> R.string.processing_error_allowance
    JobsProblem.PROCESSING_QUEUE_FULL -> R.string.processing_error_queue_full
    JobsProblem.PROCESSING_CAPACITY_UNAVAILABLE -> R.string.processing_error_capacity
    JobsProblem.PROCESSING_POLICY_INCOMPATIBLE -> R.string.processing_error_compatibility
    JobsProblem.PROCESSING_LIMIT_REACHED -> R.string.processing_error_active
    JobsProblem.OFFLINE -> R.string.processing_error_offline
    JobsProblem.UNAUTHENTICATED -> R.string.processing_error_auth
    JobsProblem.INVALID_INPUT -> R.string.processing_error_input
    JobsProblem.JOB_NOT_FOUND -> R.string.processing_error_missing
    JobsProblem.NEW_INPUT_REQUIRED -> R.string.processing_error_retry_input
    JobsProblem.UPLOAD_GRANT_LIMIT_REACHED, JobsProblem.UPLOAD_BYTE_LIMIT_REACHED,
    JobsProblem.UPLOAD_ATTEMPT_LIMIT_REACHED -> R.string.processing_error_upload_limit
    JobsProblem.DOWNLOAD_GRANT_LIMIT_REACHED, JobsProblem.DOWNLOAD_BYTE_LIMIT_REACHED,
    JobsProblem.DOWNLOAD_RESERVATION_EXPIRED -> R.string.processing_error_download_limit
    JobsProblem.RETAINED_STORAGE_LIMIT_REACHED -> R.string.processing_error_storage_limit
    JobsProblem.SERVICE_BANDWIDTH_LIMIT_REACHED -> R.string.processing_error_bandwidth_limit
    JobsProblem.RATE_LIMITED -> R.string.processing_error_rate
    JobsProblem.IDEMPOTENCY_CONFLICT, JobsProblem.JOB_STATE_CONFLICT, JobsProblem.JOB_ACTIVE,
    JobsProblem.UPLOAD_NOT_READY -> R.string.processing_error_state
    JobsProblem.SERVICE_UNAVAILABLE -> R.string.processing_error_service
    else -> R.string.processing_error_policy
}

internal fun audioTaskStageLabel(stage: AudioTaskStage): Int = when (stage) {
    AudioTaskStage.WAITING -> R.string.audio_task_waiting
    AudioTaskStage.DOWNLOADING_SOURCE -> R.string.audio_task_downloading
    AudioTaskStage.INSPECTING -> R.string.media_inspecting
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
