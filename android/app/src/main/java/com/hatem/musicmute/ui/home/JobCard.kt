package com.hatem.musicmute.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.hatem.musicmute.R
import com.hatem.musicmute.processing.AudioTaskPresentation
import com.hatem.musicmute.processing.AudioTaskStage
import com.hatem.musicmute.processing.Job
import com.hatem.musicmute.processing.RealtimeState
import com.hatem.musicmute.processing.SourceKind
import com.hatem.musicmute.ui.ProcessingQueueStatus
import com.hatem.musicmute.ui.audioTaskFailureLabel
import com.hatem.musicmute.ui.audioTaskStageLabel
import com.hatem.musicmute.ui.design.CreativeCard
import com.hatem.musicmute.ui.design.CreativeTokens
import com.hatem.musicmute.ui.formatElapsed
import java.text.DateFormat
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** Every state shares the same slots; errors never add another card row. */
@Composable
fun JobCard(
    task: AudioTaskPresentation,
    busy: Boolean,
    onOpen: () -> Unit,
    onCancel: () -> Unit,
    onDelete: () -> Unit = {},
    onRetry: () -> Unit = {},
    retryBusy: Boolean = false,
    job: Job? = null,
    connection: RealtimeState = RealtimeState.PAUSED,
    allTaskActions: Boolean = false,
) {
    val canOpen = !task.importOnly && (task.jobId != null || task.operationId != null)
    val failed = task.stage == AudioTaskStage.FAILED
    val supportingText = cardSupportingText(task)
    var showDetails by remember(task.operationId, task.jobId, task.importRequestId) { mutableStateOf(false) }
    val title = task.displayName.ifBlank { stringResource(R.string.url_import_title) }
    val date = jobCardCreatedAtLabel(task.createdAtMillis)
    // Theme line heights include Android font scaling: identical slots across states without
    // fixing a pixel height that could clip Arabic or accessibility-sized text.
    val density = LocalDensity.current
    val titleHeight = with(density) { MaterialTheme.typography.titleMedium.lineHeight.toDp() * 2 }
    val secondaryLineHeight = with(density) { MaterialTheme.typography.bodySmall.lineHeight.toDp() }
    val metadataHeight = maxOf(20.dp, secondaryLineHeight)
    val footerHeight = maxOf(
        CreativeTokens.TouchTarget,
        secondaryLineHeight * 2 + 16.dp,
        with(density) { MaterialTheme.typography.labelLarge.lineHeight.toDp() * 2 } + 12.dp,
    )
    val accent = jobCardStatusColor(task.stage)
    CreativeCard(
        contentPadding = 0.dp,
        contentGap = 0.dp,
        shape = RoundedCornerShape(20.dp),
        onClick = { if (canOpen) onOpen() else showDetails = true },
    ) {
        Column(Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, top = 12.dp, bottom = 4.dp)) {
            Row(
                Modifier.fillMaxWidth().height(metadataHeight),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                val fromLink = task.importOnly || task.sourceKind == SourceKind.URL
                JobSourceBadge(fromLink)
                Spacer(Modifier.weight(1f))
                date?.let { JobCreatedAtLabel(it) }
            }
            Spacer(Modifier.height(2.dp))
            Text(
                title,
                modifier = Modifier.fillMaxWidth().height(titleHeight),
                style = MaterialTheme.typography.titleMedium,
                minLines = 2,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(6.dp))
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(12.dp),
                color = MaterialTheme.colorScheme.surfaceContainerLowest,
                border = androidx.compose.foundation.BorderStroke(1.dp, accent.copy(alpha = 0.16f)),
            ) {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 6.dp)) {
                    JobCardStatus(task, Modifier.fillMaxWidth().height(secondaryLineHeight * 2))
                    Box(
                        Modifier.fillMaxWidth().height(secondaryLineHeight * 2),
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        if (supportingText != null) {
                            Text(
                                supportingText,
                                style = MaterialTheme.typography.bodySmall,
                                color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        } else {
                            JobStageProgress(task)
                        }
                    }
                }
            }
        }
        Row(
            Modifier.fillMaxWidth().height(footerHeight)
                .background(accent.copy(alpha = 0.055f)).padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            val actions = jobCardActions(task, allTaskActions)
            if (job?.status == "queued" && task.stage == AudioTaskStage.QUEUED) {
                ProcessingQueueStatus(job, connection, Modifier.weight(1f), compact = true)
            } else if (actions.size < 2) {
                Text(
                    stringResource(R.string.job_card_footer_voice),
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (!canOpen && supportingText != null) {
                IconButton(onClick = { showDetails = true }) {
                    Icon(Icons.Outlined.Info, stringResource(R.string.listener_details), Modifier.size(18.dp))
                }
            }
            actions.forEach { action ->
                TextButton(
                    onClick = when (action) {
                        JobCardAction.CANCEL -> onCancel
                        JobCardAction.RETRY -> onRetry
                        JobCardAction.DELETE -> onDelete
                    },
                    enabled = !busy && !retryBusy,
                    modifier = Modifier.heightIn(min = CreativeTokens.TouchTarget).then(
                        if (actions.size > 1) Modifier.weight(1f) else Modifier,
                    ),
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp),
                ) {
                    if (action == JobCardAction.RETRY && retryBusy) {
                        CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(
                        stringResource(when (action) {
                            JobCardAction.CANCEL -> R.string.auth_cancel
                            JobCardAction.RETRY -> R.string.retry
                            JobCardAction.DELETE -> R.string.audio_task_delete
                        }),
                        maxLines = 2,
                        fontWeight = FontWeight.SemiBold,
                        overflow = TextOverflow.Ellipsis,
                        textAlign = TextAlign.Center,
                    )
                }
            }
        }
    }
    if (showDetails) {
        AlertDialog(
            onDismissRequest = { showDetails = false },
            title = { Text(stringResource(R.string.processing_details)) },
            text = {
                Column(
                    Modifier.verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(title, style = MaterialTheme.typography.titleMedium)
                    date?.let { Text(it) }
                    Text(stringResource(audioTaskStageLabel(task.stage)))
                    supportingText?.let { Text(it) }
                }
            },
            confirmButton = {
                TextButton(onClick = { showDetails = false }) {
                    Text(stringResource(R.string.creative_library_close))
                }
            },
        )
    }
}

