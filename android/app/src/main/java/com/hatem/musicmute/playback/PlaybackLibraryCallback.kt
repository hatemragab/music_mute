package com.hatem.musicmute.playback

import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService.LibraryParams
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionError
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import com.hatem.musicmute.VocalApplication
import com.hatem.musicmute.R
import com.hatem.musicmute.processing.ProcessingSession
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
internal open class PlaybackLibraryCallback(
    private val service: AudioPlaybackService,
    private val scope: CoroutineScope,
    private val owner: () -> ProcessingSession?,
    private val restored: (ProcessingSession) -> Boolean,
) : MediaLibrarySession.Callback {
    private val app get() = service.application as VocalApplication
    private val rootId = "musicmute-library"
    private val recentId = "musicmute-recent"

    private fun <T> future(block: suspend () -> T): ListenableFuture<T> {
        val result = SettableFuture.create<T>()
        val job = scope.launch {
            try { result.set(block()) }
            catch (error: Exception) { result.setException(error) }
        }
        result.addListener({ if (result.isCancelled) job.cancel() }, Runnable::run)
        return result
    }

    private suspend fun ready(): ProcessingSession = withTimeout(5000) {
        app.updateCoordinator.state.first { !it.restoring }
        check(!app.updateAdmission.isBlocked()) { "Update required" }
        val expected = app.playbackSessions.first { it != null }!!
        while (owner() != expected || !restored(expected)) { delay(20); requireCurrent(expected) }
        requireCurrent(expected)
        expected
    }

    private fun requireCurrent(expected: ProcessingSession) {
        check(app.currentPlaybackSession() == expected && !app.updateAdmission.isBlocked()) { "Playback unavailable" }
    }

    private suspend fun catalog(expected: ProcessingSession): List<QueueTrack> = withContext(Dispatchers.IO) {
        val result = app.processingStore.library(expected.uid).first()
            .filter { !it.hidden && it.job.status == "ready" }
            .map { QueueTrack(com.hatem.musicmute.library.LibraryKey(expected.uid, it.job.id),
                it.job.displayName ?: it.job.sourceTitle ?: service.getString(R.string.voice_track)) }
        requireCurrent(expected)
        result
    }

    private fun root(recent: Boolean = false): MediaItem = MediaItem.Builder().setMediaId(if (recent) recentId else rootId).setMediaMetadata(
        MediaMetadata.Builder().setTitle(service.getString(R.string.creative_library_tab))
            .setIsBrowsable(true).setIsPlayable(false).setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED).build(),
    ).build()

    override fun onGetLibraryRoot(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, params: LibraryParams?): ListenableFuture<LibraryResult<MediaItem>> =
        future { ready(); LibraryResult.ofItem(root(params?.isRecent == true), params) }

    override fun onGetChildren(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, parentId: String,
        page: Int, pageSize: Int, params: LibraryParams?): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> = future {
        val expected = ready()
        val offset = if (parentId == rootId || parentId == recentId) 0 else
            parentId.takeIf { it.startsWith("$rootId:") }?.substringAfterLast(':')?.toIntOrNull()
        if (offset == null || offset < 0 || page < 0 || pageSize <= 0)
            LibraryResult.ofError(SessionError.ERROR_BAD_VALUE)
        else if (parentId == recentId) {
            val recent = session.player.currentMediaItem
            val items = if (page == 0 && recent?.queueTrack()?.key?.ownerUid == expected.uid) listOf(recent) else emptyList()
            LibraryResult.ofItemList(items, params)
        } else {
            val tracks = catalog(expected)
            val window = requireNotNull(browseWindow(tracks.size, offset, page, pageSize))
            val items = tracks.drop(window.start).take(window.count).map { it.mediaItem(service) }.toMutableList()
            window.nextOffset?.let { next ->
                items.add(MediaItem.Builder().setMediaId("$rootId:$next").setMediaMetadata(
                    MediaMetadata.Builder().setTitle(service.getString(R.string.listen_more_audio))
                        .setIsBrowsable(true).setIsPlayable(false).setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED).build()).build())
            }
            requireCurrent(expected)
            LibraryResult.ofItemList(items, params)
        }
    }

    override fun onSubscribe(session: MediaLibrarySession, browser: MediaSession.ControllerInfo,
        parentId: String, params: LibraryParams?): ListenableFuture<LibraryResult<Void>> = future {
        val expected = ready()
        if (parentId !in setOf(rootId, recentId) &&
            !(parentId.startsWith("$rootId:") && parentId.substringAfterLast(':').toIntOrNull()?.let { it >= 0 } == true))
            LibraryResult.ofError(SessionError.ERROR_BAD_VALUE)
        else {
            val count = if (parentId == recentId) if (session.player.currentMediaItem == null) 0 else 1 else catalog(expected).size
            requireCurrent(expected)
            session.notifyChildrenChanged(browser, parentId, count, params)
            LibraryResult.ofVoid()
        }
    }

    override fun onGetItem(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, mediaId: String): ListenableFuture<LibraryResult<MediaItem>> = future {
        val expected = ready()
        val folderOffset = mediaId.takeIf { it.startsWith("$rootId:") }?.substringAfterLast(':')?.toIntOrNull()
        val item = when {
            mediaId == rootId -> root()
            mediaId == recentId -> root(true)
            folderOffset != null && folderOffset >= 0 -> root().buildUpon().setMediaId(mediaId).build()
            else -> catalog(expected).firstOrNull { "processing:${it.key.jobId}" == mediaId }?.mediaItem(service)
        }
        requireCurrent(expected)
        if (item == null) LibraryResult.ofError(SessionError.ERROR_BAD_VALUE) else LibraryResult.ofItem(item, null)
    }

    override fun onAddMediaItems(session: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: List<MediaItem>): ListenableFuture<List<MediaItem>> = future {
        val expected = ready()
        require(mediaItems.size <= 1000)
        val items = if (controller.packageName == service.packageName) {
            mediaItems.map { item ->
                val track = requireNotNull(item.queueTrack())
                require(track.key.ownerUid == expected.uid)
                track.mediaItem(service)
            }
        } else {
            val tracks = catalog(expected).associateBy { "processing:${it.key.jobId}" }
            mediaItems.flatMap { item ->
                val query = item.requestMetadata.searchQuery
                if (query != null) tracks.values.filter { query.isBlank() || it.title.contains(query.take(200), ignoreCase = true) }
                    .take(100).map { it.mediaItem(service) }
                else listOf(requireNotNull(tracks[item.mediaId]).mediaItem(service))
            }.take(1000)
        }
        requireCurrent(expected)
        items
    }

    override fun onSearch(session: MediaLibrarySession, browser: MediaSession.ControllerInfo,
        query: String, params: LibraryParams?): ListenableFuture<LibraryResult<Void>> = future {
        val expected = ready()
        if (query.length > 200) LibraryResult.ofError(SessionError.ERROR_BAD_VALUE)
        else {
            val count = catalog(expected).count { it.title.contains(query, ignoreCase = true) }
            requireCurrent(expected)
            session.notifySearchResultChanged(browser, query, count, params)
            LibraryResult.ofVoid()
        }
    }

    override fun onGetSearchResult(session: MediaLibrarySession, browser: MediaSession.ControllerInfo,
        query: String, page: Int, pageSize: Int, params: LibraryParams?): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> = future {
        val expected = ready()
        if (query.length > 200 || page < 0 || pageSize <= 0) LibraryResult.ofError(SessionError.ERROR_BAD_VALUE)
        else {
            val tracks = catalog(expected).filter { it.title.contains(query, ignoreCase = true) }
            val start = page.toLong() * pageSize
            val items = if (start >= tracks.size) emptyList() else tracks.drop(start.toInt()).take(minOf(pageSize, 200)).map { it.mediaItem(service) }
            requireCurrent(expected)
            LibraryResult.ofItemList(items, params)
        }
    }

    override fun onPlaybackResumption(session: MediaSession, controller: MediaSession.ControllerInfo): ListenableFuture<MediaSession.MediaItemsWithStartPosition> = future {
        val expected = ready()
        val player = session.player
        val items = (0 until player.mediaItemCount).map { player.getMediaItemAt(it) }
        require(items.isNotEmpty() && items.all { it.queueTrack()?.key?.ownerUid == expected.uid })
        requireCurrent(expected)
        MediaSession.MediaItemsWithStartPosition(items, player.currentMediaItemIndex.coerceAtLeast(0), player.currentPosition.coerceAtLeast(0))
    }
}
