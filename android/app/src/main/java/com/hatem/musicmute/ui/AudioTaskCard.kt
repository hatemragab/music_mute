package com.hatem.musicmute.ui

import androidx.compose.runtime.Composable
import com.hatem.musicmute.processing.AudioTaskPresentation
import com.hatem.musicmute.processing.Job
import com.hatem.musicmute.processing.RealtimeState
import com.hatem.musicmute.ui.home.JobCard
import java.util.concurrent.TimeUnit

/** History and Home share the same compact, consistently sized job card. */
@Composable
fun AudioTaskCard(
    task: AudioTaskPresentation,
    onOpen: () -> Unit,
    onCancel: () -> Unit,
    onRetry: () -> Unit,
    onDelete: () -> Unit,
    job: Job? = null,
    connection: RealtimeState = RealtimeState.PAUSED,
) {
    JobCard(
        task = task,
        busy = false,
        onOpen = onOpen,
        onCancel = onCancel,
        onRetry = onRetry,
        onDelete = onDelete,
        job = job,
        connection = connection,
        allTaskActions = true,
    )
}

fun formatElapsed(milliseconds: Long): String {
    val seconds = TimeUnit.MILLISECONDS.toSeconds(milliseconds.coerceAtLeast(0))
    val minutes = seconds / 60
    return "%d:%02d".format(minutes, seconds % 60)
}
