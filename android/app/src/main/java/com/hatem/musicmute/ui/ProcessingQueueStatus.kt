package com.hatem.musicmute.ui

import androidx.compose.runtime.Composable
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.ui.res.stringResource
import com.hatem.musicmute.R
import com.hatem.musicmute.processing.Job
import com.hatem.musicmute.processing.RealtimeState

@Composable
fun ProcessingQueueStatus(job: Job?, connection: RealtimeState) {
    if (job?.status != "queued") return
    val queue = job.queue
    val text = if (connection != RealtimeState.LIVE) stringResource(R.string.realtime_reconnecting)
    else if (queue?.state == "waiting" && queue.position != null) stringResource(R.string.realtime_queue_position, queue.position)
    else stringResource(when (queue?.reason) {
        "account_capacity" -> R.string.realtime_account_wait
        "retry_backoff" -> R.string.realtime_retry_wait
        "processing_paused" -> R.string.realtime_processing_paused
        "worker_unavailable" -> R.string.realtime_worker_wait
        else -> R.string.realtime_queue_unavailable
    })
    Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
}

@Composable
fun ProcessingConnectionStatus(connection: RealtimeState) {
    Text(
        stringResource(if (connection == RealtimeState.LIVE) R.string.realtime_live else R.string.realtime_reconnecting),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}
