package com.hatem.musicmute.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ListAlt
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.processing.Job
import com.hatem.musicmute.processing.RealtimeState

internal data class ProcessingQueuePresentation(val textRes: Int, val position: Int? = null)

internal fun processingQueuePresentation(job: Job?, connection: RealtimeState): ProcessingQueuePresentation? {
    if (job?.status != "queued") return null
    if (connection != RealtimeState.LIVE) return ProcessingQueuePresentation(R.string.realtime_reconnecting)
    val queue = job.queue
    val position = queue?.takeIf { it.state == "waiting" }?.position?.takeIf { it > 0 }
    if (position != null) return ProcessingQueuePresentation(R.string.realtime_queue_position, position)
    return ProcessingQueuePresentation(
        when (queue?.reason) {
            "account_capacity" -> R.string.realtime_account_wait
            "retry_backoff" -> R.string.realtime_retry_wait
            "processing_paused" -> R.string.realtime_processing_paused
            "worker_unavailable" -> R.string.realtime_worker_wait
            else -> R.string.realtime_queue_unavailable
        },
    )
}

@Composable
fun ProcessingQueueStatus(
    job: Job?,
    connection: RealtimeState,
    modifier: Modifier = Modifier,
    compact: Boolean = false,
) {
    val presentation = processingQueuePresentation(job, connection) ?: return
    val text = presentation.position?.let { stringResource(presentation.textRes, it) }
        ?: stringResource(presentation.textRes)
    if (compact) {
        Row(
            modifier = modifier,
            horizontalArrangement = Arrangement.spacedBy(7.dp, Alignment.Start),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (presentation.position != null) {
                Icon(
                    Icons.AutoMirrored.Outlined.ListAlt,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                    tint = MaterialTheme.colorScheme.primary,
                )
            }
            Text(
                text,
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.Medium,
                color = if (presentation.position != null) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Start,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    } else {
        Text(
            text,
            modifier = modifier,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.primary,
        )
    }
}

@Composable
fun ProcessingConnectionStatus(connection: RealtimeState) {
    Text(
        stringResource(if (connection == RealtimeState.LIVE) R.string.realtime_live else R.string.realtime_reconnecting),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}
