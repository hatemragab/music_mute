package com.hatem.musicmute.processing

enum class AudioStepState { COMPLETE, CURRENT, PENDING, INTERRUPTED, FAILED, CANCELLED }

data class AudioTaskStep(val stage: AudioTaskStage, val state: AudioStepState, val measurement: ServerStageMeasurement? = null)

/** Ordered steps are independent of rendering, so refreshes never own their history. */
fun audioTaskTimeline(task: AudioTaskPresentation): List<AudioTaskStep> {
    val stages = buildList {
        if (task.sourceKind == SourceKind.URL) add(AudioTaskStage.DOWNLOADING_SOURCE)
        addAll(listOf(
            AudioTaskStage.PREPARING_INPUT,
            AudioTaskStage.RESERVING_JOB,
            AudioTaskStage.UPLOADING_INPUT,
            AudioTaskStage.CONFIRMING_UPLOAD,
            AudioTaskStage.QUEUED,
            AudioTaskStage.VALIDATING,
            AudioTaskStage.PROCESSING,
            AudioTaskStage.UPLOADING_RESULT,
            AudioTaskStage.READY,
        ))
    }
    val rank = taskStageRank(task.lastReachedStage)
    return stages.map { stage ->
        val stepRank = taskStageRank(stage)
        val state = when {
            task.stage == AudioTaskStage.READY -> AudioStepState.COMPLETE
            stepRank == taskStageRank(task.stage) -> AudioStepState.CURRENT
            stepRank < rank -> AudioStepState.COMPLETE
            stepRank == rank && task.stage == AudioTaskStage.FAILED -> AudioStepState.FAILED
            stepRank == rank && task.stage == AudioTaskStage.CANCELLED -> AudioStepState.CANCELLED
            stepRank == rank && task.stage in setOf(
                AudioTaskStage.INTERRUPTED, AudioTaskStage.CANCELLING, AudioTaskStage.WAITING,
            ) -> AudioStepState.INTERRUPTED
            else -> AudioStepState.PENDING
        }
        val timingStage = when (stage) {
            AudioTaskStage.DOWNLOADING_SOURCE -> "source-download"
            AudioTaskStage.QUEUED -> "queue"
            AudioTaskStage.VALIDATING -> "input-validation"
            AudioTaskStage.PROCESSING -> "separation"
            AudioTaskStage.UPLOADING_RESULT -> "output-upload"
            else -> null
        }
        AudioTaskStep(stage, state, task.serverStageTimings?.stages?.firstOrNull { it.stage == timingStage })
    }
}

internal fun taskStageRank(stage: AudioTaskStage): Int = when (stage) {
    AudioTaskStage.REVIEW -> 0
    AudioTaskStage.WAITING -> 0
    AudioTaskStage.DOWNLOADING_SOURCE -> 1
    AudioTaskStage.INSPECTING, AudioTaskStage.PREPARING_INPUT -> 2
    AudioTaskStage.RESERVING_JOB -> 3
    AudioTaskStage.UPLOADING_INPUT -> 4
    AudioTaskStage.CONFIRMING_UPLOAD -> 5
    AudioTaskStage.QUEUED -> 6
    AudioTaskStage.VALIDATING -> 7
    AudioTaskStage.PROCESSING -> 8
    AudioTaskStage.UPLOADING_RESULT -> 9
    AudioTaskStage.READY -> 10
    AudioTaskStage.INTERRUPTED, AudioTaskStage.CANCELLING, AudioTaskStage.FAILED,
    AudioTaskStage.CANCELLED, AudioTaskStage.UNKNOWN -> -1
}
