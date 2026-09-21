package com.hatem.musicmute.playback

import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.PlaybackException
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.ShuffleOrder.DefaultShuffleOrder
import androidx.media3.common.Timeline
import kotlin.random.Random
import android.net.Uri
import android.os.Bundle
import android.util.Log
import com.hatem.musicmute.library.LibraryKey
import com.hatem.musicmute.processing.ProcessingSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import androidx.media3.session.SessionError
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import java.io.IOException
import java.io.File
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.collectLatest
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.hatem.musicmute.MainActivity
import com.hatem.musicmute.VocalApplication

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class AudioPlaybackService : MediaSessionService() {
    private var session: MediaSession? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val checkpoints = Channel<Pair<ProcessingSession, QueueSnapshot>>(Channel.CONFLATED)
    private var owner: ProcessingSession? = null
    private var autoNext = true
    private var shuffleSeed = Random.nextLong()
    private var queueIdentity = emptyList<String>()
    private var restoring = false
    private val ownerRestore = OwnerQueueRestore()
    private val failedItems = mutableSetOf<Int>()
    private val dependencies get() = application as? PlaybackDependencies

    override fun onCreate() {
        super.onCreate()
        if ((application as? VocalApplication)?.updateAdmission?.isBlocked() == true) {
            stopSelf()
            return
        }
        scope.launch(Dispatchers.IO) {
            for ((expected, snapshot) in checkpoints) {
                try {
                    dependencies?.playbackQueueStore?.save(expected.uid, snapshot) {
                        dependencies?.currentPlaybackSession() == expected
                    }
                } catch (_: Exception) { /* Disk full must not crash playback. */ }
            }
        }
        val sources = ResolvingDataSource.Factory(DefaultDataSource.Factory(this)) { spec ->
            if (spec.uri.scheme != "musicmute") {
                // Legacy downloads may still supply a private local file during migration.
                val local = spec.uri.path?.let(::File)?.canonicalFile
                val roots = listOf(filesDir.canonicalFile, noBackupFilesDir.canonicalFile)
                if (spec.uri.scheme != "file" || local == null || !local.isFile ||
                    roots.none { local.path.startsWith(it.path + File.separator) })
                    throw IOException("Only private local audio is supported")
                spec
            } else {
                val expected = owner ?: throw IOException("Playback account unavailable")
                val deps = dependencies ?: throw IOException("Playback unavailable")
                val parts = spec.uri.pathSegments
                if (parts.size != 2 || parts[0] != expected.uid || deps.currentPlaybackSession() != expected)
                    throw IOException("Playback account changed")
                val file = try { runBlocking {
                    resolveQueueFile(LibraryKey(parts[0], parts[1]), expected, deps::currentPlaybackSession, deps::resolvePlaybackFile)
                } }
                    catch (error: Exception) { throw IOException("Audio unavailable", error) }
                if (deps.currentPlaybackSession() != expected || !file.isFile || file.length() == 0L)
                    throw IOException("Audio unavailable")
                spec.withUri(Uri.fromFile(file))
            }
        }
        val player =
            ExoPlayer.Builder(this).setMediaSourceFactory(DefaultMediaSourceFactory(sources)).build().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(C.USAGE_MEDIA)
                        .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                        .build(),
                    true,
                )
                setHandleAudioBecomingNoisy(true)
                setWakeMode(C.WAKE_MODE_LOCAL)
            }
        player.addListener(object : Player.Listener {
            override fun onShuffleModeEnabledChanged(enabled: Boolean) {
                if (!restoring && enabled) {
                    shuffleSeed = Random.nextLong()
                    player.setShuffleOrder(DefaultShuffleOrder(queueOrder(player.mediaItemCount, true, shuffleSeed, player.currentMediaItemIndex).toIntArray(), shuffleSeed))
                }
            }
            override fun onTimelineChanged(timeline: Timeline, reason: Int) {
                val ids = (0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId }
                if (ids != queueIdentity) {
                    queueIdentity = ids
                    failedItems.clear()
                    if (player.shuffleModeEnabled && !restoring) {
                        shuffleSeed = Random.nextLong()
                        player.setShuffleOrder(DefaultShuffleOrder(queueOrder(ids.size, true, shuffleSeed, player.currentMediaItemIndex).toIntArray(), shuffleSeed))
                    }
                }
            }
            override fun onEvents(p: Player, events: Player.Events) {
                if (p.playbackState == Player.STATE_READY) failedItems.clear()
                player.pauseAtEndOfMediaItems = !autoNext && p.repeatMode != Player.REPEAT_MODE_ONE
                checkpoint()
            }
            override fun onPlayerError(error: PlaybackException) {
                val diagnostic = classifyPlaybackFailure(error)
                Log.e(
                    "MusicMutePlayback",
                    "playback_error source=${diagnostic.source} code=${diagnostic.code} " +
                        "retryable=${diagnostic.retryable} cause=${diagnostic.causeType} " +
                        "queueIndex=${player.currentMediaItemIndex}",
                )
                player.currentMediaItem?.queueTrack()?.key?.let { key ->
                    scope.launch(Dispatchers.IO) {
                        try {
                            dependencies?.reportPlaybackFailure(key, diagnostic)
                        } catch (error: CancellationException) {
                            throw error
                        } catch (_: Exception) {
                            // Diagnostics are best effort and never alter playback behavior.
                        }
                    }
                }
                failedItems.add(player.currentMediaItemIndex)
                val next = player.nextMediaItemIndex
                if (!autoNext || player.repeatMode == Player.REPEAT_MODE_ONE || !player.playWhenReady || next == C.INDEX_UNSET || next in failedItems) {
                    player.pause(); return
                }
                player.seekToDefaultPosition(next); player.prepare(); player.play()
            }
        })
        session =
            MediaSession.Builder(this, player)
                .setSessionActivity(MainActivity.historyPendingIntent(this))
                .setCallback(object : MediaSession.Callback {
                    override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult =
                        MediaSession.ConnectionResult.AcceptedResultBuilder(session).setAvailableSessionCommands(
                            MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
                                .add(SessionCommand(AUTO_NEXT_COMMAND, Bundle.EMPTY)).build()).build()
                    override fun onCustomCommand(session: MediaSession, controller: MediaSession.ControllerInfo, command: SessionCommand, args: Bundle): ListenableFuture<SessionResult> {
                        if (command.customAction != AUTO_NEXT_COMMAND) return Futures.immediateFuture(SessionResult(SessionError.ERROR_NOT_SUPPORTED))
                        autoNext = args.getBoolean(AUTO_NEXT_KEY, true)
                        player.pauseAtEndOfMediaItems = !autoNext && player.repeatMode != Player.REPEAT_MODE_ONE
                        publishExtras(); checkpoint()
                        return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
                    }
                })
                .build()
        publishExtras()
        scope.launch { dependencies?.playbackSessions?.collectLatest { current ->
            if (!ownerRestore.attach(current)) return@collectLatest
            val old = owner
            owner = current
            restoring = true
            // The initial null -> authenticated attachment must restore before any timer/event save.
            // Subsequent transitions remove the prior session's in-memory and durable queue.
            if (old != null) {
                player.stop(); player.clearMediaItems(); failedItems.clear()
                withContext(Dispatchers.IO) { dependencies?.playbackQueueStore?.clear(old.uid) }
            }
            if (current == null) { restoring = false; return@collectLatest }
            val saved = withContext(Dispatchers.IO) { dependencies?.playbackQueueStore?.load(current.uid) }
            if (dependencies?.currentPlaybackSession() != current) return@collectLatest
            if (saved != null && player.mediaItemCount == 0) {
                autoNext = saved.autoNext
                shuffleSeed = saved.shuffleSeed
                player.repeatMode = saved.repeat.playerMode()
                player.setMediaItems(saved.tracks.map { it.mediaItem() }, saved.index, saved.positionMs)
                player.setShuffleOrder(DefaultShuffleOrder(saved.order.takeIf { it.sorted() == saved.tracks.indices.toList() }
                    ?.toIntArray() ?: queueOrder(saved.tracks.size, saved.shuffle, shuffleSeed, saved.index).toIntArray(), shuffleSeed))
                player.shuffleModeEnabled = saved.shuffle
                player.playWhenReady = false // No prepare: restore cannot download or autoplay.
                publishExtras()
            }
            restoring = false
            ownerRestore.restored(current)
        } }
        scope.launch { while (isActive) { delay(2000); checkpoint() } }
    }

    private fun publishExtras() { session?.setSessionExtras(Bundle().apply { putBoolean(AUTO_NEXT_KEY, autoNext) }) }

    private fun checkpoint() {
        val expected = owner ?: return
        val player = session?.player ?: return
        if (restoring || !ownerRestore.canCheckpoint(expected)) return
        if (dependencies?.currentPlaybackSession() != expected) return
        val tracks = (0 until player.mediaItemCount).mapNotNull { player.getMediaItemAt(it).queueTrack() }
        if (tracks.size != player.mediaItemCount || tracks.any { it.key.ownerUid != expected.uid }) return
        val order = mutableListOf<Int>()
        var index = player.currentTimeline.getFirstWindowIndex(player.shuffleModeEnabled)
        while (index != C.INDEX_UNSET && index !in order) {
            order.add(index)
            index = player.currentTimeline.getNextWindowIndex(index, Player.REPEAT_MODE_OFF, player.shuffleModeEnabled)
        }
        val snapshot = QueueSnapshot(tracks, player.currentMediaItemIndex, player.currentPosition,
            player.repeatMode.queueRepeat(), player.shuffleModeEnabled, autoNext, shuffleSeed, order)
        checkpoints.trySend(expected to snapshot)
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? =
        session.takeIf {
            (application as? VocalApplication)?.updateAdmission?.isBlocked() != true &&
                (controllerInfo.packageName == packageName || controllerInfo.isTrusted)
        }

    override fun onDestroy() {
        session?.run {
            player.release()
            release()
        }
        session = null
        checkpoints.close()
        scope.cancel()
        super.onDestroy()
    }
}
