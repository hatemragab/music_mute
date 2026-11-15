package com.hatem.musicmute.playback

import android.os.Bundle
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaConstants
import androidx.media3.session.MediaLibraryService.LibraryParams
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionError
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.SettableFuture
import com.hatem.musicmute.VocalApplication
import com.hatem.musicmute.R
import com.hatem.musicmute.MainActivity
import com.hatem.musicmute.auth.AuthPhase
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
    private val localizedContext get() = ContextCompat.getContextForLanguage(service)
    private val rootId = "musicmute-library"
    private val recentId = "musicmute-recent"

    private fun <T> future(onFailure: (Exception) -> T, block: suspend () -> T): ListenableFuture<T> {
        val result = SettableFuture.create<T>()
        val job = scope.launch {
            try { result.set(playbackLibraryRequest(onFailure, block)) }
            catch (error: Exception) {
                if (error is CancellationException) {
                    result.cancel(false)
                    throw error
                }
                result.setException(error)
            }
        }
        job.invokeOnCompletion { if (!result.isDone) result.cancel(false) }
        result.addListener({ if (result.isCancelled) job.cancel() }, Runnable::run)
        return result
    }

    private fun accessProblem(): PlaybackLibraryProblem? = playbackLibraryAccessProblem(
        app.authSession.state.value.phase,
        app.updateCoordinator.state.value.restoring,
        app.updateAdmission.isRequired(),
    )

    private fun requireAccess() {
        accessProblem()?.let { throw PlaybackLibraryFailure(it) }
    }

    protected fun canAccessPlayback(): Boolean = accessProblem() == null

    private fun sessionError(problem: PlaybackLibraryProblem): SessionError {
        val extras = Bundle()
        if (problem != PlaybackLibraryProblem.BAD_REQUEST) {
            extras.putString(MediaConstants.EXTRAS_KEY_ERROR_RESOLUTION_ACTION_LABEL_COMPAT,
                localizedContext.getString(R.string.auto_open_phone))
            // This is a phone activity, not a distraction-optimized Car App Library intent.
            extras.putParcelable(MediaConstants.EXTRAS_KEY_ERROR_RESOLUTION_ACTION_INTENT_COMPAT,
                MainActivity.playerPendingIntent(service))
        }
        return SessionError(problem.code, localizedContext.getString(problem.messageResource), extras)
    }

    private fun errorParams(params: LibraryParams?, error: SessionError): LibraryParams = LibraryParams.Builder()
        .setRecent(params?.isRecent == true)
        .setOffline(params?.isOffline == true)
        .setSuggested(params?.isSuggested == true)
        .setExtras(Bundle(params?.extras ?: Bundle.EMPTY).apply { putAll(error.extras) })
        .build()

    private fun <T : Any> libraryFuture(
        session: MediaLibrarySession,
        browser: MediaSession.ControllerInfo,
        params: LibraryParams? = null,
        block: suspend () -> LibraryResult<T>,
    ): ListenableFuture<LibraryResult<T>> = future({ failure ->
        val error = sessionError(accessProblem() ?: playbackLibraryFailureProblem(failure))
        // Media3 1.8 replicates only selected LibraryResult codes to legacy hosts. sendError
        // also surfaces update/setup and transient failures without interrupting valid playback.
        session.sendError(browser, error)
        LibraryResult.ofError<T>(error, errorParams(params, error))
    }) {
        block().also { if (it.resultCode == LibraryResult.RESULT_SUCCESS) session.clearReplicatedLibraryError() }
    }

    private fun <T> mediaFuture(
        session: MediaSession,
        controller: MediaSession.ControllerInfo,
        block: suspend () -> T,
    ): ListenableFuture<T> = future({ failure ->
        val problem = accessProblem() ?: playbackLibraryFailureProblem(failure)
        session.sendError(controller, sessionError(problem))
        // These MediaSession callbacks cannot return LibraryResult. The failed future remains
        // required by their contract, after sending the localized resolution to the controller.
        throw PlaybackLibraryFailure(problem)
    }, block)

    protected fun reportUnavailable(session: MediaSession, controller: MediaSession.ControllerInfo): Int {
        val problem = accessProblem() ?: PlaybackLibraryProblem.UNAVAILABLE
        session.sendError(controller, sessionError(problem))
        return problem.code
    }

    private suspend fun ready(): ProcessingSession {
        app.updateCoordinator.state.first { !it.restoring }
        app.authSession.state.first { it.phase != AuthPhase.RESTORING }
        requireAccess()
        var expected = app.currentPlaybackSession()
        while (expected == null || expected.uid != app.authSession.state.value.identity?.uid) {
            delay(20)
            requireAccess()
            expected = app.currentPlaybackSession()
        }
        while (owner() != expected || !restored(expected)) { delay(20); requireCurrent(expected) }
        requireCurrent(expected)
        return expected
    }

    private fun requireCurrent(expected: ProcessingSession) {
        requireAccess()
        if (!playbackLibraryOwnerMatches(expected, app.authSession.state.value.identity?.uid, app.currentPlaybackSession()))
            throw PlaybackLibraryFailure(PlaybackLibraryProblem.UNAVAILABLE)
    }

    private suspend fun catalog(expected: ProcessingSession): List<QueueTrack> = withContext(Dispatchers.IO) {
        val result = app.processingStore.library(expected.uid).first()
            .filter { !it.hidden && it.job.status == "ready" }
            .map { QueueTrack(com.hatem.musicmute.library.LibraryKey(expected.uid, it.job.id),
                it.job.displayName ?: it.job.sourceTitle ?: localizedContext.getString(R.string.voice_track)) }
        requireCurrent(expected)
        result
    }

    private fun root(recent: Boolean = false): MediaItem = MediaItem.Builder().setMediaId(if (recent) recentId else rootId).setMediaMetadata(
        MediaMetadata.Builder().setTitle(localizedContext.getString(R.string.creative_library_tab))
            .setIsBrowsable(true).setIsPlayable(false).setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED).build(),
    ).build()

    override fun onGetLibraryRoot(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, params: LibraryParams?): ListenableFuture<LibraryResult<MediaItem>> =
        // The public root contains no account data. Return it immediately so legacy hosts can
        // connect and receive a useful access error from children instead of "cannot connect".
        Futures.immediateFuture(LibraryResult.ofItem(root(params?.isRecent == true), params))

    override fun onGetChildren(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, parentId: String,
        page: Int, pageSize: Int, params: LibraryParams?): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> = libraryFuture(session, browser, params) {
        val expected = ready()
        val offset = if (parentId == rootId || parentId == recentId) 0 else
            parentId.takeIf { it.startsWith("$rootId:") }?.substringAfterLast(':')?.toIntOrNull()
        if (offset == null || offset < 0 || page < 0 || pageSize <= 0)
            throw PlaybackLibraryFailure(PlaybackLibraryProblem.BAD_REQUEST)
        else if (parentId == recentId) {
            val recent = session.player.currentMediaItem
            val items = if (page == 0 && recent?.queueTrack()?.key?.ownerUid == expected.uid) listOf(recent) else emptyList()
            LibraryResult.ofItemList(items, params)
        } else {
            val tracks = catalog(expected)
            val window = requireNotNull(browseWindow(tracks.size, offset, page, pageSize))
            val items = tracks.drop(window.start).take(window.count).map { it.mediaItem(localizedContext) }.toMutableList()
            window.nextOffset?.let { next ->
                items.add(MediaItem.Builder().setMediaId("$rootId:$next").setMediaMetadata(
                    MediaMetadata.Builder().setTitle(localizedContext.getString(R.string.listen_more_audio))
                        .setIsBrowsable(true).setIsPlayable(false).setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED).build()).build())
            }
            requireCurrent(expected)
            LibraryResult.ofItemList(items, params)
        }
    }

    override fun onSubscribe(session: MediaLibrarySession, browser: MediaSession.ControllerInfo,
        parentId: String, params: LibraryParams?): ListenableFuture<LibraryResult<Void>> = libraryFuture(session, browser, params) {
        val expected = ready()
        if (parentId !in setOf(rootId, recentId) &&
            !(parentId.startsWith("$rootId:") && parentId.substringAfterLast(':').toIntOrNull()?.let { it >= 0 } == true))
            throw PlaybackLibraryFailure(PlaybackLibraryProblem.BAD_REQUEST)
        else {
            val count = if (parentId == recentId) if (session.player.currentMediaItem == null) 0 else 1 else catalog(expected).size
            requireCurrent(expected)
            session.notifyChildrenChanged(browser, parentId, count, params)
            LibraryResult.ofVoid()
        }
    }

    override fun onGetItem(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, mediaId: String): ListenableFuture<LibraryResult<MediaItem>> = libraryFuture(session, browser) {
        val expected = ready()
        val folderOffset = mediaId.takeIf { it.startsWith("$rootId:") }?.substringAfterLast(':')?.toIntOrNull()
        val item = when {
            mediaId == rootId -> root()
            mediaId == recentId -> root(true)
            folderOffset != null && folderOffset >= 0 -> root().buildUpon().setMediaId(mediaId).build()
            else -> catalog(expected).firstOrNull { "processing:${it.key.jobId}" == mediaId }?.mediaItem(localizedContext)
        }
        requireCurrent(expected)
        if (item == null) throw PlaybackLibraryFailure(PlaybackLibraryProblem.BAD_REQUEST) else LibraryResult.ofItem(item, null)
    }

    override fun onAddMediaItems(session: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: List<MediaItem>): ListenableFuture<List<MediaItem>> = mediaFuture(session, controller) {
        val expected = ready()
        require(mediaItems.size <= 1000)
        val items = if (controller.packageName == service.packageName) {
            mediaItems.map { item ->
                val track = requireNotNull(item.queueTrack())
                require(track.key.ownerUid == expected.uid)
                track.mediaItem(localizedContext)
            }
        } else {
            val tracks = catalog(expected).associateBy { "processing:${it.key.jobId}" }
            mediaItems.flatMap { item ->
                val query = item.requestMetadata.searchQuery
                if (query != null) tracks.values.filter { query.isBlank() || it.title.contains(query.take(200), ignoreCase = true) }
                    .take(100).map { it.mediaItem(localizedContext) }
                else listOf(requireNotNull(tracks[item.mediaId]).mediaItem(localizedContext))
            }.take(1000)
        }
        requireCurrent(expected)
        items
    }

    override fun onSearch(session: MediaLibrarySession, browser: MediaSession.ControllerInfo,
        query: String, params: LibraryParams?): ListenableFuture<LibraryResult<Void>> = libraryFuture(session, browser, params) {
        val expected = ready()
        if (query.length > 200) throw PlaybackLibraryFailure(PlaybackLibraryProblem.BAD_REQUEST)
        else {
            val count = catalog(expected).count { it.title.contains(query, ignoreCase = true) }
            requireCurrent(expected)
            session.notifySearchResultChanged(browser, query, count, params)
            LibraryResult.ofVoid()
        }
    }

    override fun onGetSearchResult(session: MediaLibrarySession, browser: MediaSession.ControllerInfo,
        query: String, page: Int, pageSize: Int, params: LibraryParams?): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> = libraryFuture(session, browser, params) {
        val expected = ready()
        if (query.length > 200 || page < 0 || pageSize <= 0) throw PlaybackLibraryFailure(PlaybackLibraryProblem.BAD_REQUEST)
        else {
            val tracks = catalog(expected).filter { it.title.contains(query, ignoreCase = true) }
            val start = page.toLong() * pageSize
            val items = if (start >= tracks.size) emptyList() else tracks.drop(start.toInt()).take(minOf(pageSize, 200)).map { it.mediaItem(localizedContext) }
            requireCurrent(expected)
            LibraryResult.ofItemList(items, params)
        }
    }

    override fun onPlaybackResumption(session: MediaSession, controller: MediaSession.ControllerInfo): ListenableFuture<MediaSession.MediaItemsWithStartPosition> = mediaFuture(session, controller) {
        val expected = ready()
        val player = session.player
        val items = (0 until player.mediaItemCount).map { player.getMediaItemAt(it) }
        require(items.isNotEmpty() && items.all { it.queueTrack()?.key?.ownerUid == expected.uid })
        requireCurrent(expected)
        MediaSession.MediaItemsWithStartPosition(items, player.currentMediaItemIndex.coerceAtLeast(0), player.currentPosition.coerceAtLeast(0))
    }
}
