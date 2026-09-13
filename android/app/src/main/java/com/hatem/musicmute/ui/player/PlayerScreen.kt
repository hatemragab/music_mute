package com.hatem.musicmute.ui.player

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.library.LibraryEntry
import com.hatem.musicmute.playback.*
import com.hatem.musicmute.ui.design.*
import com.hatem.musicmute.ui.library.*

data class PlayerActions(
    val back: () -> Unit, val toggle: () -> Unit, val seek: (Long) -> Unit,
    val next: () -> Unit, val previous: () -> Unit, val shuffle: (Boolean) -> Unit,
    val repeat: (RepeatMode) -> Unit, val autoNext: (Boolean) -> Unit,
    val queue: () -> Unit, val info: () -> Unit, val star: () -> Unit,
)

@Composable
fun PlayerScreen(state: PlaybackState, entry: LibraryEntry?, actions: PlayerActions) {
    CreativePage {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            IconButton(actions.back) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, stringResource(R.string.creative_library_back)) }
            Text(stringResource(R.string.creative_library_now_playing), Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
            IconButton(actions.queue) { Icon(Icons.Outlined.QueueMusic, stringResource(R.string.creative_library_queue)) }
        }
        if (state.trackId == null) {
            CreativeFeedback(stringResource(R.string.ui_player_empty),
                actionLabel = stringResource(R.string.creative_library_back), onAction = actions.back)
            return@CreativePage
        }
        CreativeCard {
            CreativeWave(Modifier.fillMaxWidth().height(CreativeTokens.PlayerArtwork), active = state.playing, intensity = 1f)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(stringResource(R.string.creative_library_voice), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(entry?.title?.takeIf { it.isNotBlank() }
                        ?: state.queue.getOrNull(state.currentIndex)?.title?.takeIf { it.isNotBlank() }
                        ?: stringResource(R.string.voice_track), style = MaterialTheme.typography.headlineSmall)
                }
                if (entry != null) CreativeStarButton(entry.starred, actions.star, stringResource(if (entry.starred) R.string.creative_library_unstar else R.string.creative_library_star))
                IconButton(actions.info, enabled = state.trackId != null) { Icon(Icons.Outlined.Info, stringResource(R.string.creative_library_info)) }
            }
        }
        if (state.buffering) CreativeFeedback(stringResource(R.string.creative_library_preparing))
        if (state.failed) CreativeFeedback(stringResource(libraryProblemLabel(entry?.problem)), error = true,
            actionLabel = stringResource(R.string.retry), onAction = actions.toggle)
        var seeking by remember(state.trackId) { mutableStateOf<Float?>(null) }
        val seekLabel = stringResource(R.string.creative_library_seek)
        Slider(
            value = seeking ?: state.positionMs.toFloat().coerceIn(0f, state.durationMs.coerceAtLeast(1).toFloat()),
            onValueChange = { seeking = it }, onValueChangeFinished = { seeking?.let { actions.seek(it.toLong()) }; seeking = null },
            valueRange = 0f..state.durationMs.coerceAtLeast(1).toFloat(), enabled = state.canSeekAudio(),
            modifier = Modifier.semantics { contentDescription = seekLabel },
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(audioTime(seeking?.toLong() ?: state.positionMs)); Text(audioTime(state.durationMs))
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
            IconButton(actions.previous, enabled = state.queue.isNotEmpty()) { Icon(Icons.Outlined.SkipPrevious, stringResource(R.string.creative_library_previous)) }
            FilledIconButton(actions.toggle, Modifier.size(CreativeTokens.PlayerControl)) {
                Icon(if (state.playing) Icons.Outlined.Pause else Icons.Outlined.PlayArrow,
                    stringResource(if (state.playing) R.string.creative_library_pause else R.string.creative_library_play),
                    Modifier.size(CreativeTokens.PlayerIcon))
            }
            IconButton(actions.next, enabled = state.queue.isNotEmpty()) { Icon(Icons.Outlined.SkipNext, stringResource(R.string.creative_library_next)) }
        }
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
            IconToggleButton(state.shuffle, { actions.shuffle(it) }) { Icon(Icons.Outlined.Shuffle, stringResource(R.string.creative_library_shuffle), tint = if (state.shuffle) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant) }
            TextButton({ actions.repeat(state.repeatMode.nextMode()) },
                modifier = Modifier.semantics { selected = state.repeatMode != RepeatMode.OFF }) {
                Icon(if (state.repeatMode == RepeatMode.ONE) Icons.Outlined.RepeatOne else Icons.Outlined.Repeat, null)
                Spacer(Modifier.width(CreativeTokens.CompactGap))
                Text(stringResource(state.repeatMode.label()))
            }
        }
        CreativeCard { AutoNextRow(state.autoNext, actions.autoNext) }
        Text(stringResource(R.string.creative_library_up_next), style = MaterialTheme.typography.titleLarge)
        CreativeCard {
            val upcoming = com.hatem.musicmute.playback.upcomingTracks(
                state.orderedQueue, state.queue.getOrNull(state.currentIndex)?.key, state.repeatMode, state.autoNext)
            if (upcoming.isEmpty()) Text(stringResource(R.string.creative_library_queue_empty), color = MaterialTheme.colorScheme.onSurfaceVariant)
            upcoming.forEach { track -> Text(track.title,
                Modifier.fillMaxWidth().heightIn(min = CreativeTokens.TouchTarget).clickable(onClick = actions.queue)
                    .padding(vertical = CreativeTokens.CompactGap), maxLines = 2, overflow = TextOverflow.Ellipsis) }
            TextButton(actions.queue) { Text(stringResource(R.string.creative_library_queue)) }
        }
    }
}