internal enum class JobCardAction { CANCEL, RETRY, DELETE }

internal fun jobCardActions(task: AudioTaskPresentation, allTaskActions: Boolean = false): List<JobCardAction> = buildList {
    if (task.canCancel && task.stage != AudioTaskStage.CANCELLING) add(JobCardAction.CANCEL)
    if (task.importOnly || allTaskActions) {
        if (task.canRetry) add(JobCardAction.RETRY)
        if (task.canDelete) add(JobCardAction.DELETE)
    }
}

/** A queue/stale state must never look partially processed. */
internal fun jobCardProgress(task: AudioTaskPresentation): Float? = task.progressFraction
    ?.takeIf {
        it.isFinite() && task.active && task.workerAvailable != false && task.stage in setOf(
            AudioTaskStage.UPLOADING_INPUT, AudioTaskStage.PROCESSING, AudioTaskStage.UPLOADING_RESULT,
        )
    }?.coerceIn(0f, 1f)

@Composable
private fun cardSupportingText(task: AudioTaskPresentation): String? {
    audioTaskFailureLabel(task)?.let { return stringResource(it) }
    if (task.active && task.workerAvailable == false) return stringResource(R.string.listener_stage_paused)
    return task.audioDurationMs?.takeIf { !task.active }?.let {
        stringResource(R.string.audio_task_duration, formatElapsed(it))
    }
}

@Composable
private fun JobSourceBadge(fromLink: Boolean) {
    val style = jobMetadataStyle()
    Surface(
        shape = RoundedCornerShape(50),
        color = MaterialTheme.colorScheme.primary.copy(alpha = 0.09f),
        contentColor = MaterialTheme.colorScheme.primary,
    ) {
        Row(
            Modifier.height(20.dp).padding(horizontal = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            Icon(
                if (fromLink) Icons.Outlined.Link else Icons.Outlined.GraphicEq,
                contentDescription = null,
                modifier = Modifier.size(13.dp),
            )
            Text(
                stringResource(if (fromLink) R.string.job_card_source_link else R.string.job_card_source_audio),
                style = style,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun JobCreatedAtLabel(value: String) {
    val style = jobMetadataStyle()
    Row(
        modifier = Modifier.widthIn(max = 190.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(
            Icons.Outlined.Schedule,
            contentDescription = null,
            modifier = Modifier.size(13.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            value,
            style = style,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun jobMetadataStyle() = MaterialTheme.typography.bodySmall.copy(
    fontFamily = if (LocalLayoutDirection.current == LayoutDirection.Ltr) FontFamily.SansSerif
        else MaterialTheme.typography.bodySmall.fontFamily,
    fontWeight = FontWeight.Medium,
    letterSpacing = 0.sp,
)

internal fun jobCardCreatedAtLabel(
    createdAtMillis: Long,
    nowMillis: Long = System.currentTimeMillis(),
    locale: Locale = Locale.getDefault(),
    timeZone: TimeZone = TimeZone.getDefault(),
): String? {
    if (createdAtMillis <= 0) return null
    val created = Calendar.getInstance(timeZone, locale).apply { timeInMillis = createdAtMillis }
    val now = Calendar.getInstance(timeZone, locale).apply { timeInMillis = nowMillis }
    val sameYear = created.get(Calendar.YEAR) == now.get(Calendar.YEAR)
    val arabic = locale.language == "ar"
    val pattern = when {
        arabic && sameYear -> "d MMM"
        arabic -> "d MMM yyyy"
        sameYear -> "MMM d"
        else -> "MMM d, yyyy"
    }
    val date = SimpleDateFormat(pattern, locale).apply { this.timeZone = timeZone }
        .format(Date(createdAtMillis))
    val time = DateFormat.getTimeInstance(DateFormat.SHORT, locale).apply { this.timeZone = timeZone }
        .format(Date(createdAtMillis))
    return "$date · $time"
}
