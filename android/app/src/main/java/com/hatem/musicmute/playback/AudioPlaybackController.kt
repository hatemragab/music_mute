package com.hatem.musicmute.playback

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import androidx.core.content.ContextCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.hatem.musicmute.download.DownloadRecord
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class PlaybackState(
    val trackId: String? = null,
    val playing: Boolean = false,
    val buffering: Boolean = false,
    val positionMs: Long = 0,
    val durationMs: Long = 0,
    val failed: Boolean = false,
)

class AudioPlaybackController(context: Context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mutableState = MutableStateFlow(PlaybackState())
    val state = mutableState.asStateFlow()
    private val future =
        MediaController.Builder(
                context,
                SessionToken(context, ComponentName(context, AudioPlaybackService::class.java)),
            )
            .buildAsync()
    private var controller: MediaController? = null
    private var pending: Pair<DownloadRecord, File>? = null
    private var released = false
    private var clearPrivateOnConnect = false
    private val listener =
        object : Player.Listener {
            override fun onEvents(player: Player, events: Player.Events) {
                refresh()
            }

            override fun onPlayerError(error: PlaybackException) {
                mutableState.update { it.copy(failed = true, playing = false, buffering = false) }
            }
        }

    init {
        future.addListener(
            {
                if (!released) {
                    try {
                        controller = future.get().also { it.addListener(listener) }
                        if (clearPrivateOnConnect) stopPrivateOutput()
                        refresh()
                        pending?.let { (record, file) ->
                            pending = null
                            toggle(record, file)
                        }
                    } catch (_: Exception) {
                        pending = null
                        mutableState.update {
                            it.copy(failed = true, playing = false, buffering = false)
                        }
                    }
                }
            },
            ContextCompat.getMainExecutor(context),
        )
        scope.launch {
            while (true) {
                refresh()
                delay(500)
            }
        }
    }

    fun stopPrivateOutput() {
        clearPrivateOnConnect = true
        if (pending?.first?.id?.startsWith("processing:") == true) pending = null
        controller?.let { player ->
            if (player.currentMediaItem?.mediaId?.startsWith("processing:") == true) {
                player.stop()
                player.clearMediaItems()
            }
            refresh()
        }
    }

    fun toggle(record: DownloadRecord, file: File) {
        val player = controller
        if (player == null) {
            if (future.isDone) {
                mutableState.update { it.copy(failed = true, buffering = false) }
                return
            }
            pending = record to file
            mutableState.update { it.copy(buffering = true, trackId = record.id) }
            return
        }
        mutableState.update { it.copy(failed = false) }
        if (player.currentMediaItem?.mediaId != record.id || player.playerError != null) {
            player.setMediaItem(
                MediaItem.Builder()
                    .setMediaId(record.id)
                    .setUri(Uri.fromFile(file))
                    .setMediaMetadata(MediaMetadata.Builder().setTitle(record.title).build())
                    .build()
            )
            player.prepare()
            player.play()
        } else if (player.playWhenReady && player.playbackState != Player.STATE_ENDED)
            player.pause()
        else {
            if (player.playbackState == Player.STATE_ENDED) player.seekTo(0)
            player.play()
        }
        refresh()
    }

    fun seek(positionMs: Long) {
        controller?.seekTo(positionMs.coerceAtLeast(0))
        refresh()
    }

    fun reportMissingFile() {
        mutableState.update { it.copy(failed = true) }
    }

    private fun refresh() {
        val player = controller ?: return
        mutableState.update { old ->
            old.copy(
                trackId = player.currentMediaItem?.mediaId,
                playing =
                    player.isPlaying ||
                        (player.playWhenReady && player.playbackState == Player.STATE_BUFFERING),
                buffering = player.playbackState == Player.STATE_BUFFERING,
                positionMs = player.currentPosition.coerceAtLeast(0),
                durationMs =
                    player.duration.takeUnless { it == C.TIME_UNSET }?.coerceAtLeast(0) ?: 0,
            )
        }
    }

    fun release() {
        released = true
        controller?.removeListener(listener)
        MediaController.releaseFuture(future)
        scope.cancel()
    }
}
