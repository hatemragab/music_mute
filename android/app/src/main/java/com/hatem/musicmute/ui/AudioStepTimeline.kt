package com.hatem.musicmute.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Cancel
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.PauseCircleOutline
import androidx.compose.material.icons.outlined.RadioButtonChecked
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
import com.hatem.musicmute.processing.AudioStepState
import com.hatem.musicmute.processing.audioTaskTimeline
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import com.hatem.musicmute.ui.design.CreativeTokens

@Composable
fun AudioStepTimeline(task: AudioTaskPresentation) {
    val steps = audioTaskTimeline(task)
    Column(verticalArrangement = Arrangement.spacedBy(CreativeTokens.CompactGap)) {
        Text(stringResource(R.string.audio_task_timeline), style = MaterialTheme.typography.titleMedium)
        Column {
            steps.forEachIndexed { index, step ->
                val status = stringResource(when (step.state) {
                    AudioStepState.COMPLETE -> R.string.ui_step_complete
                    AudioStepState.CURRENT -> R.string.ui_step_current
                    AudioStepState.PENDING -> R.string.ui_step_pending
                    else -> audioTaskStageLabel(task.stage)
                })
                val color = when (step.state) {
                    AudioStepState.COMPLETE, AudioStepState.CURRENT -> MaterialTheme.colorScheme.primary
                    AudioStepState.FAILED -> MaterialTheme.colorScheme.error
                    else -> MaterialTheme.colorScheme.outline
                }
                Row(
                    Modifier.fillMaxWidth().height(IntrinsicSize.Min)
                        .semantics(mergeDescendants = true) { stateDescription = status },
                    verticalAlignment = Alignment.Top,
                    horizontalArrangement = Arrangement.spacedBy(CreativeTokens.CompactGap),
                ) {
                    Column(Modifier.width(24.dp).fillMaxHeight(), horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(
                            when (step.state) {
                                AudioStepState.COMPLETE -> Icons.Outlined.CheckCircle
                                AudioStepState.CURRENT -> Icons.Outlined.RadioButtonChecked
                                AudioStepState.INTERRUPTED -> Icons.Outlined.PauseCircleOutline
                                AudioStepState.FAILED -> Icons.Outlined.ErrorOutline
                                AudioStepState.CANCELLED -> Icons.Outlined.Cancel
                                AudioStepState.PENDING -> Icons.Outlined.RadioButtonUnchecked
                            },
                            contentDescription = null,
                            modifier = Modifier.size(24.dp),
                            tint = color,
                        )
                        if (index != steps.lastIndex) Box(
                            Modifier.width(1.dp).weight(1f).heightIn(min = 16.dp).background(
                                if (step.state == AudioStepState.COMPLETE) MaterialTheme.colorScheme.primary
                                else MaterialTheme.colorScheme.outlineVariant),
                        )
                    }
                    Text(
                        stringResource(audioTaskStageLabel(step.stage)),
                        modifier = Modifier.weight(1f).padding(bottom = if (index == steps.lastIndex) 0.dp else 16.dp),
                        style = if (step.state == AudioStepState.CURRENT) MaterialTheme.typography.titleSmall
                            else MaterialTheme.typography.bodyMedium,
                        color = if (step.state == AudioStepState.PENDING) MaterialTheme.colorScheme.onSurfaceVariant
                            else MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
        }
    }
}
