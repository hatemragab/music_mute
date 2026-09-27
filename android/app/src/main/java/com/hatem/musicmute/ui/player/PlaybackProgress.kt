package com.hatem.musicmute.ui.player

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.LayoutDirection
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
@OptIn(ExperimentalMaterial3Api::class)
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
    val enabled = state.canSeekAudio()
    val seekLabel = stringResource(R.string.creative_library_seek)
    val activeTrackColor = MaterialTheme.colorScheme.primary
    val inactiveTrackColor = MaterialTheme.colorScheme.surfaceContainerHighest
    val layoutDirection = LocalLayoutDirection.current
    val thumbSize = if (compact) 12.dp else 16.dp
    val trackHeight = if (compact) 4.dp else 6.dp
    val slider: @Composable (Modifier) -> Unit = { modifier ->
        Slider(
            value = position,
            onValueChange = { seeking = it },
            onValueChangeFinished = {
                if (enabled) seeking?.let { onSeek(it.coerceIn(0f, maximum).toLong()) }
                seeking = null
            },
            valueRange = 0f..maximum,
            enabled = enabled,
            modifier = modifier.semantics { contentDescription = seekLabel },
            thumb = {
                Box(
                    Modifier
                        .size(thumbSize)
                        .background(
                            if (enabled) activeTrackColor else activeTrackColor.copy(alpha = 0.38f),
                            CircleShape,
                        ),
                )
            },
            track = { sliderState ->
                StableSeekTrack(
                    fraction = sliderState.coercedValueAsFraction,
                    activeColor = if (enabled) activeTrackColor else activeTrackColor.copy(alpha = 0.38f),
                    inactiveColor = if (enabled) inactiveTrackColor else inactiveTrackColor.copy(alpha = 0.38f),
                    rightToLeft = layoutDirection == LayoutDirection.Rtl,
                    modifier = Modifier.fillMaxWidth().height(trackHeight),
                )
            },
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

@Composable
private fun StableSeekTrack(
    fraction: Float,
    activeColor: Color,
    inactiveColor: Color,
    rightToLeft: Boolean,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier) {
        val cornerRadius = CornerRadius(size.height / 2f)
        drawRoundRect(color = inactiveColor, cornerRadius = cornerRadius)
        val activeWidth = size.width * fraction.coerceIn(0f, 1f)
        if (activeWidth > 0f) {
            drawRoundRect(
                color = activeColor,
                topLeft = Offset(if (rightToLeft) size.width - activeWidth else 0f, 0f),
                size = Size(activeWidth, size.height),
                cornerRadius = cornerRadius,
            )
        }
    }
}

/** Keeps playback status changes from moving the seek row and transport controls. */
@Composable
internal fun PlaybackActivityIndicator(active: Boolean, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(4.dp)) {
        if (active) {
            androidx.compose.material3.LinearProgressIndicator(Modifier.fillMaxSize())
        }
    }
}
