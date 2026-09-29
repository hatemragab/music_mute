package com.hatem.musicmute.ui.player

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.scrollBy
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
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
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
import kotlin.math.abs
import kotlinx.coroutines.delay

/** A full-screen destination; only the track list scrolls, with controls fixed below it. */
@Composable
fun PlaybackQueueSheet(
    state: PlaybackState, entries: List<LibraryEntry>, onDismiss: () -> Unit,
    onSelect: (LibraryKey) -> Unit, onRemove: (LibraryKey) -> Unit, onAutoNext: (Boolean) -> Unit,
    onShuffle: (Boolean) -> Unit, onRepeat: (RepeatMode) -> Unit,
    orderedTracks: List<QueueTrack> = state.queue,
    onToggle: () -> Unit = {},
    onMove: (LibraryKey, LibraryKey) -> Unit = { _, _ -> },
    onPlayNext: (LibraryKey) -> Unit = {}, onClear: () -> Unit = {},
) {
    val current = state.queue.getOrNull(state.currentIndex)
    val display = remember(orderedTracks, current?.key, state.repeatMode, state.autoNext) {
        queueDisplay(orderedTracks, current?.key, state.repeatMode, state.autoNext)
    }
    val byKey = remember(entries) { entries.associateBy { it.key } }
    val listState = rememberLazyListState()
    var confirmClear by remember { mutableStateOf(false) }
    var dragging by remember { mutableStateOf<LibraryKey?>(null) }
    var dragY by remember { mutableFloatStateOf(0f) }
    var requestedOrder by remember { mutableStateOf<List<QueueTrack>?>(null) }
    val latestMove by rememberUpdatedState(onMove)
    val latestDisplay by rememberUpdatedState(display)
    val edge = with(LocalDensity.current) { 48.dp.toPx() }
    fun moveAtPointer() {
        val key = dragging ?: return
        val section = if (latestDisplay.upcoming.any { it.key == key }) latestDisplay.upcoming else latestDisplay.other
        if (requestedOrder == section) return
        val keys = section.map { queueRowKey(it.key) }
        val candidates = listState.layoutInfo.visibleItemsInfo.filter { it.key in keys }
        // Wait until layout and the service snapshot describe the same order.
        if (candidates.map { it.key } != keys.filter { key -> candidates.any { it.key == key } }) return
        val target = candidates.minByOrNull { abs(it.offset + it.size / 2f - dragY) } ?: return
        section.firstOrNull { queueRowKey(it.key) == target.key && it.key != key }?.let {
            requestedOrder = section
            latestMove(key, it.key)
        }
    }
    val startDrag: (LibraryKey) -> Unit = { key ->
        listState.layoutInfo.visibleItemsInfo.firstOrNull { it.key == queueRowKey(key) }?.let {
            dragY = it.offset + it.size / 2f
            requestedOrder = null
            dragging = key
        }
    }
    val drag: (Float) -> Unit = { delta -> dragY += delta; moveAtPointer() }
    val endDrag: () -> Unit = { dragging = null }
    LaunchedEffect(dragging) {
        while (dragging != null) {
            val info = listState.layoutInfo
            val amount = when {
                dragY < info.viewportStartOffset + edge -> -edge / 5
                dragY > info.viewportEndOffset - edge -> edge / 5
                else -> 0f
            }
            if (amount != 0f) { listState.scrollBy(amount); moveAtPointer() }
            delay(32)
        }
    }
    LaunchedEffect(current?.key) { dragging = null; listState.scrollToItem(0) }
    LaunchedEffect(orderedTracks) { if (orderedTracks.none { it.key == dragging }) dragging = null }

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
                        style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).semantics { heading() })
                    TextButton({ confirmClear = true }, enabled = display.upcoming.isNotEmpty() || display.other.isNotEmpty()) {
                        Text(stringResource(R.string.queue_clear))
                    }
                }
                LazyColumn(
                    Modifier.weight(1f).widthIn(max = CreativeTokens.ContentWidth).fillMaxWidth(),
                    state = listState,
                    contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
                ) {
                    if (state.queueEditFailed) item {
                        CreativeFeedback(stringResource(R.string.queue_edit_failed), error = true)
                    }
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
                        if (display.upcoming.isNotEmpty() || display.other.isNotEmpty()) {
                            Text(stringResource(R.string.queue_reorder_hint),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(bottom = 8.dp))
                        }
                        if (state.shuffle) Text(stringResource(R.string.queue_manual_order_hint),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        QueueHeading(stringResource(R.string.queue_upcoming_count, display.upcoming.size))
                        if (display.upcoming.isEmpty()) {
                            Text(stringResource(when {
                                orderedTracks.isEmpty() -> R.string.creative_library_queue_empty
                                state.repeatMode == RepeatMode.ONE -> R.string.queue_repeat_one_hint
                                !state.autoNext -> R.string.queue_auto_next_off_hint
                                else -> R.string.queue_nothing_next
                            }), style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(vertical = 12.dp))
                        }
                    }
                    itemsIndexed(display.upcoming, key = { _, track -> queueRowKey(track.key) }) { index, track ->
                        QueueTrackRow(track, index + 1, byKey[track.key]?.durationMs, onSelect, onRemove,
                            display.upcoming, onMove, onPlayNext, dragging == track.key,
                            { startDrag(track.key) }, drag, endDrag)
                    }
                    if (display.other.isNotEmpty()) {
                        item {
                            Spacer(Modifier.height(16.dp))
                            QueueHeading(stringResource(R.string.queue_other))
                        }
                        itemsIndexed(display.other, key = { _, track -> queueRowKey(track.key) }) { index, track ->
                            QueueTrackRow(track, index + 1, byKey[track.key]?.durationMs, onSelect, onRemove,
                                display.other, onMove, onPlayNext, dragging == track.key,
                                { startDrag(track.key) }, drag, endDrag)
                        }
                    }
                }
                QueueBottomControls(state, onShuffle, onRepeat, onAutoNext)
                if (confirmClear) AlertDialog(
                    onDismissRequest = { confirmClear = false },
                    title = { Text(stringResource(R.string.queue_clear_title)) },
                    text = { Text(stringResource(R.string.queue_clear_message)) },
                    confirmButton = { TextButton({ confirmClear = false; onClear() }) { Text(stringResource(R.string.queue_clear)) } },
                    dismissButton = { TextButton({ confirmClear = false }) { Text(stringResource(R.string.queue_cancel)) } },
                )
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
    section: List<QueueTrack>, onMove: (LibraryKey, LibraryKey) -> Unit,
    onPlayNext: (LibraryKey) -> Unit, dragging: Boolean,
    onDragStart: () -> Unit, onDrag: (Float) -> Unit, onDragEnd: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    val index = section.indexOfFirst { it.key == track.key }
    val moveUp = stringResource(R.string.queue_move_up)
    val moveDown = stringResource(R.string.queue_move_down)
    val playNext = stringResource(R.string.queue_play_next)
    val latestStart by rememberUpdatedState(onDragStart)
    val latestDrag by rememberUpdatedState(onDrag)
    val latestEnd by rememberUpdatedState(onDragEnd)
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp)
        .background(if (dragging) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.background)
        .semantics {
            customActions = buildList {
                add(CustomAccessibilityAction(playNext) { onPlayNext(track.key); true })
                if (index > 0) add(CustomAccessibilityAction(moveUp) { onMove(track.key, section[index - 1].key); true })
                if (index < section.lastIndex) add(CustomAccessibilityAction(moveDown) { onMove(track.key, section[index + 1].key); true })
            }
        }, verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(CreativeTokens.TouchTarget)
            .pointerInput(track.key) {
                detectDragGesturesAfterLongPress(
                    onDragStart = { latestStart() }, onDragEnd = { latestEnd() }, onDragCancel = { latestEnd() },
                    onDrag = { change, amount -> change.consume(); latestDrag(amount.y) },
                )
            }, contentAlignment = Alignment.Center) {
            Icon(Icons.Outlined.DragHandle, stringResource(R.string.queue_drag, track.title),
                tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
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
        Box {
            IconButton({ menu = true }) {
                Icon(Icons.Outlined.MoreVert, stringResource(R.string.queue_track_actions, track.title))
            }
            DropdownMenu(menu, { menu = false }) {
                DropdownMenuItem(text = { Text(playNext) }, onClick = { menu = false; onPlayNext(track.key) })
                DropdownMenuItem(text = { Text(moveUp) }, enabled = index > 0,
                    onClick = { menu = false; onMove(track.key, section[index - 1].key) })
                DropdownMenuItem(text = { Text(moveDown) }, enabled = index in 0 until section.lastIndex,
                    onClick = { menu = false; onMove(track.key, section[index + 1].key) })
                DropdownMenuItem(text = { Text(stringResource(R.string.creative_library_remove_queue)) },
                    onClick = { menu = false; onRemove(track.key) })
            }
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

private fun queueRowKey(key: LibraryKey): String = "${key.ownerUid}/${key.jobId}"
