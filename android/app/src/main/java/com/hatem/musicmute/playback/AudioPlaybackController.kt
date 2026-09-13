package com.hatem.musicmute.playback

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Bundle
import androidx.core.content.ContextCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.media3.session.SessionCommand
import com.hatem.musicmute.library.LibraryKey
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
    val queue: List<QueueTrack> = emptyList(),
    val currentIndex: Int = -1,
    val repeatMode: RepeatMode = RepeatMode.OFF,
    val shuffle: Boolean = false,
    val autoNext: Boolean = true,
    val orderedQueue: List<QueueTrack> = emptyList(),
)

class AudioPlaybackController(context: Context) : QueueCommands {
    private val dependencies = context.applicationContext as? PlaybackDependencies
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
    private var pendingQueue: Pair<List<QueueTrack>, LibraryKey>? = null
    private var released = false
    private var clearPrivateOnConnect = false
    private var queueTimeline: Timeline? = null
    private var queueShuffle = false
    private var cachedQueue = emptyList<QueueTrack>()
    private var cachedOrder = emptyList<QueueTrack>()
    private var libraryTitles: Map<LibraryKey, String> = emptyMap()
    private val listener =
        object : Player.Listener {
            override fun onEvents(player: Player, events: Player.Events) {
                if (events.contains(Player.EVENT_TIMELINE_CHANGED)) synchronizeTitles()
                if (player.playbackState == Player.STATE_READY && player.playerError == null) {
                    mutableState.update { it.copy(failed = false) }
                }
                refresh(rebuildQueue = events.contains(Player.EVENT_MEDIA_METADATA_CHANGED))
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
                        pendingQueue?.let { (tracks, key) -> pendingQueue = null; playQueue(tracks, key) }
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
        pendingQueue = null
        if (pending?.first?.id?.startsWith("processing:") == true) pending = null
        controller?.let { player ->
            if (player.currentMediaItem?.mediaId?.startsWith("processing:") == true) {
                player.stop()
                player.clearMediaItems()
            }
            refresh()
        }
    }

    override fun playQueue(tracks: List<QueueTrack>, startKey: LibraryKey) {
        val owner = dependencies?.currentPlaybackSession()?.uid
        val queue = tracks.distinctBy { it.key }
        if (owner == null || queue.any { it.key.ownerUid != owner } || queue.none { it.key == startKey }) {
            reportMissingFile(); return
        }
        val player = controller
        if (player == null) { pendingQueue = queue to startKey; return }
        pending = null
        player.setMediaItems(queue.map { it.mediaItem() }, queue.indexOfFirst { it.key == startKey }, 0)
        player.prepare(); player.play()
        mutableState.update { it.copy(failed = false) }
        refresh()
    }

    override fun next() { controller?.seekToNextMediaItem(); refresh() }
    override fun previous() {
        controller?.let { if (it.currentPosition > 3000) it.seekTo(0) else it.seekToPreviousMediaItem() }
        refresh()
    }
    override fun setShuffle(enabled: Boolean) { controller?.shuffleModeEnabled = enabled; refresh() }
    override fun setRepeat(mode: RepeatMode) { controller?.repeatMode = mode.playerMode(); refresh() }
    override fun setAutoNext(enabled: Boolean) {
        controller?.sendCustomCommand(SessionCommand(AUTO_NEXT_COMMAND, Bundle.EMPTY), Bundle().apply { putBoolean(AUTO_NEXT_KEY, enabled) })
        refresh()
    }
    fun togglePlayback() {
        controller?.let { player ->
            if (player.playerError != null) {
                player.prepare()
                player.play()
            } else if (player.playWhenReady) player.pause() else {
                if (player.playbackState == Player.STATE_IDLE) player.prepare()
                if (player.playbackState == Player.STATE_ENDED) player.seekTo(0)
                player.play()
            }
        }
        refresh()
    }
    fun removeTrack(key: LibraryKey) {
        controller?.let { player ->
            for (index in player.mediaItemCount - 1 downTo 0) if (player.getMediaItemAt(index).queueTrack()?.key == key) player.removeMediaItem(index)
        }
        refresh()
    }

    fun selectQueueTrack(key: LibraryKey) {
        if (dependencies?.currentPlaybackSession()?.uid != key.ownerUid) return
        controller?.let { player ->
            val index = (0 until player.mediaItemCount).firstOrNull { player.getMediaItemAt(it).queueTrack()?.key == key }
                ?: return@let
            player.seekToDefaultPosition(index)
            player.prepare()
            player.play()
        }
        refresh()
    }

    /** Update the existing media items so queue, notification and Player titles agree. */
    fun updateLibraryTitles(titles: Map<LibraryKey, String>) {
        if (titles == libraryTitles) return
        libraryTitles = titles.toMap()
        synchronizeTitles()
    }

    private fun synchronizeTitles() {
        val player = controller ?: return
        for (index in 0 until player.mediaItemCount) {
            val item = player.getMediaItemAt(index)
            val track = item.queueTrack() ?: continue
            val title = libraryTitles[track.key] ?: continue
            if (title != track.title) {
                player.replaceMediaItem(index, item.buildUpon()
                    .setMediaMetadata(item.mediaMetadata.buildUpon().setTitle(title).build()).build())
            }
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

    private fun refresh(rebuildQueue: Boolean = false) {
        val player = controller ?: return
        val timeline = player.currentTimeline
        // Position ticks are O(1), even for a large Library queue. Rebuild only when
        // the immutable timeline, shuffle order or metadata actually changes.
        if (rebuildQueue || queueTimeline !== timeline || queueShuffle != player.shuffleModeEnabled) {
            queueTimeline = timeline
            queueShuffle = player.shuffleModeEnabled
            cachedQueue = (0 until player.mediaItemCount).mapNotNull { player.getMediaItemAt(it).queueTrack() }
            cachedOrder = buildList {
                var index = timeline.getFirstWindowIndex(player.shuffleModeEnabled)
                val visited = mutableSetOf<Int>()
                while (index in 0 until player.mediaItemCount && visited.add(index)) {
                    player.getMediaItemAt(index).queueTrack()?.let(::add)
                    index = timeline.getNextWindowIndex(index, Player.REPEAT_MODE_OFF, player.shuffleModeEnabled)
                }
            }
        }
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
                queue = cachedQueue,
                currentIndex = player.currentMediaItemIndex,
                repeatMode = player.repeatMode.queueRepeat(),
                shuffle = player.shuffleModeEnabled,
                autoNext = player.sessionExtras.getBoolean(AUTO_NEXT_KEY, true),
                orderedQueue = cachedOrder,
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
