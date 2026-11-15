package com.hatem.musicmute.ui.jobs

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.hatem.musicmute.R
import com.hatem.musicmute.processing.AudioTaskPresentation
import com.hatem.musicmute.ui.AudioStepTimeline
import com.hatem.musicmute.ui.design.*
import com.hatem.musicmute.ui.library.audioTime

/** Result actions, metadata and processing history share one scrollable page. */
@Composable
fun PlaybackResultDetails(
    task: AudioTaskPresentation,
    busy: Boolean,
    refreshing: Boolean,
    availableOffline: Boolean,
    canRetrieve: Boolean,
    artifactProgress: Float?,
    message: String?,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onPlay: () -> Unit,
    onDownload: () -> Unit,
    onSave: () -> Unit,
    onShare: () -> Unit,
    onRename: () -> Unit,
    onDelete: () -> Unit,
) {
    val context = LocalContext.current
    CreativePage(Modifier.testTag("processing-detail")) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, stringResource(R.string.back)) }
            Text(stringResource(R.string.result_details_title), Modifier.weight(1f),
                style = MaterialTheme.typography.titleLarge, fontSize = 20.sp)
            IconButton(onRefresh, enabled = !refreshing) {
                Icon(Icons.Outlined.Refresh, stringResource(R.string.processing_refresh))
            }
        }
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.Top) {
            Box(Modifier.width(3.dp).fillMaxHeight()
                .background(MaterialTheme.colorScheme.primary, RoundedCornerShape(2.dp)))
            Column(Modifier.weight(1f).padding(start = 16.dp, top = 4.dp, bottom = 4.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(task.displayName, style = MaterialTheme.typography.titleLarge, fontSize = 22.sp, lineHeight = 30.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.CheckCircle, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary)
                    Text(stringResource(R.string.result_ready), style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.primary)
                    task.audioDurationMs?.let {
                        Text("· ${audioTime(it)}", style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            IconButton(onRename, enabled = !busy) {
                Icon(Icons.Outlined.Edit, stringResource(R.string.audio_task_rename), Modifier.size(20.dp))
            }
        }
        CreativeWave(Modifier.fillMaxWidth().height(76.dp), active = false)
        message?.let { CreativeFeedback(it, error = true) }
        if (busy) {
            if (artifactProgress != null) {
                LinearProgressIndicator(progress = { artifactProgress }, modifier = Modifier.fillMaxWidth())
            } else LinearProgressIndicator(Modifier.fillMaxWidth())
        }
        if (canRetrieve) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                CreativePrimaryButton(onPlay, Modifier.fillMaxWidth().testTag("processing-play"), busy = busy) {
                    Icon(Icons.Outlined.PlayArrow, null)
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.creative_jobs_open_player), style = MaterialTheme.typography.titleMedium)
                }
                OutlinedCard(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(14.dp),
                    colors = CardDefaults.outlinedCardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
                ) {
                    ResultActionRow(Icons.Outlined.Download, stringResource(R.string.audio_export),
                        enabled = !busy, onClick = onSave)
                    HorizontalDivider(Modifier.padding(horizontal = 16.dp))
                    ResultActionRow(Icons.Outlined.Share, stringResource(R.string.audio_task_share),
                        enabled = !busy, onClick = onShare)
                    HorizontalDivider(Modifier.padding(horizontal = 16.dp))
                    if (availableOffline) {
                        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(16.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.CheckCircle, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
                            Text(stringResource(R.string.creative_jobs_offline), style = MaterialTheme.typography.labelLarge)
                        }
                    } else {
                        ResultActionRow(Icons.Outlined.OfflinePin, stringResource(R.string.result_keep_offline),
                            subtitle = stringResource(R.string.result_offline_hint), enabled = !busy, onClick = onDownload)
                    }
                }
            }
        } else CreativeFeedback(stringResource(R.string.creative_jobs_wait_output))
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.result_job_title), style = MaterialTheme.typography.titleMedium)
            ResultDetailRow(stringResource(R.string.result_status), stringResource(R.string.result_ready))
            task.audioDurationMs?.let { ResultDetailRow(stringResource(R.string.result_duration), audioTime(it)) }
            ResultDetailRow(stringResource(R.string.result_output), stringResource(R.string.result_format))
            task.totalElapsedMs?.let {
                Text(stringResource(R.string.audio_task_total_time, audioTime(it)) +
                    if (task.totalElapsedApproximate) " · ${stringResource(R.string.audio_task_approximate)}" else "",
                    style = MaterialTheme.typography.bodyMedium)
            }
            task.processingElapsedMs?.let {
                Text(stringResource(R.string.audio_task_processing_time, audioTime(it)) +
                    if (task.processingElapsedApproximate) " · ${stringResource(R.string.audio_task_approximate)}" else "",
                    style = MaterialTheme.typography.bodyMedium)
            }
            (task.jobId ?: task.operationId)?.let { reference ->
                Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(stringResource(if (task.jobId != null) R.string.audio_task_job_id else R.string.audio_task_reference),
                            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(reference, style = MaterialTheme.typography.bodySmall)
                    }
                    IconButton({
                        (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                            .setPrimaryClip(ClipData.newPlainText("Audio task", reference))
                    }) {
                        Icon(Icons.Outlined.ContentCopy, stringResource(android.R.string.copy), Modifier.size(20.dp))
                    }
                }
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.CheckCircle, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
                Text(stringResource(R.string.result_completed), style = MaterialTheme.typography.titleMedium)
            }
            AudioStepTimeline(task)
        }
        if (task.canDelete) {
            OutlinedCard(onClick = onDelete, enabled = !busy,
                modifier = Modifier.fillMaxWidth().testTag("processing-delete"),
                shape = RoundedCornerShape(14.dp),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.error.copy(alpha = 0.45f)),
                colors = CardDefaults.outlinedCardColors(
                    containerColor = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.35f),
                    contentColor = MaterialTheme.colorScheme.error)) {
                Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.DeleteOutline, null, Modifier.size(22.dp))
                    Text(stringResource(R.string.audio_task_delete), style = MaterialTheme.typography.titleSmall)
                }
            }
        }
    }
}

@Composable
private fun ResultActionRow(
    icon: ImageVector,
    title: String,
    subtitle: String? = null,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val color = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f)
    Row(
        Modifier.fillMaxWidth().clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, Modifier.size(20.dp), tint = if (enabled) MaterialTheme.colorScheme.primary else color)
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.labelLarge, color = color)
            subtitle?.let { Text(it, style = MaterialTheme.typography.bodySmall,
                color = if (enabled) MaterialTheme.colorScheme.onSurfaceVariant else color) }
        }
        Icon(Icons.Outlined.ChevronRight, null, Modifier.size(18.dp), tint = color)
    }
}

@Composable
private fun ResultDetailRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth().heightIn(min = 40.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.End)
    }
}
