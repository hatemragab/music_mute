package com.hatem.musicmute.ui.player

import androidx.compose.foundation.clickable
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
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
    val speed: (Float) -> Unit, val volume: (Float) -> Unit,
)

@Composable
fun PlayerScreen(state: PlaybackState, entry: LibraryEntry?, actions: PlayerActions) {
    FullPlayer(state, entry, actions)
}

@Composable
fun MiniPlayer(
    state: PlaybackState,
    onOpen: () -> Unit,
    onToggle: () -> Unit,
    onNext: () -> Unit,
    onClose: () -> Unit,
    onSeek: (Long) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (state.trackId == null) return
    Surface(
        modifier.widthIn(max = CreativeTokens.ContentWidth).fillMaxWidth()
            .padding(top = 8.dp, bottom = 20.dp),
        shape = RoundedCornerShape(16.dp),
        color = Color.Transparent,
        contentColor = MaterialTheme.colorScheme.onSurface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f)),
    ) {
        Column(Modifier.padding(horizontal = 8.dp, vertical = 4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Row(
                    Modifier.weight(1f).clickable(onClick = onOpen)
                        .playerVerticalGestures(onDown = {}, onUp = onOpen),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.primaryContainer) {
                        Icon(Icons.Outlined.MusicNote, null,
                            Modifier.padding(8.dp).size(20.dp), tint = MaterialTheme.colorScheme.onPrimaryContainer)
                    }
                    Column(Modifier.weight(1f)) {
                        Text(state.queue.getOrNull(state.currentIndex)?.title?.takeIf { it.isNotBlank() }
                            ?: stringResource(R.string.voice_track), maxLines = 1,
                            overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleSmall)
                    }
                }
                FilledIconButton(onToggle) {
                    Icon(if (state.playing) Icons.Outlined.Pause else Icons.Outlined.PlayArrow,
                        stringResource(if (state.playing) R.string.creative_library_pause else R.string.creative_library_play))
                }
                IconButton(onNext, enabled = state.queue.isNotEmpty()) {
                    Icon(Icons.Outlined.SkipNext, stringResource(R.string.creative_library_next))
                }
                IconButton(onClose) {
                    Icon(Icons.Outlined.Close, stringResource(R.string.creative_library_close))
                }
            }
            if (state.buffering) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (state.failed) Text(stringResource(R.string.creative_library_failed),
                color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall)
            var seeking by remember(state.trackId) { mutableStateOf<Float?>(null) }
            val seekLabel = stringResource(R.string.creative_library_seek)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(audioTime(seeking?.toLong() ?: state.positionMs), style = MaterialTheme.typography.labelSmall)
                Slider(
                    value = seeking ?: state.positionMs.toFloat().coerceIn(0f, state.durationMs.coerceAtLeast(1).toFloat()),
                    onValueChange = { seeking = it },
                    onValueChangeFinished = { seeking?.let { onSeek(it.toLong()) }; seeking = null },
                    valueRange = 0f..state.durationMs.coerceAtLeast(1).toFloat(),
                    enabled = state.canSeekAudio(),
                    modifier = Modifier.weight(1f).semantics { contentDescription = seekLabel },
                )
                Text(audioTime(state.durationMs),
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
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
