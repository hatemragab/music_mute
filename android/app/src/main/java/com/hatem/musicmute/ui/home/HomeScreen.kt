package com.hatem.musicmute.ui.home

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.processing.AudioTaskPresentation
import com.hatem.musicmute.processing.JobHistoryState
import com.hatem.musicmute.ui.design.*
import com.hatem.musicmute.ui.processingFailureLabel

@Composable
fun HomeScreen(
    tasks: List<AudioTaskPresentation>,
    history: JobHistoryState,
    busy: Boolean,
    onImport: () -> Unit,
    onYoutube: () -> Unit,
    onRefresh: () -> Unit,
    onLoadMore: () -> Unit,
    onOpen: (AudioTaskPresentation) -> Unit,
    onCancel: (AudioTaskPresentation) -> Unit,
    onRetry: (AudioTaskPresentation) -> Unit,
    message: String? = null,
    onNotifications: () -> Unit = {},
    miniPlayer: @Composable () -> Unit = {},
    onPhotos: () -> Unit = {},
    usage: com.hatem.musicmute.processing.ProcessingUsage? = null,
) {
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
        LazyColumn(
            Modifier.weight(1f).widthIn(max = CreativeTokens.ContentWidth).fillMaxWidth(),
            contentPadding = PaddingValues(CreativeTokens.PagePadding),
            verticalArrangement = Arrangement.spacedBy(CreativeTokens.ContentGap),
        ) {
            item {
                CreativeHeader(stringResource(R.string.app_name))
                Text(stringResource(R.string.creative_jobs_home_title), style = MaterialTheme.typography.headlineLarge)
            }
            item {
                CreativeCard(Modifier.clickable(enabled = !busy, onClick = onImport)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        FilledIconButton(onClick = onImport, enabled = !busy) { Icon(Icons.Outlined.Add, stringResource(R.string.processing_import)) }
                        Column(Modifier.weight(1f)) {
                            Text(stringResource(R.string.processing_import), style = MaterialTheme.typography.titleMedium)
                            Text(stringResource(R.string.creative_jobs_audio_only), color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null)
                    }
                }
            }
            item {
                OutlinedButton(onClick = onPhotos, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.media_import_photos))
                }
            }
            usage?.let { current -> item {
                CreativeCard {
                    Text(stringResource(R.string.processing_usage_remaining, kotlin.math.floor(current.remainingAudioSeconds / 60).toInt()))
                    Text(stringResource(R.string.processing_usage_details, kotlin.math.ceil(current.usedAudioSeconds / 60).toInt(), kotlin.math.ceil(current.reservedAudioSeconds / 60).toInt()))
                    current.nextReplenishmentAt?.let { at ->
                        val local = runCatching { java.time.Instant.parse(at).atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofLocalizedDateTime(java.time.format.FormatStyle.SHORT)) }.getOrNull()
                        if (local != null) Text(stringResource(R.string.processing_usage_replenishment, local))
                    }
                    Text(stringResource(R.string.processing_usage_admission), style = MaterialTheme.typography.bodySmall)
                }
            } }
            item {
                OutlinedButton(onClick = onYoutube, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Outlined.Link, null)
                    Spacer(Modifier.width(12.dp))
                    Text(stringResource(R.string.youtube_secondary))
                }
            }
            item {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.creative_jobs_heading), Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    TextButton(onClick = onRefresh, enabled = !history.loading) { Text(stringResource(R.string.processing_refresh)) }
                }
                if (history.loading || busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (busy) CreativeFeedback(stringResource(R.string.processing_preparing))
                message?.let { CreativeFeedback(it) }
            }
            if (tasks.isEmpty() && !history.loading && history.failure == null && !busy) item {
                CreativeCard { CreativeFeedback(stringResource(R.string.creative_jobs_empty)) }
            }
            items(tasks, key = { it.operationId ?: requireNotNull(it.jobId) }) { task ->
                JobCard(task, busy, { onOpen(task) }, { onCancel(task) }, { onRetry(task) })
            }
            item {
                history.failure?.let {
                    CreativeFeedback(stringResource(processingFailureLabel(it)), error = true,
                        actionLabel = stringResource(R.string.retry),
                        onAction = if (history.nextCursor != null && tasks.isNotEmpty()) onLoadMore else onRefresh)
                }
                if (history.nextCursor != null) OutlinedButton(
                    onClick = onLoadMore, enabled = !history.loadingMore && !history.loading,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (history.loadingMore) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.creative_jobs_load_more))
                }
                TextButton(onNotifications) { Text(stringResource(R.string.processing_notifications)) }
                Text(stringResource(R.string.processing_notifications_optional),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        miniPlayer()
    }
}
