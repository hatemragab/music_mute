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
                    step.measurement?.takeIf { it.durationMs >= 0 }?.let {
                        val duration = String.format(java.util.Locale.getDefault(), "%.1f s", it.durationMs / 1000.0)
                        Text(if (it.complete) duration else stringResource(R.string.timing_partial, duration),
                            style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }
        task.serverStageTimings?.let { timing ->
            HorizontalDivider()
            Text(stringResource(R.string.server_timings), style = MaterialTheme.typography.titleMedium)
            Text(stringResource(R.string.timing_note), style = MaterialTheme.typography.bodySmall)
            timing.stages.filter { it.durationMs >= 0 }.forEach { measurement ->
                ServerTimingRow(stringResource(serverTimingLabel(measurement.stage)), measurement.durationMs, measurement.complete)
            }
            timing.totalMs?.takeIf { it >= 0 }?.let {
                ServerTimingRow(stringResource(R.string.server_total), it, timing.totalComplete)
            }
        }
    }
}

@Composable
private fun ServerTimingRow(label: String, durationMs: Long, complete: Boolean) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
        val duration = String.format(java.util.Locale.getDefault(), "%.1f s", durationMs / 1000.0)
        Text(if (complete) duration else stringResource(R.string.timing_partial, duration),
            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace))
    }
}

private fun serverTimingLabel(stage: String): Int = when (stage) {
    "import-queue" -> R.string.timing_stage_import_queue
    "source-download" -> R.string.timing_stage_source_download
    "source-validation" -> R.string.timing_stage_source_validation
    "source-upload" -> R.string.timing_stage_source_upload
    "upload-confirmation" -> R.string.timing_stage_upload_confirmation
    "submission-window" -> R.string.timing_stage_submission_window
    "queue" -> R.string.timing_stage_queue
    "retry-wait" -> R.string.timing_stage_retry_wait
    "resource-check" -> R.string.timing_stage_resource_check
    "input-download" -> R.string.timing_stage_input_download
    "input-validation" -> R.string.timing_stage_input_validation
    "preparation" -> R.string.timing_stage_preparation
    "model-load" -> R.string.timing_stage_model_load
    "separation" -> R.string.timing_stage_separation
    "denoise" -> R.string.timing_stage_denoise
    "trim" -> R.string.timing_stage_trim
    "encoding" -> R.string.timing_stage_encoding
    "output-validation" -> R.string.timing_stage_output_validation
    "output-ready" -> R.string.timing_stage_output_ready
    "output-upload" -> R.string.timing_stage_output_upload
    "completion" -> R.string.timing_stage_completion
    else -> R.string.timing_stage_other
}
