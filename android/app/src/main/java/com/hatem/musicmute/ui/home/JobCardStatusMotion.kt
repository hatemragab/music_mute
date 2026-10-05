package com.hatem.musicmute.ui.home

import com.hatem.musicmute.processing.AudioTaskStage

/** A moving status is reserved for work that can still advance without a user action. */
internal fun jobCardStatusCanAnimate(
    stage: AudioTaskStage,
    active: Boolean,
    workerAvailable: Boolean?,
): Boolean = active && workerAvailable != false && when (stage) {
    AudioTaskStage.WAITING,
    AudioTaskStage.DOWNLOADING_SOURCE,
    AudioTaskStage.INSPECTING,
    AudioTaskStage.PREPARING_INPUT,
    AudioTaskStage.RESERVING_JOB,
    AudioTaskStage.UPLOADING_INPUT,
    AudioTaskStage.CONFIRMING_UPLOAD,
    AudioTaskStage.QUEUED,
    AudioTaskStage.VALIDATING,
    AudioTaskStage.PROCESSING,
    AudioTaskStage.UPLOADING_RESULT -> true
    AudioTaskStage.REVIEW,
    AudioTaskStage.INTERRUPTED,
    AudioTaskStage.CANCELLING,
    AudioTaskStage.READY,
    AudioTaskStage.FAILED,
    AudioTaskStage.CANCELLED,
    AudioTaskStage.UNKNOWN -> false
}
