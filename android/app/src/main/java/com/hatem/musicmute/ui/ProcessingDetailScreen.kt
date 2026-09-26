package com.hatem.musicmute.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import com.hatem.musicmute.R
import com.hatem.musicmute.processing.JobHistoryState
import com.hatem.musicmute.processing.AudioTaskPresentation
import com.hatem.musicmute.ui.design.*
import com.hatem.musicmute.ui.library.RenameAudioSheet
import com.hatem.musicmute.ui.library.DeleteAudioSheet
import com.hatem.musicmute.processing.AudioTaskStage
import com.hatem.musicmute.ui.jobs.CompletedResultScreen
import com.hatem.musicmute.ui.jobs.PlaybackResultDetails

@Composable
fun ProcessingDetailScreen(
    state: JobHistoryState,
    task: AudioTaskPresentation?,
    busy: Boolean,
    artifactProgress: Float?,
    message: Int?,
    playing: Boolean = false,
    positionMs: Long = 0,
    durationMs: Long = 0,
    onSeek: (Long) -> Unit = {},
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onCancel: () -> Unit,
    onRetry: () -> Unit,
    onPlay: () -> Unit,
    onDownload: () -> Unit,
    onSave: () -> Unit,
    onShare: () -> Unit,
    onRename: (String) -> Unit,
    onDelete: () -> Unit,
    availableOffline: Boolean = false,
) {
    val context = LocalContext.current
    var renaming by rememberSaveable(task?.jobId, task?.operationId) { mutableStateOf(false) }
    var deleting by rememberSaveable(task?.jobId, task?.operationId) { mutableStateOf(false) }
    var renameFrom by rememberSaveable(task?.jobId, task?.operationId) { mutableStateOf<String?>(null) }
    LaunchedEffect(task?.displayName) {
        if (renameFrom != null && task?.displayName != renameFrom) {
            renaming = false
            renameFrom = null
        }
    }
    val ready = task?.stage == AudioTaskStage.READY
    if (ready) PlaybackResultDetails(
        task = task, busy = busy, refreshing = state.loading,
        availableOffline = availableOffline,
        canRetrieve = availableOffline || (state.detail?.canDownloadOutput ?: task.canPlay),
        artifactProgress = artifactProgress,
        message = (message ?: state.failure?.let(::processingFailureLabel))?.let { stringResource(it) },
        onBack = onBack, onRefresh = onRefresh, onPlay = onPlay, onDownload = onDownload,
        onSave = onSave, onShare = onShare,
        onRename = { renaming = true }, onDelete = { deleting = true },
    ) else CreativePage(Modifier.testTag("processing-detail")) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Outlined.ArrowBack, stringResource(R.string.back))
            }
            Text(stringResource(R.string.processing_details), style = MaterialTheme.typography.titleLarge)
        }
        if (task != null) {
            CreativeCard(contentPadding = 16.dp, contentGap = CreativeTokens.CompactGap) {
            Text(task.displayName, style = MaterialTheme.typography.titleLarge)
            task.audioDurationMs?.let {
                Text(stringResource(R.string.audio_task_duration, formatElapsed(it)))
            }
            audioTaskFailureLabel(task)?.let {
                Text(stringResource(it), color = MaterialTheme.colorScheme.error)
            }
            }
            if (task.totalElapsedMs != null || task.processingElapsedMs != null) {
                Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    task.totalElapsedMs?.let {
                        JobTimingCard(stringResource(R.string.server_total), it, task.totalElapsedApproximate, Modifier.weight(1f).fillMaxHeight())
                    }
                    task.processingElapsedMs?.let {
                        JobTimingCard(stringResource(R.string.job_processing_time_label), it, task.processingElapsedApproximate, Modifier.weight(1f).fillMaxHeight())
                    }
                }
            }
            val reference = task.jobId ?: task.operationId
            if (reference != null) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(if (task.jobId != null) stringResource(R.string.audio_task_job_id)
                    else stringResource(R.string.audio_task_reference), style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(reference, style = MaterialTheme.typography.bodySmall)
                }
                IconButton(onClick = {
                    (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                        .setPrimaryClip(ClipData.newPlainText("Audio task", reference))
                }) { Icon(Icons.Outlined.ContentCopy, stringResource(android.R.string.copy)) }
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(onClick = { renaming = true }, enabled = !busy, modifier = Modifier.weight(1f)) {
                    Text(stringResource(R.string.audio_task_rename))
                }
                if (task.canDelete) OutlinedButton(onClick = { deleting = true }, enabled = !busy,
                    modifier = Modifier.weight(1f), colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)) {
                    Text(stringResource(R.string.audio_task_delete))
                }
            }
            if (!ready) CreativeCard {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (task.active && task.progressFraction == null) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    }
                    Text(stringResource(audioTaskStageLabel(task.stage)),
                        modifier = Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                }
                if (task.stage == AudioTaskStage.QUEUED) Text(stringResource(R.string.processing_fair_wait), style = MaterialTheme.typography.bodySmall)
                if (task.active && task.progressFraction != null) {
                    Text(stringResource(R.string.progress_percent, (task.progressFraction * 100).toInt()),
                        style = MaterialTheme.typography.labelMedium)
                    LinearProgressIndicator(progress = { task.progressFraction }, modifier = Modifier.fillMaxWidth())
                }
                AudioStepTimeline(task)
            }
        }
        val job = state.detail
        if (state.failure != null) CreativeFeedback(stringResource(processingFailureLabel(state.failure)), error = true)
        if (message != null) CreativeFeedback(stringResource(message))
        // Polling refreshes existing content silently; only an empty initial load
        // needs a separate indicator. This keeps the timeline and actions steady.
        if (state.loading && task == null && job == null) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (job != null) {
            if (job.workerAvailable == false && job.status !in setOf("ready", "failed", "cancelled")) Text(stringResource(R.string.processing_worker_offline))
            if (job.status == "cancel_requested") Text(stringResource(R.string.processing_cancel_pending))
            if (busy && artifactProgress != null) {
                LinearProgressIndicator(progress = { artifactProgress }, modifier = Modifier.fillMaxWidth())
            }
            if (job.status in setOf("awaiting_upload", "queued", "validating", "processing", "uploading_result", "interrupted"))
                OutlinedButton(onClick = onCancel, enabled = !busy) { Text(stringResource(R.string.auth_cancel)) }
            if (job.status == "failed") CreativePrimaryButton(onClick = onRetry, busy = busy) { Text(stringResource(R.string.retry)) }
            if (job.status == "ready" && (job.canDownloadOutput || availableOffline)) {
                CompletedResultScreen(availableOffline, busy, onPlay, onDownload, onSave, onShare)
            }
            if (job.status == "ready" && !job.canDownloadOutput && !availableOffline) CreativeFeedback(stringResource(R.string.creative_jobs_wait_output))
        } else if (task == null && state.failure == null && !state.loading) {
            CreativeFeedback(stringResource(R.string.creative_jobs_details_unavailable))
        }
        else if (task != null) {
            if (task.canCancel && task.stage != AudioTaskStage.CANCELLING) OutlinedButton(onCancel, enabled = !busy) { Text(stringResource(R.string.auth_cancel)) }
            if (task.canRetry) CreativePrimaryButton(onRetry, busy = busy) { Text(stringResource(R.string.retry)) }
            if (ready && (task.canPlay || availableOffline)) CompletedResultScreen(availableOffline, busy, onPlay, onDownload, onSave, onShare)
        }
        TextButton(onClick = onRefresh, enabled = !state.loading) { Text(stringResource(R.string.processing_refresh)) }
    }
    if (renaming) RenameAudioSheet(task?.displayName.orEmpty(), busy, { renaming = false }, {
        if (it == task?.displayName) renaming = false
        else { renameFrom = task?.displayName; onRename(it) }
    }, message?.let { stringResource(it) })
    if (deleting) DeleteAudioSheet(task?.displayName.orEmpty(), busy, { deleting = false }, onDelete,
        message?.let { stringResource(it) })
}

@Composable
private fun JobTimingCard(label: String, elapsedMs: Long, approximate: Boolean, modifier: Modifier = Modifier) {
    CreativeCard(modifier = modifier, contentPadding = 14.dp, contentGap = 4.dp) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(formatElapsed(elapsedMs), style = MaterialTheme.typography.headlineSmall)
        if (approximate) Text(stringResource(R.string.audio_task_approximate),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
