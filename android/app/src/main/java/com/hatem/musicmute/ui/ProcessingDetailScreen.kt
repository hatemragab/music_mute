package com.hatem.musicmute.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.processing.JobHistoryState
import com.hatem.musicmute.processing.AudioTaskPresentation

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
) {
    val context = LocalContext.current
    var renaming by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    var name by remember(task?.displayName) { mutableStateOf(task?.displayName.orEmpty()) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp).testTag("processing-detail"),
        verticalArrangement = Arrangement.spacedBy(16.dp)) {
        TextButton(onClick = onBack) { Text(stringResource(R.string.back)) }
        Text(task?.displayName ?: stringResource(R.string.processing_details), style = MaterialTheme.typography.headlineMedium)
        if (task != null) {
            AudioStepTimeline(task)
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
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = { renaming = true }, enabled = !busy) {
                    Text(stringResource(R.string.audio_task_rename))
                }
                if (task.canDelete) TextButton(onClick = { deleting = true }, enabled = !busy) {
                    Text(stringResource(R.string.audio_task_delete))
                }
            }
        }
        val job = state.detail
        if (state.failure != null) Text(stringResource(processingFailureLabel(state.failure)), color = MaterialTheme.colorScheme.error)
        if (message != null) Text(stringResource(message))
        if (job != null) {
            Text(stringResource(processingStatusLabel(job.status)), style = MaterialTheme.typography.titleLarge)
            if (job.workerAvailable == false && job.status !in setOf("ready", "failed", "cancelled")) Text(stringResource(R.string.processing_worker_offline))
            if (job.status == "cancel_requested") Text(stringResource(R.string.processing_cancel_pending))
            if (busy) {
                if (artifactProgress != null) LinearProgressIndicator(progress = { artifactProgress }, modifier = Modifier.fillMaxWidth())
                else LinearProgressIndicator(Modifier.fillMaxWidth())
            }
            if (job.status in setOf("awaiting_upload", "queued", "validating", "processing", "uploading_result", "interrupted"))
                OutlinedButton(onClick = onCancel, enabled = !busy) { Text(stringResource(R.string.auth_cancel)) }
            if (job.status == "failed") Button(onClick = onRetry, enabled = !busy) { Text(stringResource(R.string.retry)) }
            if (job.status == "ready" && job.canDownloadOutput) {
                Text(stringResource(R.string.processing_output_notice))
                Button(onClick = onPlay, enabled = !busy, modifier = Modifier.testTag("processing-play")) {
                    Text(stringResource(if (playing) R.string.pause_audio else R.string.play_audio))
                }
                if (durationMs > 0) {
                    Slider(value = positionMs.toFloat().coerceIn(0f, durationMs.toFloat()),
                        onValueChange = { onSeek(it.toLong()) }, valueRange = 0f..durationMs.toFloat())
                    Text(stringResource(R.string.playback_position, playbackTime(positionMs), playbackTime(durationMs)))
                }
                OutlinedButton(onClick = onDownload, enabled = !busy) { Text(stringResource(R.string.processing_download)) }
                OutlinedButton(onClick = onSave, enabled = !busy) { Text(stringResource(R.string.audio_export)) }
                OutlinedButton(onClick = onShare, enabled = !busy) { Text(stringResource(R.string.audio_task_share)) }
            }
        } else if (task == null && state.failure == null) LinearProgressIndicator(Modifier.fillMaxWidth())
        TextButton(onClick = onRefresh, enabled = !state.loading) { Text(stringResource(R.string.processing_refresh)) }
    }
    if (renaming) AlertDialog(onDismissRequest = { renaming = false },
        title = { Text(stringResource(R.string.audio_task_rename)) },
        text = { OutlinedTextField(name, { name = it }, label = { Text(stringResource(R.string.audio_task_name_label)) }) },
        confirmButton = { TextButton(onClick = { onRename(name); renaming = false }) { Text(stringResource(android.R.string.ok)) } },
        dismissButton = { TextButton(onClick = { renaming = false }) { Text(stringResource(R.string.auth_cancel)) } })
    if (deleting) AlertDialog(onDismissRequest = { deleting = false },
        title = { Text(stringResource(R.string.audio_task_delete_title)) },
        text = { Text(stringResource(R.string.audio_task_delete_body)) },
        confirmButton = { TextButton(onClick = { onDelete(); deleting = false }) { Text(stringResource(R.string.audio_task_delete)) } },
        dismissButton = { TextButton(onClick = { deleting = false }) { Text(stringResource(R.string.auth_cancel)) } })
}
