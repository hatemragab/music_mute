package com.hatem.musicmute.ui.player

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.hatem.musicmute.R
import com.hatem.musicmute.library.*
import com.hatem.musicmute.playback.*
import com.hatem.musicmute.ui.design.*
import com.hatem.musicmute.ui.library.audioTime

/** A full-screen destination; only the track list scrolls, with controls fixed below it. */
@Composable
fun PlaybackQueueSheet(
    state: PlaybackState, entries: List<LibraryEntry>, onDismiss: () -> Unit,
    onSelect: (LibraryKey) -> Unit, onRemove: (LibraryKey) -> Unit, onAutoNext: (Boolean) -> Unit,
    onShuffle: (Boolean) -> Unit, onRepeat: (RepeatMode) -> Unit,
    orderedTracks: List<QueueTrack> = state.queue,
    onToggle: () -> Unit = {},
) {
    val current = state.queue.getOrNull(state.currentIndex)
    val display = remember(orderedTracks, current?.key, state.repeatMode, state.autoNext) {
        queueDisplay(orderedTracks, current?.key, state.repeatMode, state.autoNext)
    }
    val byKey = remember(entries) { entries.associateBy { it.key } }
    val listState = rememberLazyListState()
    LaunchedEffect(current?.key) { listState.scrollToItem(0) }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(
        usePlatformDefaultWidth = false, decorFitsSystemWindows = false,
    )) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Column(
                Modifier.fillMaxSize().safeDrawingPadding(),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Row(
                    Modifier.widthIn(max = CreativeTokens.ContentWidth).fillMaxWidth().padding(horizontal = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onDismiss) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, stringResource(R.string.creative_library_close))
                    }
                    Text(stringResource(R.string.creative_library_up_next),
                        style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
                }
                LazyColumn(
                    Modifier.weight(1f).widthIn(max = CreativeTokens.ContentWidth).fillMaxWidth(),
                    state = listState,
                    contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
                ) {
                    if (state.failed) item {
                        CreativeFeedback(stringResource(R.string.creative_library_failed), error = true)
                    }
                    if (current != null) {
                        item {
                            QueueHeading(stringResource(R.string.creative_library_now_playing), active = true)
                            Row(Modifier.fillMaxWidth().heightIn(min = 64.dp),
                                verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Outlined.GraphicEq, null, Modifier.size(22.dp),
                                    tint = MaterialTheme.colorScheme.primary)
                                Text(current.title, Modifier.weight(1f).padding(horizontal = 12.dp),
                                    style = MaterialTheme.typography.bodyMedium, maxLines = 2,
                                    overflow = TextOverflow.Ellipsis)
                                val duration = state.durationMs.takeIf { it > 0 } ?: byKey[current.key]?.durationMs
                                duration?.let {
                                    Text(audioTime(it), style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                IconButton(onToggle) {
                                    Icon(if (state.playing) Icons.Outlined.Pause else Icons.Outlined.PlayArrow,
                                        stringResource(if (state.playing) R.string.creative_library_pause else R.string.creative_library_play))
                                }
                            }
                            if (state.buffering) LinearProgressIndicator(Modifier.fillMaxWidth())
                            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                            Spacer(Modifier.height(16.dp))
                        }
                    }
                    item {
                        QueueHeading(stringResource(R.string.queue_upcoming_count, display.upcoming.size))
                        if (display.upcoming.isEmpty()) {
                            Text(stringResource(if (orderedTracks.isEmpty()) R.string.creative_library_queue_empty
                                else R.string.queue_nothing_next), style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(vertical = 12.dp))
                        }
                    }
                    itemsIndexed(display.upcoming, key = { _, track -> "${track.key.ownerUid}/${track.key.jobId}" }) { index, track ->
                        QueueTrackRow(track, index + 1, byKey[track.key]?.durationMs, onSelect, onRemove)
                    }
                    if (display.other.isNotEmpty()) {
                        item {
                            Spacer(Modifier.height(16.dp))
                            QueueHeading(stringResource(R.string.queue_other))
                        }
                        itemsIndexed(display.other, key = { _, track -> "${track.key.ownerUid}/${track.key.jobId}" }) { index, track ->
                            QueueTrackRow(track, index + 1, byKey[track.key]?.durationMs, onSelect, onRemove)
                        }
                    }
                }
                QueueBottomControls(state, onShuffle, onRepeat, onAutoNext)
            }
        }
    }
}

@Composable
private fun QueueHeading(title: String, active: Boolean = false) {
    Text(title, Modifier.padding(vertical = 8.dp).semantics { heading() },
        style = MaterialTheme.typography.labelMedium,
        color = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun QueueTrackRow(
    track: QueueTrack, number: Int, duration: Long?,
    onSelect: (LibraryKey) -> Unit, onRemove: (LibraryKey) -> Unit,
) {
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(
            Modifier.weight(1f).heightIn(min = CreativeTokens.TouchTarget)
                .clickable(role = Role.Button, onClickLabel = stringResource(R.string.creative_library_play)) { onSelect(track.key) },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(number.toString(), Modifier.widthIn(min = 24.dp),
                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(track.title, Modifier.weight(1f).padding(horizontal = 8.dp, vertical = 8.dp),
                style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            duration?.let {
                Text(audioTime(it), style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        IconButton({ onRemove(track.key) }) {
            Icon(Icons.Outlined.Close, stringResource(R.string.creative_library_remove_queue) + ": " + track.title)
        }
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun QueueBottomControls(
    state: PlaybackState, onShuffle: (Boolean) -> Unit,
    onRepeat: (RepeatMode) -> Unit, onAutoNext: (Boolean) -> Unit,
) {
    Surface(
        modifier = Modifier.widthIn(max = CreativeTokens.ContentWidth).fillMaxWidth().padding(12.dp),
        shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        Column(Modifier.padding(8.dp)) {
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                val control = Modifier.weight(1f).widthIn(min = 96.dp)
                TextButton({ onShuffle(!state.shuffle) }, modifier = control.semantics { selected = state.shuffle }) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(Icons.Outlined.Shuffle, null)
                        Text(stringResource(if (state.shuffle) R.string.queue_shuffle_on else R.string.queue_shuffle_off),
                            style = MaterialTheme.typography.labelSmall)
                    }
                }
                TextButton({ onRepeat(state.repeatMode.nextMode()) }, modifier = control) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(if (state.repeatMode == RepeatMode.ONE) Icons.Outlined.RepeatOne else Icons.Outlined.Repeat, null)
                        Text(stringResource(state.repeatMode.label()), style = MaterialTheme.typography.labelSmall)
                    }
                }
                Column(control, horizontalAlignment = Alignment.CenterHorizontally) {
                    val autoNextLabel = stringResource(R.string.queue_auto_next)
                    Switch(state.autoNext, onAutoNext, modifier = Modifier.semantics {
                        contentDescription = autoNextLabel
                    })
                    Text(stringResource(R.string.queue_auto_next), style = MaterialTheme.typography.labelSmall)
                }
            }
            Text(stringResource(R.string.creative_library_queue_keeps),
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
