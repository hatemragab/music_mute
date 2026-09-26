package com.hatem.musicmute.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.processing.AudioStepState
import com.hatem.musicmute.processing.AudioTaskPresentation
import com.hatem.musicmute.processing.AudioTaskStage
import com.hatem.musicmute.processing.audioTaskTimeline
import com.hatem.musicmute.ui.*
import com.hatem.musicmute.ui.design.CreativeCard

@Composable
fun JobCard(task: AudioTaskPresentation, busy: Boolean, onOpen: () -> Unit, onCancel: () -> Unit, onRetry: () -> Unit) {
    val canOpen = !task.importOnly && (task.jobId != null || task.operationId != null)
    val failed = task.stage == AudioTaskStage.FAILED
    val accent = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
    val duration = task.audioDurationMs?.takeIf { !task.active }?.let(::formatElapsed)
    CreativeCard(
        modifier = Modifier.padding(bottom = 8.dp).clickable(enabled = canOpen, onClick = onOpen),
        contentPadding = 12.dp,
        contentGap = 0.dp,
        shape = RoundedCornerShape(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f)) {
                Text(task.displayName.ifBlank { stringResource(R.string.url_import_title) },
                    style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(cardStatus(task), maxLines = 1, overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (duration != null) Text(duration, style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
            JobAction(task, busy, onCancel, onRetry)
        }
        if (task.active) {
            Spacer(Modifier.height(8.dp))
            val steps = if (task.importRequestId != null) audioTaskTimeline(task) else emptyList()
            if (steps.isNotEmpty()) {
                Row(Modifier.fillMaxWidth().height(4.dp), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                    steps.forEach { step ->
                        val filled = step.state == AudioStepState.COMPLETE || step.state == AudioStepState.CURRENT
                        Box(Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(2.dp))
                            .background(if (filled) accent else MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.7f)))
                    }
                }
            } else {
                val progress = task.progressFraction
                val bar = Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp))
                if (progress != null) LinearProgressIndicator(progress = { progress }, modifier = bar)
                else LinearProgressIndicator(modifier = bar)
            }
        }
    }
}

@Composable
private fun cardStatus(task: AudioTaskPresentation): String {
    if (task.importOnly) task.errorCode?.let { return stringResource(urlImportMessage(it)) }
    audioTaskFailureLabel(task)?.let { return stringResource(it) }
    if (task.active && task.workerAvailable == false) return stringResource(R.string.listener_stage_paused)
    val stage = stringResource(listenerStageLabel(task.stage))
    val elapsed = task.totalElapsedMs?.takeIf { task.active }?.let(::formatElapsed) ?: return stage
    val clock = if (task.totalElapsedApproximate) "$elapsed · ${stringResource(R.string.audio_task_approximate)}" else elapsed
    return "$stage · $clock"
}

@Composable
private fun JobAction(task: AudioTaskPresentation, busy: Boolean, onCancel: () -> Unit, onRetry: () -> Unit) {
    when {
        task.canCancel && task.stage != AudioTaskStage.CANCELLING ->
            TextButton(onClick = onCancel, enabled = !busy, modifier = Modifier.heightIn(min = 40.dp)) {
                Text(stringResource(R.string.auth_cancel))
            }
        task.canRetry ->
            TextButton(onClick = onRetry, enabled = !busy, modifier = Modifier.heightIn(min = 40.dp)) {
                Text(stringResource(R.string.retry))
            }
    }
}
