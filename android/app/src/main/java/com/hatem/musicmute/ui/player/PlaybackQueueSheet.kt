package com.hatem.musicmute.ui.player

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.library.*
import com.hatem.musicmute.playback.*
import com.hatem.musicmute.ui.design.*
import com.hatem.musicmute.ui.library.*

@Composable
fun PlaybackQueueSheet(state: PlaybackState, entries: List<LibraryEntry>, onDismiss: () -> Unit,
    onSelect: (LibraryKey) -> Unit, onRemove: (LibraryKey) -> Unit, onAutoNext: (Boolean) -> Unit,
    onShuffle: (Boolean) -> Unit, onRepeat: (RepeatMode) -> Unit,
    orderedTracks: List<QueueTrack> = state.queue,
) {
    CreativeSheet(onDismiss) {
        Text(stringResource(R.string.creative_library_queue), style = MaterialTheme.typography.headlineSmall)
        if (state.failed) CreativeFeedback(stringResource(R.string.creative_library_failed), error = true)
        if (orderedTracks.isEmpty()) Text(stringResource(R.string.creative_library_queue_empty))
        val byKey = remember(entries) { entries.associateBy { it.key } }
        val listState = rememberLazyListState(initialFirstVisibleItemIndex = orderedTracks.indexOfFirst { it.key == state.queue.getOrNull(state.currentIndex)?.key }.coerceAtLeast(0))
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 360.dp), state = listState, verticalArrangement = Arrangement.spacedBy(8.dp)) {
          items(orderedTracks, key = { "${it.key.ownerUid}/${it.key.jobId}" }) { track ->
            val entry = byKey[track.key]
            val current = state.queue.getOrNull(state.currentIndex)?.key == track.key
            CreativeCard(Modifier.semantics { selected = current }.clickable { onSelect(track.key) }) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(if (current && state.playing) Icons.Outlined.GraphicEq else Icons.Outlined.PlayArrow, null, tint = if (current) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                    Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                        Text(track.title, style = MaterialTheme.typography.titleMedium)
                        if (entry != null) Text(offlineLabel(entry.offlineStatus), style = MaterialTheme.typography.labelSmall)
                    }
                    entry?.durationMs?.let { Text(audioTime(it), style = MaterialTheme.typography.labelSmall) }
                    IconButton({ onRemove(track.key) }) { Icon(Icons.Outlined.Close, stringResource(R.string.creative_library_remove_queue)) }
                }
            }
          }
        }
        CreativeCard {
            AutoNextRow(state.autoNext, onAutoNext)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                val description = stringResource(R.string.creative_library_shuffle)
                Text(description, Modifier.weight(1f)); Switch(state.shuffle, onShuffle, Modifier.semantics { contentDescription = description })
            }
            TextButton({ onRepeat(state.repeatMode.nextMode()) }) { Text(stringResource(state.repeatMode.label())) }
        }
        Text(stringResource(R.string.creative_library_queue_keeps), style = MaterialTheme.typography.bodySmall)
        TextButton(onDismiss) { Text(stringResource(R.string.creative_library_close)) }
    }
}
