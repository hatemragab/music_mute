package com.hatem.musicmute.ui.player

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.QueueMusic
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
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
import com.hatem.musicmute.ui.library.libraryProblemLabel

@Composable
internal fun FullPlayer(
    state: PlaybackState,
    entry: LibraryEntry?,
    actions: PlayerActions,
    progress: @Composable () -> Unit = { PlaybackProgress(state, actions.seek) },
    downloadProgress: @Composable () -> Unit = {},
) {
    var panel by rememberSaveable { mutableStateOf<String?>(null) }
    // Restore unity gain when replacing the previous in-app volume control.
    LaunchedEffect(Unit) { actions.volume(1f) }
    BackHandler(enabled = panel == null, onBack = actions.back)
    CreativePage(Modifier.testTag("full-player")) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = CreativeTokens.TouchTarget),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(actions.back, Modifier.testTag("player-minimize")) {
                Icon(Icons.Outlined.KeyboardArrowDown, stringResource(R.string.player_minimize))
            }
            Text(
                stringResource(R.string.creative_library_now_playing),
                Modifier.weight(1f),
                style = MaterialTheme.typography.titleMedium,
                textAlign = TextAlign.Center,
            )
            IconButton(actions.info, enabled = state.trackId != null) {
                Icon(Icons.Outlined.Info, stringResource(R.string.creative_library_info))
            }
        }
        if (state.trackId == null) {
            CreativeFeedback(stringResource(R.string.ui_player_empty),
                actionLabel = stringResource(R.string.creative_library_back), onAction = actions.back)
            return@CreativePage
        }

        val title = entry?.title?.takeIf { it.isNotBlank() }
            ?: state.queue.getOrNull(state.currentIndex)?.title?.takeIf { it.isNotBlank() }
            ?: stringResource(R.string.voice_track)
        PlayerHero(
            title = title,
            original = state.original,
            entry = entry,
            saveEnabled = !state.switching,
            saveLabel = playerSaveLabel(state.original),
            onSave = if (state.original) actions.saveOriginal else actions.saveVoice,
            onStar = actions.star,
            modifier = Modifier.playerVerticalGestures(actions.back, {}).testTag("player-gesture-area"),
        )
        PlayerTrackSelector(
            original = state.original,
            enabled = !state.switching,
            onOriginalChange = actions.original,
        )
        if (state.comparisonFailed) Text(stringResource(R.string.original_unavailable), color = MaterialTheme.colorScheme.error)
        PlaybackActivityIndicator(state.buffering || state.switching)
        downloadProgress()
        if (state.failed) CreativeFeedback(stringResource(libraryProblemLabel(entry?.problem)), error = true,
            actionLabel = stringResource(R.string.retry), onAction = actions.toggle)
        progress()
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
        val repeatingCurrentTrack = state.repeatMode == RepeatMode.ONE
        PlayerUtilityStrip(
            speed = state.speed,
            repeatingCurrentTrack = repeatingCurrentTrack,
            onSpeed = { panel = "speed" },
            onQueue = actions.queue,
            onRepeatCurrentTrack = { actions.repeat(state.repeatMode.toggleCurrentTrackRepeat()) },
        )
        val upcoming = upcomingTracks(
            state.orderedQueue,
            state.queue.getOrNull(state.currentIndex)?.key,
            state.repeatMode,
            state.autoNext,
        ).firstOrNull()
        UpNextCard(
            title = upcoming?.title ?: stringResource(R.string.creative_library_queue_empty),
            autoNext = state.autoNext,
            onAutoNext = actions.autoNext,
            onQueue = actions.queue,
        )
    }
    if (panel != null && state.trackId != null) {
        PlayerSpeedSheet(state, actions) { panel = null }
    }
}

