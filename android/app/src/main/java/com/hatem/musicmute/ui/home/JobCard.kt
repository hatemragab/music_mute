package com.hatem.musicmute.ui.home

import android.text.format.DateUtils
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.processing.AudioStepState
import com.hatem.musicmute.processing.AudioTaskPresentation
import com.hatem.musicmute.processing.AudioTaskStage
import com.hatem.musicmute.processing.SourceKind
import com.hatem.musicmute.processing.audioTaskTimeline
import com.hatem.musicmute.ui.audioTaskFailureLabel
import com.hatem.musicmute.ui.design.CreativeCard
import com.hatem.musicmute.ui.design.CreativeStatusPill
import com.hatem.musicmute.ui.design.CreativeTokens
import com.hatem.musicmute.ui.formatElapsed
import com.hatem.musicmute.ui.listenerStageLabel
import kotlin.math.roundToInt

@Composable
fun JobCard(
    task: AudioTaskPresentation,
    busy: Boolean,
    onOpen: () -> Unit,
    onCancel: () -> Unit,
) {
    val canOpen = !task.importOnly && (task.jobId != null || task.operationId != null)
    if (task.stage == AudioTaskStage.READY) {
        ReadyJobCard(task, canOpen, onOpen)
        return
    }
    val failed = task.stage == AudioTaskStage.FAILED
    val supportingText = cardSupportingText(task)
    CreativeCard(
        modifier = Modifier.clickable(enabled = canOpen, onClick = onOpen),
        contentPadding = 16.dp,
        contentGap = 12.dp,
        shape = RoundedCornerShape(20.dp),
    ) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            JobLeadingIcon(task, failed)
            Column(
                Modifier.weight(1f).padding(top = 2.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(
                    task.displayName.ifBlank { stringResource(R.string.url_import_title) },
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                relativeCreatedAt(task)?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                    )
                }
            }
            JobStatusPill(task)
        }
        supportingText?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = if (failed) MaterialTheme.colorScheme.error
                else MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (task.active) JobProgress(task)
        JobActions(
            task = task,
            busy = busy,
            onCancel = onCancel,
        )
    }
}

@Composable
private fun ReadyJobCard(
    task: AudioTaskPresentation,
    canOpen: Boolean,
    onOpen: () -> Unit,
) {
    CreativeCard(
        contentPadding = 16.dp,
        contentGap = 0.dp,
        shape = RoundedCornerShape(20.dp),
        onClick = onOpen.takeIf { canOpen },
    ) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            ReadyLinkIcon()
            Text(
                task.displayName.ifBlank { stringResource(R.string.url_import_title) },
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.titleMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            JobStatusPill(task)
        }
    }
}

@Composable
private fun ReadyLinkIcon() {
    Surface(
        modifier = Modifier.size(48.dp),
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        contentColor = MaterialTheme.colorScheme.primary,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(Icons.Outlined.Link, null, Modifier.size(24.dp))
        }
    }
}

@Composable
private fun JobLeadingIcon(task: AudioTaskPresentation, failed: Boolean) {
    val icon = if (task.importOnly || task.sourceKind == SourceKind.URL) Icons.Outlined.Link
    else Icons.Outlined.GraphicEq
    val container = if (failed) MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.5f)
    else MaterialTheme.colorScheme.surfaceContainerHigh
    val content = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
    Surface(
        modifier = Modifier.size(56.dp),
        shape = RoundedCornerShape(16.dp),
        color = container,
        contentColor = content,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(icon, null, Modifier.size(26.dp))
        }
    }
}

@Composable
private fun JobStatusPill(task: AudioTaskPresentation) {
    val failed = task.stage == AudioTaskStage.FAILED
    val ready = task.stage == AudioTaskStage.READY
    val cancelled = task.stage == AudioTaskStage.CANCELLED
    val label = when {
        ready -> stringResource(R.string.creative_jobs_ready_badge)
        task.importOnly && failed -> stringResource(R.string.url_import_failed)
        else -> stringResource(listenerStageLabel(task.stage))
    }
    val icon = when {
        ready -> Icons.Outlined.CheckCircle
        failed || cancelled -> Icons.Outlined.ErrorOutline
        else -> Icons.Outlined.Schedule
    }
    val container: Color
    val content: Color
    when {
        failed -> {
            container = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.68f)
            content = MaterialTheme.colorScheme.onErrorContainer
        }
        cancelled -> {
            container = MaterialTheme.colorScheme.surfaceContainerHighest
            content = MaterialTheme.colorScheme.onSurfaceVariant
        }
        else -> {
            container = MaterialTheme.colorScheme.primaryContainer
            content = MaterialTheme.colorScheme.onPrimaryContainer
        }
    }
    CreativeStatusPill(
        label = label,
        icon = icon,
        modifier = Modifier.widthIn(max = 156.dp),
        containerColor = container,
        contentColor = content,
    )
}

@Composable
private fun JobProgress(task: AudioTaskPresentation) {
    val steps = audioTaskTimeline(task)
    val progress = task.progressFraction
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(
            Modifier.weight(1f).height(5.dp),
            horizontalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            steps.forEach { step ->
                val complete = step.state == AudioStepState.COMPLETE || step.state == AudioStepState.CURRENT
                Box(
                    Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(3.dp))
                        .background(
                            if (complete) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.72f),
                        ),
                )
            }
        }
        progress?.let {
            Text(
                "${(it * 100).roundToInt()}%",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.primary,
            )
        }
    }
}

@Composable
private fun JobActions(
    task: AudioTaskPresentation,
    busy: Boolean,
    onCancel: () -> Unit,
) {
    val canCancel = task.canCancel && task.stage != AudioTaskStage.CANCELLING
    if (!canCancel) return
    TextButton(
        onClick = onCancel,
        enabled = !busy,
        modifier = Modifier.heightIn(min = CreativeTokens.TouchTarget),
    ) {
        Text(stringResource(R.string.auth_cancel))
    }
}

@Composable
private fun cardSupportingText(task: AudioTaskPresentation): String? {
    if (task.importOnly) task.errorCode?.let { return stringResource(urlImportMessage(it)) }
    audioTaskFailureLabel(task)?.let { return stringResource(it) }
    if (task.active && task.workerAvailable == false) return stringResource(R.string.listener_stage_paused)
    val duration = task.audioDurationMs?.takeIf { !task.active }?.let(::formatElapsed)
    if (!task.active) return duration
    val elapsed = task.totalElapsedMs?.let(::formatElapsed) ?: return null
    return if (task.totalElapsedApproximate) {
        "$elapsed · ${stringResource(R.string.audio_task_approximate)}"
    } else {
        elapsed
    }
}

private fun relativeCreatedAt(task: AudioTaskPresentation): String? {
    if (task.createdAtMillis <= 0) return null
    return DateUtils.getRelativeTimeSpanString(
        task.createdAtMillis,
        System.currentTimeMillis(),
        DateUtils.MINUTE_IN_MILLIS,
        DateUtils.FORMAT_ABBREV_RELATIVE,
    ).toString()
}
