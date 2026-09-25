package com.hatem.musicmute.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.processing.AudioTaskPresentation
import com.hatem.musicmute.processing.AudioTaskStage
import com.hatem.musicmute.ui.*

@Composable
fun JobCard(task: AudioTaskPresentation, busy: Boolean, onOpen: () -> Unit, onCancel: () -> Unit, onRetry: () -> Unit, onDelete: () -> Unit) {
    val accent = if (task.stage == AudioTaskStage.FAILED) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
    Box(Modifier.fillMaxWidth().padding(bottom = 10.dp).clip(RoundedCornerShape(8.dp))
        .background(MaterialTheme.colorScheme.surfaceContainerLow)) {
        Box(Modifier.matchParentSize().padding(vertical = 16.dp)) {
            Box(Modifier.align(Alignment.CenterStart).fillMaxHeight().width(3.dp)
                .background(accent, RoundedCornerShape(3.dp)))
        }
        BoxWithConstraints(Modifier.fillMaxWidth().clickable(enabled = !task.importOnly && (task.jobId != null || task.operationId != null), onClick = onOpen)
            .heightIn(min = 84.dp).padding(start = 17.dp, end = 14.dp, top = 16.dp, bottom = 16.dp),
            contentAlignment = Alignment.CenterStart) {
            val showAction = task.stage != AudioTaskStage.READY
            val inlineAction = task.stage != AudioTaskStage.FAILED && maxWidth >= 280.dp && LocalDensity.current.fontScale < 1.3f
            val duration = task.audioDurationMs?.takeIf { !task.active }?.let(::formatElapsed)
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(task.displayName.ifBlank { stringResource(R.string.url_import_title) }, style = MaterialTheme.typography.titleMedium, maxLines = 1,
                            overflow = TextOverflow.Ellipsis)
                        if (task.stage == AudioTaskStage.READY) {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                Row(Modifier.background(accent.copy(alpha = 0.12f), RoundedCornerShape(6.dp))
                                    .padding(horizontal = 6.dp, vertical = 2.dp),
                                    horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Icon(Icons.Outlined.Check, null, modifier = Modifier.size(12.dp), tint = accent)
                                    Text(stringResource(R.string.creative_jobs_ready_badge), style = MaterialTheme.typography.labelSmall,
                                        color = accent)
                                }
                                Text(stringResource(R.string.creative_jobs_voice_format), modifier = Modifier.weight(1f),
                                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        } else {
                            Text(stringResource(audioTaskStageLabel(task.stage)), style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (task.importRequestId != null && task.active) {
                            val steps = com.hatem.musicmute.processing.audioTaskTimeline(task)
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                                steps.forEach { step ->
                                    val complete = step.state == com.hatem.musicmute.processing.AudioStepState.COMPLETE
                                    val current = step.state == com.hatem.musicmute.processing.AudioStepState.CURRENT
                                    Box(Modifier.weight(1f).height(3.dp).background(
                                        if (complete || current) accent else MaterialTheme.colorScheme.outlineVariant,
                                        RoundedCornerShape(2.dp)))
                                }
                            }
                        }
                        if (task.active) {
                            val progress = task.progressFraction
                            if (progress != null) LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth())
                            else LinearProgressIndicator(Modifier.fillMaxWidth())
                            task.totalElapsedMs?.let {
                                Text(stringResource(R.string.audio_task_total_time, formatElapsed(it)) +
                                    if (task.totalElapsedApproximate) " · " + stringResource(R.string.audio_task_approximate) else "",
                                    style = MaterialTheme.typography.labelSmall)
                            }
                        }
                    }
                    if (duration != null) Text(duration, style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                    if (showAction && inlineAction) JobAction(task, busy, onOpen, onCancel, onRetry)
                }
                if (task.importOnly) task.errorCode?.let {
                    Text(stringResource(urlImportMessage(it)), color = MaterialTheme.colorScheme.error)
                }
                else audioTaskFailureLabel(task)?.let { Text(stringResource(it), color = MaterialTheme.colorScheme.error) }
                if (task.active && task.workerAvailable == false) Text(stringResource(R.string.processing_worker_offline))
                if (showAction && !inlineAction) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    if (task.stage == AudioTaskStage.FAILED && task.canDelete) {
                        TextButton(onClick = onDelete, enabled = !busy,
                            colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) {
                            Text(stringResource(R.string.audio_task_delete))
                        }
                    }
                    JobAction(task, busy, onOpen, onCancel, onRetry)
                }
            }
        }
    }
}

@Composable
private fun JobAction(task: AudioTaskPresentation, busy: Boolean, onOpen: () -> Unit, onCancel: () -> Unit, onRetry: () -> Unit) {
    when {
        task.canCancel && task.stage != AudioTaskStage.CANCELLING ->
            TextButton(onClick = onCancel, enabled = !busy) { Text(stringResource(R.string.auth_cancel)) }
        task.canRetry ->
            TextButton(onClick = onRetry, enabled = !busy) { Text(stringResource(R.string.retry)) }
        !task.importOnly && (task.jobId != null || task.operationId != null) -> TextButton(onClick = onOpen) {
            Text(stringResource(R.string.processing_details))
        }
    }
}