@Composable
private fun PlayerHero(
    title: String,
    original: Boolean,
    entry: LibraryEntry?,
    saveEnabled: Boolean,
    saveLabel: Int,
    onSave: () -> Unit,
    onStar: () -> Unit,
    modifier: Modifier = Modifier,
) {
    BoxWithConstraints(modifier.fillMaxWidth()) {
        val artworkSize = if (maxWidth < 330.dp) 120.dp else 136.dp
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            PlayerArtwork(Modifier.size(artworkSize))
            Column(
                Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    stringResource(if (original) R.string.original_track else R.string.creative_library_voice),
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.primary,
                )
                Row(verticalAlignment = Alignment.Top) {
                    Text(
                        title,
                        Modifier.weight(1f),
                        style = MaterialTheme.typography.titleLarge,
                        fontSize = 22.sp,
                        lineHeight = 27.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (entry != null) CreativeStarButton(
                        starred = entry.starred,
                        onClick = onStar,
                        description = stringResource(
                            if (entry.starred) R.string.creative_library_unstar else R.string.creative_library_star,
                        ),
                    )
                }
                TextButton(
                    onClick = onSave,
                    enabled = saveEnabled,
                    modifier = Modifier.heightIn(min = CreativeTokens.TouchTarget),
                    contentPadding = PaddingValues(horizontal = 0.dp, vertical = 4.dp),
                ) {
                    Icon(Icons.Outlined.Download, null, Modifier.size(CreativeTokens.SmallIcon))
                    Spacer(Modifier.width(6.dp))
                    Text(stringResource(saveLabel), maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

@Composable
private fun PlayerArtwork(modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(24.dp)
    val primary = MaterialTheme.colorScheme.primary
    Box(
        modifier
            .clip(shape)
            .background(
                Brush.linearGradient(
                    listOf(primary.copy(alpha = 0.28f), MaterialTheme.colorScheme.surfaceContainerHighest),
                ),
            )
            .border(1.dp, primary.copy(alpha = 0.18f), shape)
            .clearAndSetSemantics { },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            "♫",
            color = primary,
            fontSize = 64.sp,
            lineHeight = 64.sp,
            fontWeight = FontWeight.Medium,
        )
    }
}

@Composable
private fun PlayerTrackSelector(
    original: Boolean,
    enabled: Boolean,
    onOriginalChange: (Boolean) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth()
            .height(CreativeTokens.TouchTarget)
            .background(MaterialTheme.colorScheme.surfaceContainerLowest, RoundedCornerShape(14.dp))
            .padding(4.dp)
            .selectableGroup(),
    ) {
        PlayerTrackChoice(
            label = stringResource(R.string.voice_track),
            selected = !original,
            enabled = enabled,
            modifier = Modifier.weight(1f).testTag("player-voice-mode"),
            onClick = { onOriginalChange(false) },
        )
        PlayerTrackChoice(
            label = stringResource(R.string.original_track),
            selected = original,
            enabled = enabled,
            modifier = Modifier.weight(1f).testTag("player-original-mode"),
            onClick = { onOriginalChange(true) },
        )
    }
}

@Composable
private fun PlayerTrackChoice(
    label: String,
    selected: Boolean,
    enabled: Boolean,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    val contentColor = when {
        !enabled -> MaterialTheme.colorScheme.onSurface.copy(alpha = CreativeTokens.DisabledAlpha)
        selected -> MaterialTheme.colorScheme.onPrimaryContainer
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Box(
        modifier.fillMaxHeight()
            .clip(RoundedCornerShape(10.dp))
            .background(if (selected) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
            .selectable(selected = selected, enabled = enabled, role = Role.Tab, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            color = contentColor,
            style = MaterialTheme.typography.labelLarge,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun PlayerUtilityStrip(
    speed: Float,
    repeatingCurrentTrack: Boolean,
    onSpeed: () -> Unit,
    onQueue: () -> Unit,
    onRepeatCurrentTrack: () -> Unit,
) {
    val speedLabel = stringResource(R.string.player_speed)
    val speedValue = stringResource(R.string.player_speed_value, speed)
    val queueLabel = stringResource(R.string.creative_library_queue)
    val repeatLabel = stringResource(R.string.listener_repeat_song)
    val repeatActionLabel = stringResource(
        if (repeatingCurrentTrack) R.string.listener_repeat_song_clear else R.string.listener_repeat_song,
    )
    Surface(
        modifier = Modifier.fillMaxWidth().height(88.dp),
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f)),
    ) {
        Row(Modifier.fillMaxSize()) {
            PlayerUtilitySegment(
                icon = Icons.Outlined.Speed,
                label = speedValue,
                description = "$speedLabel $speedValue",
                onClick = onSpeed,
                accentLabel = true,
                modifier = Modifier.weight(1f).testTag("player-speed"),
            )
            PlayerUtilityDivider()
            PlayerUtilitySegment(
                icon = Icons.AutoMirrored.Outlined.QueueMusic,
                label = queueLabel,
                description = queueLabel,
                onClick = onQueue,
                modifier = Modifier.weight(1f),
            )
            PlayerUtilityDivider()
            PlayerUtilitySegment(
                icon = Icons.Outlined.RepeatOne,
                label = repeatLabel,
                description = repeatActionLabel,
                onClick = onRepeatCurrentTrack,
                selected = repeatingCurrentTrack,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun PlayerUtilitySegment(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    description: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    selected: Boolean = false,
    accentLabel: Boolean = false,
) {
    val contentColor = if (selected) {
        MaterialTheme.colorScheme.onPrimaryContainer
    } else {
        MaterialTheme.colorScheme.onSurfaceVariant
    }
    Column(
        modifier.fillMaxHeight()
            .background(if (selected) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { contentDescription = description }
            .padding(horizontal = 8.dp, vertical = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(icon, null, Modifier.size(22.dp), tint = contentColor)
        Spacer(Modifier.height(6.dp))
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = if (accentLabel && !selected) MaterialTheme.colorScheme.primary else contentColor,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun PlayerUtilityDivider() {
    VerticalDivider(
        Modifier.fillMaxHeight().padding(vertical = 12.dp),
        color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f),
    )
}

@Composable
private fun UpNextCard(
    title: String,
    autoNext: Boolean,
    onAutoNext: (Boolean) -> Unit,
    onQueue: () -> Unit,
) {
    val autoNextDescription = stringResource(R.string.creative_library_auto_next)
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f)),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(start = 14.dp, end = 6.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(stringResource(R.string.creative_library_up_next), style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary)
                Text(title, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(autoNextDescription, style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, textAlign = TextAlign.Center)
                Switch(
                    checked = autoNext,
                    onCheckedChange = onAutoNext,
                    modifier = Modifier.semantics {
                        contentDescription = autoNextDescription
                    },
                )
            }
            IconButton(onQueue) {
                Icon(Icons.AutoMirrored.Outlined.QueueMusic, stringResource(R.string.creative_library_queue))
            }
        }
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
