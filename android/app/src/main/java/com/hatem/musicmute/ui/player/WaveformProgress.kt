package com.hatem.musicmute.ui.player

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.hatem.musicmute.R
import com.hatem.musicmute.VocalApplication
import com.hatem.musicmute.playback.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.StateFlow

@Composable
internal fun WaveformProgress(playback: StateFlow<PlaybackState>, onSeek: (Long) -> Unit) {
    val app = LocalContext.current.applicationContext as VocalApplication
    val controls = remember(playback) { playback.controls() }
    val state by controls.collectAsStateWithLifecycle(remember(playback) { playback.value.withoutPosition() })
    val owner by app.processingSessions.collectAsStateWithLifecycle()
    val track = state.queue.getOrNull(state.currentIndex)
    var peaks by remember(track?.key, state.original, owner) { mutableStateOf<List<Float>>(emptyList()) }
    var loading by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf(false) }
    var retry by remember { mutableIntStateOf(0) }
    LaunchedEffect(track?.key, state.original, state.durationMs, owner, retry) {
        peaks = emptyList(); failure = false
        val key = track?.key ?: return@LaunchedEffect
        val expected = owner ?: return@LaunchedEffect
        if (key.ownerUid != expected.uid || state.durationMs <= 0) return@LaunchedEffect
        loading = true
        try {
            val file = if (state.original) app.resolveOriginalFile(key) else requireNotNull(app.libraryRepository.localFile(key))
            if (app.processingSession() != expected) return@LaunchedEffect
            val result = app.localAudioTools.waveform(key, state.original, file, state.durationMs)
            if (app.processingSession() == expected) peaks = result
        } catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { failure = true }
        finally { loading = false }
    }
    Column {
        WaveformSeek(playback, onSeek, peaks)
        if (loading) Text(stringResource(R.string.listen_waveform_loading), style = MaterialTheme.typography.labelSmall)
        if (failure) TextButton({ retry++ }) { Text(stringResource(R.string.listen_waveform_retry)) }
    }
}

@Composable
private fun WaveformSeek(playback: StateFlow<PlaybackState>, onSeek: (Long) -> Unit, peaks: List<Float>) {
    val state by playback.collectAsStateWithLifecycle()
    PlaybackProgress(state, onSeek, peaks = peaks)
}
