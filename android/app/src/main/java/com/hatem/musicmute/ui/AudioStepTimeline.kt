package com.hatem.musicmute.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.background
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.processing.AudioTaskPresentation
import com.hatem.musicmute.processing.AudioTaskStage
import com.hatem.musicmute.processing.SourceKind

@Composable
fun AudioStepTimeline(task: AudioTaskPresentation) {
    val steps = buildList {
        if (task.sourceKind == SourceKind.URL) add(
            AudioTaskStage.DOWNLOADING_SOURCE to R.string.audio_task_downloading
        )
        addAll(listOf(
        AudioTaskStage.PREPARING_INPUT to R.string.audio_task_preparing,
        AudioTaskStage.RESERVING_JOB to R.string.audio_task_reserving,
        AudioTaskStage.UPLOADING_INPUT to R.string.audio_task_uploading,
        AudioTaskStage.CONFIRMING_UPLOAD to R.string.audio_task_confirming,
        AudioTaskStage.QUEUED to R.string.processing_queued,
        AudioTaskStage.VALIDATING to R.string.processing_validating,
        AudioTaskStage.PROCESSING to R.string.processing_processing,
        AudioTaskStage.UPLOADING_RESULT to R.string.processing_uploading_result,
        AudioTaskStage.READY to R.string.processing_ready,
        ))
    }
    val currentRank = taskStageRank(task.stage)
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(stringResource(R.string.audio_task_timeline), style = MaterialTheme.typography.titleMedium)
        steps.forEachIndexed { index, (_, label) ->
            val rank = taskStageRank(steps[index].first)
            val completed = rank < currentRank || task.stage == AudioTaskStage.READY
            val current = rank == currentRank && !completed
            Row(verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(
                    if (completed) Icons.Outlined.CheckCircle
                    else Icons.Outlined.RadioButtonUnchecked,
                    null,
                    tint = if (completed || current) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.outline,
                )
                if (index != steps.lastIndex) Box(Modifier.width(1.dp).height(16.dp).background(
                    if (completed) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant))
                }
                Text(stringResource(label))
            }
        }
    }
}

private fun taskStageRank(stage: AudioTaskStage): Int = when (stage) {
    AudioTaskStage.REVIEW -> 2
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
