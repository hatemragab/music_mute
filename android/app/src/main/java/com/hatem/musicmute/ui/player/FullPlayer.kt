package com.hatem.musicmute.ui.player

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.QueueMusic
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.hatem.musicmute.R
import com.hatem.musicmute.library.LibraryEntry
import com.hatem.musicmute.playback.PlaybackState
import com.hatem.musicmute.playback.RepeatMode
import com.hatem.musicmute.playback.upcomingTracks
import com.hatem.musicmute.ui.design.*
import com.hatem.musicmute.ui.library.*

@Composable
internal fun FullPlayer(state: PlaybackState, entry: LibraryEntry?, actions: PlayerActions) {
    var panel by rememberSaveable { mutableStateOf<String?>(null) }
    // Restore unity gain when replacing the previous in-app volume control.
    LaunchedEffect(Unit) { actions.volume(1f) }
    BackHandler(enabled = panel == null, onBack = actions.back)
    CreativePage(Modifier.testTag("full-player")) {
        Column(Modifier.fillMaxWidth().playerVerticalGestures(actions.back, {}),
            horizontalAlignment = Alignment.CenterHorizontally) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                IconButton(actions.back, Modifier.testTag("player-minimize")) {
                    Icon(Icons.Outlined.KeyboardArrowDown, stringResource(R.string.player_minimize))
                }
                Text(stringResource(R.string.creative_library_now_playing), Modifier.weight(1f),
                    style = MaterialTheme.typography.labelLarge, textAlign = TextAlign.Center)
                IconButton(actions.info, enabled = state.trackId != null) {
                    Icon(Icons.Outlined.Info, stringResource(R.string.creative_library_info))
                }
            }
            if (state.trackId != null) {
                Spacer(Modifier.height(16.dp))
                Box(Modifier.widthIn(max = 250.dp).fillMaxWidth().aspectRatio(1f), contentAlignment = Alignment.Center) {
                    Surface(Modifier.fillMaxSize(), shape = CircleShape,
                        color = MaterialTheme.colorScheme.primary.copy(alpha = 0.035f),
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.2f))) {
                        CreativeWave(Modifier.fillMaxSize().padding(14.dp).testTag("player-gesture-area"),
                            active = state.playing, intensity = 1f)
                    }
                    if (entry != null) Box(Modifier.align(Alignment.BottomEnd)) {
                        CreativeStarButton(entry.starred, actions.star,
                            stringResource(if (entry.starred) R.string.creative_library_unstar else R.string.creative_library_star))
                    }
                }
                Spacer(Modifier.height(12.dp))
                Text(stringResource(R.string.player_gesture_hint), Modifier.align(Alignment.CenterHorizontally),
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (state.trackId == null) {
            CreativeFeedback(stringResource(R.string.ui_player_empty),
                actionLabel = stringResource(R.string.creative_library_back), onAction = actions.back)
            return@CreativePage
        }
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.creative_library_voice), style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary)
                Text(entry?.title?.takeIf { it.isNotBlank() }
                    ?: state.queue.getOrNull(state.currentIndex)?.title?.takeIf { it.isNotBlank() }
                    ?: stringResource(R.string.voice_track),
                    style = MaterialTheme.typography.titleLarge, fontSize = 24.sp, lineHeight = 32.sp,
                    textAlign = TextAlign.Center)
            }
        if (state.buffering) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (state.failed) CreativeFeedback(stringResource(libraryProblemLabel(entry?.problem)), error = true,
            actionLabel = stringResource(R.string.retry), onAction = actions.toggle)
        Column {
            var seeking by remember(state.trackId) { mutableStateOf<Float?>(null) }
            val seekLabel = stringResource(R.string.creative_library_seek)
            Slider(value = seeking ?: state.positionMs.toFloat().coerceIn(0f, state.durationMs.coerceAtLeast(1).toFloat()),
                onValueChange = { seeking = it },
                onValueChangeFinished = { seeking?.let { actions.seek(it.toLong()) }; seeking = null },
                valueRange = 0f..state.durationMs.coerceAtLeast(1).toFloat(), enabled = state.canSeekAudio(),
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = seekLabel })
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(audioTime(seeking?.toLong() ?: state.positionMs), style = MaterialTheme.typography.labelMedium)
                Text(audioTime(state.durationMs), style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
            IconToggleButton(state.shuffle, actions.shuffle) {
                Icon(Icons.Outlined.Shuffle, stringResource(R.string.creative_library_shuffle), Modifier.size(21.dp),
                    tint = if (state.shuffle) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
            }
            IconButton(actions.previous, enabled = state.queue.isNotEmpty()) {
                Icon(Icons.Outlined.SkipPrevious, stringResource(R.string.creative_library_previous), Modifier.size(30.dp))
            }
            FilledIconButton(actions.toggle, Modifier.size(76.dp).testTag("player-toggle")) {
                Icon(if (state.playing) Icons.Outlined.Pause else Icons.Outlined.PlayArrow,
                    stringResource(if (state.playing) R.string.creative_library_pause else R.string.creative_library_play), Modifier.size(38.dp))
            }
            IconButton(actions.next, enabled = state.queue.isNotEmpty()) {
                Icon(Icons.Outlined.SkipNext, stringResource(R.string.creative_library_next), Modifier.size(30.dp))
            }
            val repeatLabel = stringResource(state.repeatMode.label())
            IconButton({ actions.repeat(state.repeatMode.nextMode()) }, Modifier.semantics { stateDescription = repeatLabel }) {
                Icon(if (state.repeatMode == RepeatMode.ONE) Icons.Outlined.RepeatOne else Icons.Outlined.Repeat,
                    repeatLabel, Modifier.size(21.dp),
                    tint = if (state.repeatMode != RepeatMode.OFF) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            TextButton({ panel = "speed" }, Modifier.weight(1f).heightIn(min = 48.dp).testTag("player-speed")) {
                Text(stringResource(R.string.player_speed_value, state.speed), style = MaterialTheme.typography.labelLarge)
            }
            TextButton(actions.queue, Modifier.weight(1f).heightIn(min = 48.dp)) {
                Icon(Icons.AutoMirrored.Outlined.QueueMusic, null, Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.creative_library_queue))
            }
        }
        Surface(color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                AutoNextRow(state.autoNext, actions.autoNext)
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f))
                val upcoming = upcomingTracks(state.orderedQueue, state.queue.getOrNull(state.currentIndex)?.key,
                    state.repeatMode, state.autoNext).firstOrNull()
                TextButton(actions.queue, Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(stringResource(R.string.creative_library_up_next), style = MaterialTheme.typography.labelMedium)
                        Text(upcoming?.title ?: stringResource(R.string.creative_library_queue_empty),
                            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Icon(Icons.AutoMirrored.Outlined.QueueMusic, stringResource(R.string.creative_library_queue))
                }
            }
        }
    }
    if (panel != null && state.trackId != null) {
        PlayerSpeedSheet(state, actions) { panel = null }
    }
}

