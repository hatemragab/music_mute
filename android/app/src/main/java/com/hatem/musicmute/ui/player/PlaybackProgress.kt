package com.hatem.musicmute.ui.player

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.hatem.musicmute.R
import com.hatem.musicmute.playback.PlaybackState
import com.hatem.musicmute.ui.library.audioTime
import kotlinx.coroutines.flow.StateFlow

@Composable
internal fun PlaybackProgress(
    playback: StateFlow<PlaybackState>,
    onSeek: (Long) -> Unit,
    compact: Boolean = false,
) {
    val state by playback.collectAsStateWithLifecycle()
    PlaybackProgress(state, onSeek, compact)
}

/** Owns both ticking position and drag state in a separate restart scope. */
@Composable
internal fun PlaybackProgress(
    state: PlaybackState,
    onSeek: (Long) -> Unit,
    compact: Boolean = false,
) {
    // Original/voice may have different timelines even though they share a track ID.
    var seeking by remember(state.trackId, state.original, state.switching) { mutableStateOf<Float?>(null) }
    val maximum = state.durationMs.coerceAtLeast(1).toFloat()
    val position = (seeking ?: state.positionMs.toFloat()).coerceIn(0f, maximum)
    val seekLabel = stringResource(R.string.creative_library_seek)
    val slider: @Composable (Modifier) -> Unit = { modifier ->
        Slider(
            value = position,
            onValueChange = { seeking = it },
            onValueChangeFinished = {
                if (state.canSeekAudio()) seeking?.let { onSeek(it.coerceIn(0f, maximum).toLong()) }
                seeking = null
            },
            valueRange = 0f..maximum,
            enabled = state.canSeekAudio(),
            modifier = modifier.semantics { contentDescription = seekLabel },
        )
    }
    if (compact) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(audioTime(position.toLong()), style = MaterialTheme.typography.labelSmall)
            slider(Modifier.weight(1f))
            Text(audioTime(state.durationMs), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    } else {
        Column {
            slider(Modifier.fillMaxWidth())
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(audioTime(position.toLong()), style = MaterialTheme.typography.labelMedium)
                Text(audioTime(state.durationMs), style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
