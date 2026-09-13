package com.hatem.musicmute.ui

import android.animation.ValueAnimator
import android.os.SystemClock
import android.text.format.Formatter
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.processing.AudioTaskPresentation
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.delay
import androidx.compose.ui.text.style.TextOverflow
import com.hatem.musicmute.ui.design.CreativeTokens

@Composable
fun AudioTaskCard(
    task: AudioTaskPresentation,
    onOpen: () -> Unit,
    onCancel: () -> Unit,
    onRetry: () -> Unit,
    onDelete: () -> Unit,
) {
    val context = LocalContext.current
    val elapsed by produceState(
        task.totalElapsedMs,
        task.operationId,
        task.active,
        task.totalElapsedMs,
    ) {
        value = task.totalElapsedMs
        val base = task.totalElapsedMs
        if (!task.active || base == null) return@produceState
        val started = SystemClock.elapsedRealtime()
        while (true) {
            value = base + SystemClock.elapsedRealtime() - started
            delay(1_000)
        }
    }
    OutlinedCard(onClick = onOpen, modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            AudioTaskWaveform(task.active, Modifier.size(40.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text(task.displayName, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Crossfade(
                    task.stage,
                    animationSpec = if (ValueAnimator.areAnimatorsEnabled()) tween(200) else snap(),
                    label = "task-stage",
                ) {
                    Text(
                        androidx.compose.ui.res.stringResource(audioTaskStageLabel(it)),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                task.progressFraction?.let {
                    LinearProgressIndicator(progress = { it }, modifier = Modifier.fillMaxWidth())
                    Text(
                        "${Formatter.formatShortFileSize(context, task.transferredBytes ?: 0)} / " +
                            Formatter.formatShortFileSize(context, task.totalBytes ?: 0),
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
                elapsed?.let {
                    Text(androidx.compose.ui.res.stringResource(R.string.audio_task_total_time, formatElapsed(it)),
                        style = MaterialTheme.typography.labelSmall)
                }
                task.audioDurationMs?.let {
                    Text(androidx.compose.ui.res.stringResource(R.string.audio_task_duration, formatElapsed(it)),
                        style = MaterialTheme.typography.labelSmall)
                }
                audioTaskFailureLabel(task)?.let {
                    Text(androidx.compose.ui.res.stringResource(it), color = MaterialTheme.colorScheme.error)
                }
                if (task.active && task.workerAvailable == false) {
                    Text(androidx.compose.ui.res.stringResource(R.string.processing_worker_offline))
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(CreativeTokens.CompactGap)) {
                    if (task.canCancel && task.stage != com.hatem.musicmute.processing.AudioTaskStage.CANCELLING) TextButton(onClick = onCancel) {
                        Text(androidx.compose.ui.res.stringResource(R.string.auth_cancel))
                    }
                    if (task.canRetry) TextButton(onClick = onRetry) {
                        Text(androidx.compose.ui.res.stringResource(R.string.retry))
                    }
                    if (task.canDelete) TextButton(onClick = onDelete) {
                        Text(androidx.compose.ui.res.stringResource(R.string.audio_task_delete))
                    }
                }
            }
            Icon(Icons.Outlined.MoreVert, null)
        }
    }
}

@Composable
private fun AudioTaskWaveform(active: Boolean, modifier: Modifier = Modifier) {
    val animate = active && ValueAnimator.areAnimatorsEnabled()
    val transition = rememberInfiniteTransition(label = "waveform")
    val phase by transition.animateFloat(
        0f, if (animate) 1f else 0f,
        infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Restart),
        label = "waveform-phase",
    )
    val description = androidx.compose.ui.res.stringResource(
        if (active) R.string.audio_task_active_visual else R.string.audio_task_inactive_visual
    )
    val color = MaterialTheme.colorScheme.primary
    Canvas(modifier.clearAndSetSemantics { contentDescription = description }) {
        repeat(5) { index ->
            val height = size.height * (0.28f + (((index * 0.21f + phase) % 1f) *
                if (animate) 0.55f else 0.18f))
            val x = size.width * (index + 1) / 6f
            drawLine(
                color,
                Offset(x, (size.height - height) / 2),
                Offset(x, (size.height + height) / 2),
                strokeWidth = size.width / 11f,
                cap = StrokeCap.Round,
            )
        }
    }
}

fun formatElapsed(milliseconds: Long): String {
    val seconds = TimeUnit.MILLISECONDS.toSeconds(milliseconds.coerceAtLeast(0))
    val minutes = seconds / 60
    return "%d:%02d".format(minutes, seconds % 60)
}