@Composable
fun MiniPlayer(state: PlaybackState, onOpen: () -> Unit, onToggle: () -> Unit, onNext: () -> Unit) {
    if (state.trackId == null) return
    Surface(Modifier.fillMaxWidth().clickable(onClick = onOpen), shape = MaterialTheme.shapes.medium, tonalElevation = 4.dp) {
        Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            AudioBars(Modifier.size(32.dp))
            Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                Text(state.queue.getOrNull(state.currentIndex)?.title?.takeIf { it.isNotBlank() }
                    ?: stringResource(R.string.voice_track), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleSmall)
                if (state.buffering) LinearProgressIndicator(Modifier.fillMaxWidth())
                else if (state.failed) Text(stringResource(R.string.creative_library_failed),
                    color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall)
                else LinearProgressIndicator(progress = { playbackProgress(state.positionMs, state.durationMs) }, modifier = Modifier.fillMaxWidth())
                if (!state.failed) Text(audioTime(state.positionMs), style = MaterialTheme.typography.labelSmall)
            }
            IconButton(onToggle) { Icon(if (state.playing) Icons.Outlined.Pause else Icons.Outlined.PlayArrow, stringResource(if (state.playing) R.string.creative_library_pause else R.string.creative_library_play)) }
            IconButton(onNext, enabled = state.queue.isNotEmpty()) { Icon(Icons.Outlined.SkipNext, stringResource(R.string.creative_library_next)) }
        }
    }
}

@Composable internal fun AutoNextRow(enabled: Boolean, onChange: (Boolean) -> Unit) {
    val description = stringResource(R.string.creative_library_auto_next)
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.creative_library_auto_next), Modifier.weight(1f))
        Switch(enabled, onChange, modifier = Modifier.semantics { contentDescription = description })
    }
}
internal fun RepeatMode.nextMode() = when (this) { RepeatMode.OFF -> RepeatMode.ALL; RepeatMode.ALL -> RepeatMode.ONE; RepeatMode.ONE -> RepeatMode.OFF }
internal fun RepeatMode.label() = when (this) { RepeatMode.OFF -> R.string.creative_library_repeat_off; RepeatMode.ALL -> R.string.creative_library_repeat_all; RepeatMode.ONE -> R.string.creative_library_repeat_one }
