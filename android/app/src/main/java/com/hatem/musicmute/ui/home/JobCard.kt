package com.hatem.musicmute.ui.home

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.processing.AudioTaskPresentation
import com.hatem.musicmute.processing.AudioTaskStage
import com.hatem.musicmute.ui.*
import com.hatem.musicmute.ui.design.*

@Composable
fun JobCard(task: AudioTaskPresentation, busy: Boolean, onOpen: () -> Unit, onCancel: () -> Unit, onRetry: () -> Unit) {
    CreativeCard(Modifier.clickable(onClick = onOpen), contentPadding = CreativeTokens.CompactCardPadding,
        contentGap = CreativeTokens.CompactGap) {
        BoxWithConstraints {
            val inlineAction = maxWidth >= 280.dp && LocalDensity.current.fontScale < 1.3f
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(when (task.stage) {
                        AudioTaskStage.READY -> Icons.Outlined.CheckCircle
                        AudioTaskStage.FAILED -> Icons.Outlined.ErrorOutline
                        else -> Icons.Outlined.Schedule
                    }, null, tint = if (task.stage == AudioTaskStage.FAILED) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(task.displayName, style = MaterialTheme.typography.titleMedium, maxLines = 2,
                            overflow = TextOverflow.Ellipsis)
                        Text(stringResource(audioTaskStageLabel(task.stage)), style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (task.active) {
                            val progress = task.progressFraction
                            if (progress != null) LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth())
                            else LinearProgressIndicator(Modifier.fillMaxWidth())
                            task.totalElapsedMs?.let {
                                Text(stringResource(R.string.audio_task_total_time, formatElapsed(it)) +
                                    if (task.totalElapsedApproximate) " · " + stringResource(R.string.audio_task_approximate) else "",
                                    style = MaterialTheme.typography.labelSmall)
                            }
                        } else {
                            task.audioDurationMs?.let {
                                Text(stringResource(R.string.audio_task_duration, formatElapsed(it)), style = MaterialTheme.typography.labelSmall)
                            }
                        }
                    }
                    if (inlineAction) JobAction(task, busy, onOpen, onCancel, onRetry)
                }
                audioTaskFailureLabel(task)?.let { Text(stringResource(it), color = MaterialTheme.colorScheme.error) }
                if (task.active && task.workerAvailable == false) Text(stringResource(R.string.processing_worker_offline))
                if (!inlineAction) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
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
        else -> TextButton(onClick = onOpen) {
            Text(stringResource(if (task.stage == AudioTaskStage.READY) R.string.creative_jobs_open_result else R.string.processing_details))
        }
    }
}
