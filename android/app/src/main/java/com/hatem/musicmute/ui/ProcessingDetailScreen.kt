package com.hatem.musicmute.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
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
    CreativePage(Modifier.testTag("processing-detail")) {
        TextButton(onClick = onBack) { Text(stringResource(R.string.back)) }
        CreativeHeader(stringResource(if (task?.stage == com.hatem.musicmute.processing.AudioTaskStage.READY) R.string.creative_jobs_result else R.string.processing_details))
        if (task != null) {
            CreativeCard {
            Text(task.displayName, style = MaterialTheme.typography.titleLarge)
            task.audioDurationMs?.let {
                Text(stringResource(R.string.audio_task_duration, formatElapsed(it)))
            }
            audioTaskFailureLabel(task)?.let {
                Text(stringResource(it), color = MaterialTheme.colorScheme.error)
            }
            val reference = task.jobId ?: task.operationId
            if (reference != null) {
                Text(if (task.jobId != null) stringResource(R.string.audio_task_job_id)
                    else stringResource(R.string.audio_task_reference), style = MaterialTheme.typography.labelMedium)
                Text(reference, style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = {
                    (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                        .setPrimaryClip(ClipData.newPlainText("Audio task", reference))
                }) { Text(stringResource(android.R.string.copy)) }
            }
            task.totalElapsedMs?.let {
                Text(stringResource(R.string.audio_task_total_time, formatElapsed(it)) +
                    if (task.totalElapsedApproximate) " · ${stringResource(R.string.audio_task_approximate)}" else "")
            }
            task.processingElapsedMs?.let {
                Text(stringResource(R.string.audio_task_processing_time, formatElapsed(it)) +
                    if (task.processingElapsedApproximate) " · ${stringResource(R.string.audio_task_approximate)}" else "")
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(CreativeTokens.CompactGap)) {
                TextButton(onClick = { renaming = true }, enabled = !busy) {
                    Text(stringResource(R.string.audio_task_rename))
                }
                if (task.canDelete) TextButton(onClick = { deleting = true }, enabled = !busy) {
                    Text(stringResource(R.string.audio_task_delete))
                }
            }
            }
            if (!ready) CreativeCard {
                Text(stringResource(audioTaskStageLabel(task.stage)), style = MaterialTheme.typography.titleLarge)
                if (task.active) {
                    val progress = task.progressFraction
                    if (progress != null) LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth())
                    else LinearProgressIndicator(Modifier.fillMaxWidth())
                }
                AudioStepTimeline(task)
            }
        }
        val job = state.detail
        if (state.failure != null) CreativeFeedback(stringResource(processingFailureLabel(state.failure)), error = true)
        if (message != null) CreativeFeedback(stringResource(message))
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (job != null) {
            if (job.workerAvailable == false && job.status !in setOf("ready", "failed", "cancelled")) Text(stringResource(R.string.processing_worker_offline))
            if (job.status == "cancel_requested") Text(stringResource(R.string.processing_cancel_pending))
            if (busy) {
                if (artifactProgress != null) LinearProgressIndicator(progress = { artifactProgress }, modifier = Modifier.fillMaxWidth())
                else LinearProgressIndicator(Modifier.fillMaxWidth())
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
        if (ready && task != null) CreativeCard { AudioStepTimeline(task) }
        TextButton(onClick = onRefresh, enabled = !state.loading) { Text(stringResource(R.string.processing_refresh)) }
    }
    if (renaming) RenameAudioSheet(task?.displayName.orEmpty(), busy, { renaming = false }, {
        if (it == task?.displayName) renaming = false
        else { renameFrom = task?.displayName; onRename(it) }
    }, message?.let { stringResource(it) })
    if (deleting) DeleteAudioSheet(task?.displayName.orEmpty(), busy, { deleting = false }, onDelete,
        message?.let { stringResource(it) })
}
