package com.hatem.musicmute.ui.player

import android.content.Intent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.hatem.musicmute.R
import com.hatem.musicmute.VocalApplication
import com.hatem.musicmute.playback.*
import com.hatem.musicmute.ui.library.audioTime
import kotlinx.coroutines.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ListeningToolsSheet(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val app = context.applicationContext as VocalApplication
    val controls = remember(app) { app.audioPlayback.state.controls() }
    val state by controls.collectAsStateWithLifecycle(remember(app) { app.audioPlayback.state.value.withoutPosition() })
    val owner by app.processingSessions.collectAsStateWithLifecycle()
    val track = state.queue.getOrNull(state.currentIndex)
    val scope = rememberCoroutineScope()
    var marks by remember(track?.key, state.original, owner) { mutableStateOf(emptyList<AudioBookmark>()) }
    var label by remember(track?.key, state.original, owner) { mutableStateOf("") }
    var range by remember(track?.key, state.original, state.durationMs, owner) {
        mutableStateOf(0f..minOf(state.durationMs, 60_000).coerceAtLeast(1).toFloat())
    }
    var fade by remember { mutableStateOf(true) }
    var error by remember(track?.key, state.original, owner) { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var task by remember { mutableStateOf<kotlinx.coroutines.Job?>(null) }
    var bookmarkBusy by remember { mutableStateOf(false) }
    val rangeLabel = stringResource(R.string.listen_range)
    val enabled = track != null && owner?.uid == track.key.ownerUid && state.durationMs > 0 && !state.switching
    val selection = AudioRange(range.start.toLong(), range.endInclusive.toLong())

    LaunchedEffect(track?.key, state.original, owner) {
        val key = track?.key ?: return@LaunchedEffect
        marks = withContext(Dispatchers.IO) { app.bookmarks.load(key, state.original) }
    }
    LaunchedEffect(track?.key, state.original, owner) { task?.cancel(); busy = false }
    DisposableEffect(Unit) { onDispose { task?.cancel() } }
    fun saveBookmarks(values: List<AudioBookmark>) {
        val key = track?.key ?: return
        val expected = owner ?: return
        val original = state.original
        if (bookmarkBusy) return
        bookmarkBusy = true
        scope.launch {
            try {
                withContext(Dispatchers.IO) {
                    check(app.processingSession() == expected)
                    app.bookmarks.save(key, original, values)
                }
                if (app.processingSession() == expected) marks = values.sortedBy { it.positionMs }
            } catch (cancel: CancellationException) { throw cancel }
            catch (_: Exception) { error = true }
            finally { bookmarkBusy = false }
        }
    }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp).imePadding(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(R.string.listen_tools), style = MaterialTheme.typography.headlineSmall)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.listen_skip_silence), Modifier.weight(1f))
                Switch(state.skipSilence, { value -> app.audioPlayback.listeningAction("silence") { putBoolean("enabled", value) } }, enabled = enabled,
                    modifier = Modifier.semantics { contentDescription = context.getString(R.string.listen_skip_silence) })
            }
            Text(stringResource(R.string.listen_sleep), style = MaterialTheme.typography.titleMedium)
            if (state.sleepAt > 0 || state.sleepEnd) Text(stringResource(R.string.listen_timer_active))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(15, 30, 60).forEach { minutes ->
                    OutlinedButton({ app.audioPlayback.listeningAction("sleep") { putInt("minutes", minutes); putBoolean("fade", fade) } }, enabled = enabled, modifier = Modifier.weight(1f)) {
                        Text(stringResource(R.string.listen_minutes, minutes))
                    }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(fade, { fade = it }, modifier = Modifier.semantics { contentDescription = context.getString(R.string.listen_fade) })
                Text(stringResource(R.string.listen_fade))
            }
            Row {
                TextButton({ app.audioPlayback.listeningAction("sleep") { putBoolean("endOfTrack", true) } }, enabled = enabled) { Text(stringResource(R.string.listen_end_track)) }
                TextButton({ app.audioPlayback.listeningAction("sleep") }, enabled = state.sleepAt > 0 || state.sleepEnd) { Text(stringResource(R.string.listen_cancel_timer)) }
            }
            HorizontalDivider()
            Text(stringResource(R.string.listen_range), style = MaterialTheme.typography.titleMedium)
            Text("${audioTime(selection.startMs)} – ${audioTime(selection.endMs)}")
            RangeSlider(range, { range = it }, valueRange = 0f..state.durationMs.coerceAtLeast(1).toFloat(),
                enabled = enabled && !busy, modifier = Modifier.fillMaxWidth().semantics { contentDescription = rangeLabel })
            Row {
                TextButton({ range = app.audioPlayback.state.value.positionMs.toFloat().coerceIn(0f, range.endInclusive)..range.endInclusive }, enabled = enabled && !busy) { Text(stringResource(R.string.listen_mark_a)) }
                TextButton({ range = range.start..app.audioPlayback.state.value.positionMs.toFloat().coerceIn(range.start, state.durationMs.toFloat()) }, enabled = enabled && !busy) { Text(stringResource(R.string.listen_mark_b)) }
            }
            Row {
                OutlinedButton({ app.audioPlayback.listeningAction("loop") { putLong("start", selection.startMs); putLong("end", selection.endMs) } }, enabled = enabled && selection.valid(state.durationMs)) {
                    Text(stringResource(R.string.listen_loop))
                }
                TextButton({ app.audioPlayback.listeningAction("clearLoop") }, enabled = state.loopStart >= 0) { Text(stringResource(R.string.listen_clear_loop)) }
            }
            if (state.loopStart >= 0) Text(stringResource(R.string.listen_loop_active, audioTime(state.loopStart), audioTime(state.loopEnd)))
            Text(stringResource(R.string.listen_clip_hint), style = MaterialTheme.typography.bodySmall)
            Button(onClick = {
                val key = track?.key ?: return@Button
                val expected = owner ?: return@Button
                busy = true; error = false
                task = scope.launch {
                    try {
                        val file = requireNotNull(app.libraryRepository.localFile(key))
                        check(app.processingSession() == expected)
                        val intent = app.localAudioTools.clip(key, file, selection, state.durationMs)
                        if (app.processingSession() == expected && !app.updateAdmission.isBlocked())
                            context.startActivity(Intent.createChooser(intent, context.getString(R.string.listen_share_clip)))
                    } catch (cancel: CancellationException) { throw cancel }
                    catch (_: Exception) { error = true }
                    finally { busy = false }
                }
            }, enabled = enabled && !state.original && !busy && clipRangeValid(selection, state.durationMs)) { Text(stringResource(R.string.listen_share_clip)) }
            if (busy) {
                LinearProgressIndicator(Modifier.fillMaxWidth())
                TextButton({ task?.cancel() }) { Text(stringResource(R.string.auth_cancel)) }
            }
            HorizontalDivider()
            Text(stringResource(R.string.listen_bookmarks), style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(label, { label = it.take(80) }, label = { Text(stringResource(R.string.listen_bookmark_label)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedButton({
                val position = app.audioPlayback.state.value.positionMs
                saveBookmarks((marks.filterNot { it.positionMs == position } + AudioBookmark(position, label)).take(100))
                label = ""
            }, enabled = enabled && marks.size < 100 && !bookmarkBusy) { Text(stringResource(R.string.listen_add_bookmark)) }
            marks.forEach { mark ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    TextButton({ app.audioPlayback.seek(mark.positionMs) }, Modifier.weight(1f), enabled = enabled) {
                        Text("${audioTime(mark.positionMs)}  ${mark.label}")
                    }
                    TextButton({ saveBookmarks(marks - mark) }, enabled = !bookmarkBusy,
                        modifier = Modifier.semantics { contentDescription = context.getString(R.string.listen_remove_bookmark_at, audioTime(mark.positionMs)) }) {
                        Text(stringResource(R.string.listen_remove_bookmark))
                    }
                }
            }
            if (marks.isEmpty()) Text(stringResource(R.string.listen_no_bookmarks), style = MaterialTheme.typography.bodySmall)
            if (error) Text(stringResource(R.string.listen_tools_error), color = MaterialTheme.colorScheme.error)
            TextButton(onDismiss, modifier = Modifier.align(Alignment.End)) { Text(stringResource(R.string.creative_library_close)) }
        }
    }
}
