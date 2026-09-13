package com.hatem.musicmute.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import com.hatem.musicmute.R
import com.hatem.musicmute.processing.AudioTaskPresentation
import com.hatem.musicmute.processing.JobHistoryState
import com.hatem.musicmute.ui.design.*
import androidx.compose.ui.Alignment

@Composable
fun ProcessingHistoryScreen(
    state: JobHistoryState,
    tasks: List<AudioTaskPresentation>,
    preparing: Boolean,
    message: Int?,
    onImport: () -> Unit,
    onRefresh: () -> Unit,
    onMore: () -> Unit,
    onOpen: (AudioTaskPresentation) -> Unit,
    onCancel: (AudioTaskPresentation) -> Unit,
    onRetry: (AudioTaskPresentation) -> Unit,
    onDelete: (AudioTaskPresentation) -> Unit,
    onNotifications: () -> Unit,
) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
    LazyColumn(
        Modifier.widthIn(max = CreativeTokens.ContentWidth).fillMaxSize().testTag("processing-history"),
        contentPadding = PaddingValues(CreativeTokens.PagePadding),
        verticalArrangement = Arrangement.spacedBy(CreativeTokens.ContentGap),
    ) {
        item {
            Text(stringResource(R.string.audio_task_processed_library), style = MaterialTheme.typography.headlineLarge)
            Text(stringResource(R.string.audio_task_intake_description))
            Text(stringResource(R.string.processing_limits), style = MaterialTheme.typography.bodySmall)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(CreativeTokens.CompactGap)) {
                Button(onClick = onImport, enabled = !preparing, modifier = Modifier.testTag("processing-import")) {
                    Text(stringResource(R.string.processing_import))
                }
                TextButton(onClick = onRefresh, enabled = !state.loading) {
                    Text(stringResource(R.string.processing_refresh))
                }
            }
            TextButton(onClick = onNotifications) { Text(stringResource(R.string.processing_notifications)) }
            Text(stringResource(R.string.processing_notifications_optional), style = MaterialTheme.typography.bodySmall)
        }
        if (preparing) item {
            Text(stringResource(R.string.processing_preparing))
            LinearProgressIndicator(Modifier.fillMaxWidth())
        }
        if (message != null) item { Text(stringResource(message), color = MaterialTheme.colorScheme.error) }
        if (state.failure != null) item {
            Text(stringResource(processingFailureLabel(state.failure)), color = MaterialTheme.colorScheme.error)
        }
        if (state.loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
        if (!state.loading && !preparing && state.failure == null && tasks.isEmpty()) item { Text(stringResource(R.string.processing_empty)) }
        items(tasks, key = { it.operationId ?: it.jobId.orEmpty() }) { task ->
            AudioTaskCard(task, { onOpen(task) }, { onCancel(task) }, { onRetry(task) }, { onDelete(task) })
        }
        if (state.nextCursor != null) item {
            TextButton(onClick = onMore, enabled = !state.loadingMore && !state.loading) {
                Text(stringResource(R.string.processing_more))
            }
        }
    }
    }
}
