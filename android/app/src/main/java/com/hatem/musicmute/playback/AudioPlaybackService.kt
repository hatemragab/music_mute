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
import kotlinx.coroutines.flow.first
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import androidx.media3.session.DefaultMediaNotificationProvider
import android.os.SystemClock
import com.hatem.musicmute.MainActivity
import com.hatem.musicmute.VocalApplication
import com.hatem.musicmute.createPlaybackNotificationChannel

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class AudioPlaybackService : MediaLibraryService() {
    private var session: MediaLibrarySession? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val checkpoints = Channel<Pair<ProcessingSession, QueueSnapshot>>(Channel.CONFLATED)
    private var owner: ProcessingSession? = null
    private var autoNext = true
    private var listeningLoop: AudioRange? = null
    private var listeningIdentity: String? = null
    private var sleepAt: Long? = null
    private var sleepEnd = false
    private var sleepFade = false
    private var fadeVolume: Float? = null
    private var skipSilence = false

    private fun clearSleep(player: Player) {
        fadeVolume?.let { player.volume = it }
        fadeVolume = null
        sleepAt = null
        sleepEnd = false
    }
    private var shuffleSeed = Random.nextLong()
    private var queueIdentity = emptyList<String>()
    private var restoring = false
    private val ownerRestore = OwnerQueueRestore()
    private val failedItems = mutableSetOf<Int>()
    private val dependencies get() = application as? PlaybackDependencies

    override fun onCreate() {
        super.onCreate()
        if ((application as? VocalApplication)?.updateAdmission?.isRequired() == true) {
            stopSelf()
            return
        }
        val notificationChannel = createPlaybackNotificationChannel(this)
        setMediaNotificationProvider(DefaultMediaNotificationProvider.Builder(this)
            .setChannelId(notificationChannel.id)
            .build())
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
            if (spec.uri.scheme != "musicmute") throw IOException("Unsupported audio source")
            run {
                val expected = owner ?: throw IOException("Playback account unavailable")
                val deps = dependencies ?: throw IOException("Playback unavailable")
                val parts = spec.uri.pathSegments
                if (parts.size != 2 || parts[0] != expected.uid || deps.currentPlaybackSession() != expected)
                    throw IOException("Playback account changed")
                val file = try { runBlocking {
                    resolveQueueFile(LibraryKey(parts[0], parts[1]), expected, deps::currentPlaybackSession) { key ->
                        if (spec.uri.authority == "input") deps.resolveOriginalFile(key) else deps.resolvePlaybackFile(key)
                    }
                } }
                    catch (error: Exception) { throw IOException("Audio unavailable", error) }
                if (deps.currentPlaybackSession() != expected || !file.isFile || file.length() == 0L)
                    throw IOException("Audio unavailable")
                spec.withUri(Uri.fromFile(file))
            }
        }
        val player =
            ExoPlayer.Builder(this, ListeningRenderersFactory(this))
                .setMediaSourceFactory(DefaultMediaSourceFactory(sources)).build().apply {
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
                val identity = p.currentMediaItem?.let { "${it.mediaId}:${it.localConfiguration?.uri}" }
                if (identity != listeningIdentity) {
                    listeningIdentity = identity
                    listeningLoop = null
                    publishExtras()
                    session?.notifyChildrenChanged("musicmute-recent", if (p.currentMediaItem == null) 0 else 1, null)
                }
                player.pauseAtEndOfMediaItems = sleepEnd || listeningLoop != null || (!autoNext && p.repeatMode != Player.REPEAT_MODE_ONE)
                val visible = owner != null && dependencies?.currentPlaybackSession() == owner &&
                    p.currentMediaItem?.queueTrack()?.key?.ownerUid == owner?.uid
                PlaybackWidget.update(this@AudioPlaybackService,
                    if (visible) p.currentMediaItem?.mediaMetadata?.title?.toString() else null, visible && p.isPlaying)
                checkpoint()
            }
            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                if (!playWhenReady && reason == Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM) {
                    if (sleepEnd) { clearSleep(player); publishExtras() }
                    else listeningLoop?.takeIf { it.valid(player.duration) }?.let { player.seekTo(it.startMs); player.play() }
                }
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
        val libraryCallback = object : PlaybackLibraryCallback(this, scope, { owner }, { ownerRestore.canCheckpoint(it) }) {
            override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
                if (!allowedController(controller)) return MediaSession.ConnectionResult.reject()
                val builder = MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                if (controller.packageName == packageName) builder.setAvailableSessionCommands(
                    MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS.buildUpon()
                        .add(SessionCommand(AUTO_NEXT_COMMAND, Bundle.EMPTY))
                        .add(SessionCommand(EDIT_QUEUE_COMMAND, Bundle.EMPTY))
                        .add(SessionCommand(LISTENING_COMMAND, Bundle.EMPTY)).build())
                return builder.build()
            }
            override fun onPlayerCommandRequest(session: MediaSession, controller: MediaSession.ControllerInfo, command: Int): Int {
                val admission = (application as? VocalApplication)?.updateAdmission
                if (admission?.isRequired() == true) return SessionError.ERROR_PERMISSION_DENIED
                // An empty session may accept a resume request; the async resumption callback
                // waits for both auth and update restoration before returning any media.
                if (session.player.mediaItemCount == 0 && command in setOf(Player.COMMAND_PLAY_PAUSE, Player.COMMAND_PREPARE))
                    return SessionResult.RESULT_SUCCESS
                return if (admission?.isBlocked() == true || owner == null || dependencies?.currentPlaybackSession() != owner)
                    SessionError.ERROR_PERMISSION_DENIED else SessionResult.RESULT_SUCCESS
            }

            override fun onCustomCommand(session: MediaSession, controller: MediaSession.ControllerInfo, command: SessionCommand, args: Bundle): ListenableFuture<SessionResult> {
                if (controller.packageName != packageName || owner == null || dependencies?.currentPlaybackSession() != owner ||
                    (application as? VocalApplication)?.updateAdmission?.isBlocked() == true)
                    return Futures.immediateFuture(SessionResult(SessionError.ERROR_PERMISSION_DENIED))
                if (command.customAction == EDIT_QUEUE_COMMAND) {
                    val expected = owner
                    val edit = QueueEdit.entries.firstOrNull { it.name == args.getString("edit") }
                    if (controller.packageName != packageName || expected == null || restoring ||
                        dependencies?.currentPlaybackSession() != expected ||
                        args.getString("owner") != expected.uid || args.getLong("epoch", -1) != expected.epoch || edit == null)
                        return Futures.immediateFuture(SessionResult(SessionError.ERROR_PERMISSION_DENIED))
                    val order = buildList {
                        var index = player.currentTimeline.getFirstWindowIndex(player.shuffleModeEnabled)
                        val visited = mutableSetOf<Int>()
                        while (index in 0 until player.mediaItemCount && visited.add(index)) {
                            player.getMediaItemAt(index).queueTrack()?.let(::add)
                            index = player.currentTimeline.getNextWindowIndex(index, Player.REPEAT_MODE_OFF, player.shuffleModeEnabled)
                        }
                    }
                    if (order.size != player.mediaItemCount || order.any { it.key.ownerUid != expected.uid })
                        return Futures.immediateFuture(SessionResult(SessionError.ERROR_PERMISSION_DENIED))
                    // Drag events may arrive before the previous playlist change is observed.
                    if (edit == QueueEdit.MOVE && args.getStringArrayList("order") != order.map { it.key.jobId })
                        return Futures.immediateFuture(SessionResult(SessionError.ERROR_BAD_VALUE))
                    val desired = editedQueue(order, player.currentMediaItem?.queueTrack()?.key, edit,
                        args.getString("job")?.let { LibraryKey(expected.uid, it) },
                        args.getString("target")?.let { LibraryKey(expected.uid, it) },
                        wrap = player.repeatMode == Player.REPEAT_MODE_ALL)
                        ?: return Futures.immediateFuture(SessionResult(SessionError.ERROR_BAD_VALUE))
                    // Materialize the visible order with moves, preserving current media/position.
                    if (edit != QueueEdit.CLEAR) player.shuffleModeEnabled = false
                    val keep = desired.mapTo(mutableSetOf()) { it.key }
                    for (index in player.mediaItemCount - 1 downTo 0) {
                        if (player.getMediaItemAt(index).queueTrack()?.key !in keep) player.removeMediaItem(index)
                    }
                    desired.forEachIndexed { to, track ->
                        val from = (to until player.mediaItemCount).first { player.getMediaItemAt(it).queueTrack()?.key == track.key }
                        if (from != to) player.moveMediaItem(from, to)
                    }
                    if (edit == QueueEdit.PLAY_NEXT) {
                        autoNext = true
                        if (player.repeatMode == Player.REPEAT_MODE_ONE) player.repeatMode = Player.REPEAT_MODE_OFF
                        player.pauseAtEndOfMediaItems = sleepEnd || listeningLoop != null
                    }
                    publishExtras(); checkpoint()
                    return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
                }
                when (command.customAction) {
                    AUTO_NEXT_COMMAND -> autoNext = args.getBoolean(AUTO_NEXT_KEY, true)
                    LISTENING_COMMAND -> when (args.getString("action")) {
                        "silence" -> { skipSilence = args.getBoolean("enabled"); player.skipSilenceEnabled = skipSilence }
                        "loop" -> {
                            val range = AudioRange(args.getLong("start", -1), args.getLong("end", -1))
                            if (!range.valid(player.duration)) return Futures.immediateFuture(SessionResult(SessionError.ERROR_BAD_VALUE))
                            if (sleepEnd) clearSleep(player)
                            listeningLoop = range
                            player.seekTo(range.startMs)
                        }
                        "clearLoop" -> listeningLoop = null
                        "sleep" -> {
                            clearSleep(player)
                            sleepAt = sleepDeadline(SystemClock.elapsedRealtime(), args.getInt("minutes"))
                            sleepEnd = args.getBoolean("endOfTrack")
                            if (sleepEnd) listeningLoop = null
                            sleepFade = args.getBoolean("fade")
                        }
                        else -> return Futures.immediateFuture(SessionResult(SessionError.ERROR_NOT_SUPPORTED))
                    }
                    else -> return Futures.immediateFuture(SessionResult(SessionError.ERROR_NOT_SUPPORTED))
                }
                player.pauseAtEndOfMediaItems = sleepEnd || listeningLoop != null || (!autoNext && player.repeatMode != Player.REPEAT_MODE_ONE)
                publishExtras(); checkpoint()
                return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
            }
        }
        session = MediaLibrarySession.Builder(this, player, libraryCallback)
            .setSessionActivity(MainActivity.playerPendingIntent(this)).build()
        publishExtras()
        scope.launch { dependencies?.playbackSessions?.collectLatest { current ->
            if (!ownerRestore.attach(current)) return@collectLatest
            val old = owner
            owner = current
            listeningLoop = null
            clearSleep(player)
            skipSilence = false
            player.skipSilenceEnabled = false
            publishExtras()
            restoring = true
            // The initial null -> authenticated attachment must restore before any timer/event save.
            // Subsequent transitions remove the prior session's in-memory and durable queue.
            if (old != null) {
                player.stop(); player.clearMediaItems(); failedItems.clear()
                withContext(Dispatchers.IO) { dependencies?.playbackQueueStore?.clear(old.uid) }
            }
            if (current == null) { restoring = false; return@collectLatest }
            (application as? VocalApplication)?.updateCoordinator?.state?.first { !it.restoring }
            if ((application as? VocalApplication)?.updateAdmission?.isBlocked() == true) return@collectLatest
            val saved = withContext(Dispatchers.IO) { dependencies?.playbackQueueStore?.load(current.uid) }
            if (dependencies?.currentPlaybackSession() != current) return@collectLatest
            if (saved != null && player.mediaItemCount == 0) {
                autoNext = saved.autoNext
                shuffleSeed = saved.shuffleSeed
                player.repeatMode = saved.repeat.playerMode()
                player.setMediaItems(saved.tracks.map { it.mediaItem(this@AudioPlaybackService) }, saved.index, saved.positionMs)
                player.setShuffleOrder(DefaultShuffleOrder(saved.order.takeIf { it.sorted() == saved.tracks.indices.toList() }
                    ?.toIntArray() ?: queueOrder(saved.tracks.size, saved.shuffle, shuffleSeed, saved.index).toIntArray(), shuffleSeed))
                player.shuffleModeEnabled = saved.shuffle
                player.playWhenReady = false // No prepare: restore cannot download or autoplay.
                publishExtras()
            }
            restoring = false
            ownerRestore.restored(current)
        } }
        scope.launch {
            (application as? VocalApplication)?.libraryRepository?.entries?.collectLatest { entries ->
                val expected = owner ?: return@collectLatest
                if (dependencies?.currentPlaybackSession() == expected) {
                    session?.notifyChildrenChanged("musicmute-library", entries.count { !it.hidden && it.key.ownerUid == expected.uid }, null)
                }
            }
        }
        scope.launch { while (isActive) { delay(2000); checkpoint() } }
        scope.launch {
            while (isActive) {
                val fading = sleepFade && sleepAt?.let { it - SystemClock.elapsedRealtime() in 1..5000 } == true
                delay(if (listeningLoop != null || fading) 100 else 1000)
                if (owner == null || dependencies?.currentPlaybackSession() != owner) continue
                if (player.isPlaying) loopSeek(player.currentPosition, listeningLoop, player.duration)?.let(player::seekTo)
                val remaining = sleepAt?.minus(SystemClock.elapsedRealtime())
                if (remaining != null && remaining <= 0) {
                    player.pause(); clearSleep(player); publishExtras(); checkpoint()
                } else if (sleepFade && remaining != null && remaining < 5000 && player.isPlaying) {
                    if (fadeVolume == null) fadeVolume = player.volume
                    player.volume = requireNotNull(fadeVolume) * (remaining / 5000f).coerceIn(0f, 1f)
                }
                if (sleepEnd && player.playbackState == Player.STATE_ENDED) {
                    player.pause(); clearSleep(player); publishExtras()
                }
            }
        }
    }

    private fun publishExtras() { session?.setSessionExtras(Bundle().apply {
        putBoolean(AUTO_NEXT_KEY, autoNext)
        putBoolean("skipSilence", skipSilence)
        putLong("loopStart", listeningLoop?.startMs ?: -1)
        putLong("loopEnd", listeningLoop?.endMs ?: -1)
        putLong("sleepAt", sleepAt ?: 0)
        putBoolean("sleepEnd", sleepEnd)
    }) }

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

    private fun allowedController(controllerInfo: MediaSession.ControllerInfo): Boolean =
        controllerInfo.packageName == packageName || controllerInfo.isTrusted ||
            session?.isAutoCompanionController(controllerInfo) == true || session?.isAutomotiveController(controllerInfo) == true

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? =
        session.takeIf {
            (application as? VocalApplication)?.updateAdmission?.isRequired() != true &&
                allowedController(controllerInfo)
        }

    override fun onDestroy() {
        session?.run {
            player.release()
            release()
        }
        session = null
        PlaybackWidget.update(this, null, false)
        checkpoints.close()
        scope.cancel()
        super.onDestroy()
    }
}
