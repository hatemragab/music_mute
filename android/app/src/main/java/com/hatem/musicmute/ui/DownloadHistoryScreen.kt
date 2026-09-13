package com.hatem.musicmute.ui

import android.text.format.DateFormat
import android.text.format.Formatter
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.download.DownloadError
import com.hatem.musicmute.download.DownloadRecord
import com.hatem.musicmute.download.DownloadStatus
import com.hatem.musicmute.playback.PlaybackState
import com.hatem.musicmute.state.DownloadsUiState
import java.util.Date
import java.util.Locale
import com.hatem.musicmute.ui.design.CreativeHeader
import com.hatem.musicmute.ui.design.CreativeCard

@Composable
fun DownloadHistoryScreen(
    state: DownloadsUiState,
    playback: PlaybackState,
    onStart: () -> Unit = {},
    onPlay: (DownloadRecord) -> Unit = {},
    onSeek: (Long) -> Unit = {},
    onCancel: (String) -> Unit = {},
    onRetry: (String) -> Unit = {},
    onReload: () -> Unit = {},
    onSave: (DownloadRecord) -> Unit = {},
    canSave: Boolean = true,
    onRemoveMusic: ((DownloadRecord) -> Unit)? = null,
) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        LazyColumn(
            modifier = Modifier.widthIn(max = 680.dp).fillMaxWidth(),
            contentPadding = PaddingValues(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    CreativeHeader(stringResource(R.string.creative_jobs_downloads))
                    Text(
                        stringResource(R.string.history_description),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        stringResource(R.string.original_quality_notice),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (state.loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
            if (state.saveResult != null)
                item {
                    Text(
                        stringResource(
                            if (state.saveResult) R.string.audio_export_success
                            else R.string.audio_export_error
                        ),
                        color =
                            if (state.saveResult) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.error,
                    )
                }
            if (state.historyError)
                item {
                    Text(
                        stringResource(R.string.history_read_error),
                        color = MaterialTheme.colorScheme.error,
                    )
                    TextButton(onClick = onReload) { Text(stringResource(R.string.retry)) }
                }
            if (state.actionError)
                item {
                    Text(
                        stringResource(R.string.download_action_error),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            if (playback.failed)
                item {
                    Text(
                        stringResource(R.string.playback_error),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            if (!state.loading && !state.historyError && state.records.isEmpty())
                item {
                    Card {
                        Column(
                            Modifier.padding(24.dp),
                            verticalArrangement = Arrangement.spacedBy(16.dp),
                        ) {
                            Icon(
                                Icons.Outlined.Headphones,
                                null,
                                Modifier.size(48.dp),
                                tint = MaterialTheme.colorScheme.primary,
                            )
                            Text(
                                stringResource(R.string.history_empty_title),
                                style = MaterialTheme.typography.headlineMedium,
                            )
                            Text(stringResource(R.string.history_empty_body))
                            Button(onClick = onStart) {
                                Text(stringResource(R.string.download_audio))
                            }
                        }
                    }
                }
            items(state.records, key = { it.id }) { record ->
                DownloadRow(
                    record,
                    playback,
                    onPlay,
                    onSeek,
                    onCancel,
                    onRetry,
                    onSave,
                    canSave,
                    state.savingId == record.id,
                    onRemoveMusic,
                )
            }
        }
    }
}

@Composable
private fun DownloadRow(
    record: DownloadRecord,
    playback: PlaybackState,
    onPlay: (DownloadRecord) -> Unit,
    onSeek: (Long) -> Unit,
    onCancel: (String) -> Unit,
    onRetry: (String) -> Unit,
    onSave: (DownloadRecord) -> Unit,
    canSave: Boolean,
    saving: Boolean,
    onRemoveMusic: ((DownloadRecord) -> Unit)?,
) {
    val context = LocalContext.current
    val active = playback.trackId == record.id
    val playing = active && playback.playing
    val title = record.title.ifBlank { stringResource(R.string.download_title) }
    Card(
        colors =
            CardDefaults.cardColors(
                containerColor =
                    if (active) MaterialTheme.colorScheme.primaryContainer
                    else MaterialTheme.colorScheme.surfaceContainerLow
            )
    ) {
        Column(
            Modifier.fillMaxWidth().padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Icon(Icons.Outlined.AudioFile, null, tint = MaterialTheme.colorScheme.primary)
                Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
            }
            Text(
                DateFormat.getDateFormat(context).format(Date(record.createdAt)),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            when (record.status) {
                DownloadStatus.COMPLETE -> {
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Text(
                            "${record.extension.uppercase(Locale.ROOT)} · ${record.codec.uppercase(Locale.ROOT)}",
                            style = MaterialTheme.typography.labelMedium,
                        )
                        Text(
                            Formatter.formatShortFileSize(context, record.sizeBytes),
                            style = MaterialTheme.typography.labelMedium,
                        )
                        if (record.bitrateKbps > 0)
                            Text(
                                stringResource(R.string.audio_bitrate, record.bitrateKbps),
                                style = MaterialTheme.typography.labelMedium,
                            )
                    }
                    Text(
                        stringResource(R.string.download_saved_original),
                        style = MaterialTheme.typography.bodySmall,
                    )
                    if (active && playback.buffering)
                        LinearProgressIndicator(Modifier.fillMaxWidth())
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        FilledTonalButton(
                            onClick = { onPlay(record) },
                            modifier = Modifier.heightIn(min = 48.dp),
                        ) {
                            Icon(
                                if (playing) Icons.Outlined.Pause else Icons.Outlined.PlayArrow,
                                null,
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                stringResource(
                                    if (playing) R.string.pause_audio else R.string.play_audio
                                )
                            )
                        }
                        OutlinedButton(
                            onClick = { onSave(record) },
                            enabled = canSave,
                            modifier = Modifier.heightIn(min = 48.dp),
                        ) {
                            Icon(Icons.Outlined.SaveAlt, null)
                            Spacer(Modifier.width(8.dp))
                            Text(
                                stringResource(
                                    if (saving) R.string.audio_export_saving
                                    else R.string.audio_export
                                )
                            )
                        }
                    }
                    if (onRemoveMusic != null) OutlinedButton(onClick = { onRemoveMusic(record) }) {
                        Text(stringResource(R.string.processing_remove))
                    }
                    if (saving) LinearProgressIndicator(Modifier.fillMaxWidth())
                    if (active) {
                        var seeking by remember(record.id) { mutableStateOf<Float?>(null) }
                        val duration = playback.durationMs.takeIf { it > 0 } ?: record.durationMs
                        val position = seeking?.toLong() ?: playback.positionMs
                        val seekDescription = stringResource(R.string.seek_audio)
                        if (duration > 0)
                            Slider(
                                value = position.toFloat().coerceIn(0f, duration.toFloat()),
                                onValueChange = { seeking = it },
                                onValueChangeFinished = {
                                    seeking?.let { onSeek(it.toLong()) }
                                    seeking = null
                                },
                                valueRange = 0f..duration.toFloat(),
                                modifier =
                                    Modifier.fillMaxWidth().semantics {
                                        contentDescription = seekDescription
                                    },
                            )
                        Text(
                            stringResource(
                                R.string.playback_position,
                                playbackTime(position),
                                playbackTime(duration),
                            ),
                            style = MaterialTheme.typography.labelMedium,
                        )
                    } else if (record.durationMs > 0)
                        Text(
                            playbackTime(record.durationMs),
                            style = MaterialTheme.typography.labelMedium,
                        )
                }
                DownloadStatus.QUEUED,
                DownloadStatus.DOWNLOADING -> {
                    Text(
                        stringResource(
                            if (record.status == DownloadStatus.QUEUED) R.string.download_queued
                            else R.string.downloading
                        )
                    )
                    if (record.totalBytes != null || record.progress > 0) {
                        LinearProgressIndicator(
                            progress = { record.progress / 100f },
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Text(stringResource(R.string.progress_percent, record.progress))
                    } else LinearProgressIndicator(Modifier.fillMaxWidth())
                    if (record.status == DownloadStatus.DOWNLOADING) {
                        val received =
                            Formatter.formatShortFileSize(context, record.downloadedBytes)
                        Text(
                            if (record.totalBytes != null)
                                stringResource(
                                    R.string.download_bytes,
                                    received,
                                    Formatter.formatShortFileSize(context, record.totalBytes),
                                )
                            else stringResource(R.string.download_received, received),
                            style = MaterialTheme.typography.labelMedium,
                        )
                    }
                    TextButton(onClick = { onCancel(record.id) }) {
                        Text(stringResource(R.string.cancel_download))
                    }
                }
                DownloadStatus.FAILED,
                DownloadStatus.CANCELLED -> {
                    Text(
                        stringResource(
                            if (record.status == DownloadStatus.CANCELLED)
                                R.string.download_cancelled
                            else record.error.message()
                        ),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    OutlinedButton(onClick = { onRetry(record.id) }) {
                        Text(stringResource(R.string.retry))
                    }
                }
            }
        }
    }
}

private fun DownloadError.message() =
    when (this) {
        DownloadError.UNAVAILABLE -> R.string.download_unavailable
        DownloadError.NETWORK -> R.string.download_network_error
        DownloadError.STORAGE -> R.string.download_storage_error
        DownloadError.INTERRUPTED -> R.string.download_interrupted
        DownloadError.INVALID_AUDIO -> R.string.download_invalid_audio
        else -> R.string.download_engine_error
    }

internal fun playbackTime(milliseconds: Long): String {
    val seconds = milliseconds.coerceAtLeast(0) / 1000
    return if (seconds >= 3600)
        String.format(
            Locale.getDefault(),
            "%d:%02d:%02d",
            seconds / 3600,
            (seconds / 60) % 60,
            seconds % 60,
        )
    else String.format(Locale.getDefault(), "%d:%02d", seconds / 60, seconds % 60)
}
