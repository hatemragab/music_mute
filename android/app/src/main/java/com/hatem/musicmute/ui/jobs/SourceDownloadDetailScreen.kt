package com.hatem.musicmute.ui.jobs

import android.text.format.Formatter
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.background
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.processing.AudioTaskPresentation
import com.hatem.musicmute.processing.AudioTaskStage
import com.hatem.musicmute.processing.SourceKind
import com.hatem.musicmute.ui.*
import com.hatem.musicmute.ui.design.*
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription

@Composable
fun SourceDownloadDetailScreen(
    task: AudioTaskPresentation,
    busy: Boolean,
    onBack: () -> Unit,
    onCancel: () -> Unit,
    onRetry: () -> Unit,
    onRefresh: () -> Unit,
    onReview: () -> Unit,
    message: String? = null,
) {
    val context = LocalContext.current
    val downloadedSource = task.sourceKind == SourceKind.URL
    CreativePage {
        TextButton(onBack) { Text(stringResource(R.string.back)) }
        CreativeHeader(stringResource(if (downloadedSource) R.string.creative_jobs_source else R.string.audio_task_preparing))
        message?.let { CreativeFeedback(it) }
        CreativeCard {
            Text(task.displayName, style = MaterialTheme.typography.titleLarge)
            Text(stringResource(audioTaskStageLabel(task.stage)), color = MaterialTheme.colorScheme.primary)
            if (task.active) {
                val progress = task.progressFraction
                if (progress != null) LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth())
                else LinearProgressIndicator(Modifier.fillMaxWidth())
            }
            task.transferredBytes?.let { bytes ->
                Text(Formatter.formatShortFileSize(context, bytes) + (task.totalBytes?.let { " / ${Formatter.formatShortFileSize(context, it)}" } ?: ""))
            }
            // Source preparation has only three milestones, never cloud processing stages.
            val labels = if (downloadedSource) listOf(R.string.audio_task_downloading, R.string.audio_task_preparing, R.string.creative_jobs_review)
                else listOf(R.string.audio_task_preparing, R.string.creative_jobs_review)
            val currentStep = when (task.stage) {
                AudioTaskStage.DOWNLOADING_SOURCE -> R.string.audio_task_downloading
                AudioTaskStage.PREPARING_INPUT -> R.string.audio_task_preparing
                AudioTaskStage.REVIEW -> R.string.creative_jobs_review
                else -> null
            }
            val rank = if (task.stage == AudioTaskStage.RESERVING_JOB) labels.size else labels.indexOf(currentStep)
            labels.forEachIndexed { index, label ->
                val status = stringResource(if (index < rank) R.string.ui_step_complete
                    else if (index == rank) R.string.ui_step_current else R.string.ui_step_pending)
                Row(Modifier.semantics(mergeDescendants = true) { stateDescription = status },
                    horizontalArrangement = Arrangement.spacedBy(CreativeTokens.CompactGap), verticalAlignment = Alignment.CenterVertically) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(if (index < rank) Icons.Outlined.CheckCircle else Icons.Outlined.RadioButtonUnchecked,
                            null, tint = if (index <= rank) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline)
                        if (index < labels.lastIndex) Box(Modifier.width(1.dp).height(22.dp).background(MaterialTheme.colorScheme.outlineVariant))
                    }
                    Text(stringResource(label), style = MaterialTheme.typography.titleMedium)
                }
            }
            CreativeFeedback(stringResource(R.string.creative_jobs_source_notice))
            audioTaskFailureLabel(task)?.let { CreativeFeedback(stringResource(it), error = true) }
        }
        CreativeCard {
            task.sourceTitle?.let { Text(it) }
            task.audioDurationMs?.let { Text(stringResource(R.string.audio_task_duration, formatElapsed(it))) }
            task.totalElapsedMs?.let { Text(stringResource(R.string.audio_task_total_time, formatElapsed(it)) +
                if (task.totalElapsedApproximate) " · ${stringResource(R.string.audio_task_approximate)}" else "") }
            task.operationId?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        }
        if (task.stage == AudioTaskStage.REVIEW) CreativePrimaryButton(onReview, Modifier.fillMaxWidth(), busy = busy) { Text(stringResource(R.string.creative_jobs_review)) }
        if (task.canCancel && task.stage != AudioTaskStage.CANCELLING) OutlinedButton(onCancel, Modifier.fillMaxWidth(), enabled = !busy) { Text(stringResource(R.string.auth_cancel)) }
        if (task.canRetry) CreativePrimaryButton(onRetry, Modifier.fillMaxWidth(), busy = busy) { Text(stringResource(R.string.retry)) }
        OutlinedButton(onRefresh, Modifier.fillMaxWidth(), enabled = !busy) { Text(stringResource(R.string.processing_refresh)) }
    }
}