/** Gesture zones exclude seek/volume sliders and the scrolling content. */
@Composable
internal fun Modifier.playerVerticalGestures(onDown: () -> Unit, onUp: () -> Unit): Modifier {
    val down by rememberUpdatedState(onDown)
    val up by rememberUpdatedState(onUp)
    val threshold = with(LocalDensity.current) { 64.dp.toPx() }
    return pointerInput(threshold) {
        var distance = 0f
        detectVerticalDragGestures(
            onDragStart = { distance = 0f }, onDragCancel = { distance = 0f },
            onDragEnd = {
                if (distance >= threshold) down() else if (distance <= -threshold) up()
                distance = 0f
            },
            onVerticalDrag = { change, amount -> change.consume(); distance += amount },
        )
    }
}

@Composable
private fun PlayerSpeedSheet(state: PlaybackState, actions: PlayerActions, dismiss: () -> Unit) {
    CreativeSheet(onDismiss = dismiss) {
        Text(stringResource(R.string.player_speed), style = MaterialTheme.typography.titleLarge)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(0.5f, 0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f).forEach { value ->
                    FilterChip(selected = state.speed == value, onClick = { actions.speed(value) },
                        label = { Text(stringResource(R.string.player_speed_value, value)) },
                        modifier = Modifier.heightIn(min = 48.dp))
                }
            }
        TextButton(dismiss, Modifier.align(Alignment.End)) { Text(stringResource(android.R.string.ok)) }
    }
}
