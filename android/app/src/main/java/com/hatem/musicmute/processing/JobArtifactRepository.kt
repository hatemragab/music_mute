package com.hatem.musicmute.processing

import android.media.MediaCodecList
import android.media.MediaExtractor
import android.media.MediaFormat
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job as CoroutineJob
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Job identifiers are validated before using this key; raw owner names never enter paths. */
fun outputCacheKey(uid: String, jobId: String): String = MessageDigest.getInstance("SHA-256")
    .digest("$uid:$jobId".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

data class ArtifactProgress(val bytes: Long, val totalBytes: Long?)
enum class ArtifactProblem { NOT_READY, INVALID_OUTPUT, TRANSFER, STORAGE, EXPIRED_GRANT }
class ArtifactException(val problem: ArtifactProblem) : IOException(problem.name)

/** Construct with an application noBackupFilesDir child. No work starts until an explicit request. */
class JobArtifactRepository(
    private val root: File,
    private val api: JobsApi,
    private val sessionProvider: () -> ProcessingSession?,
    private val downloader: ArtifactDownloader = UrlConnectionArtifactDownloader(),
    private val isPlayableMp3: (File) -> Boolean = ::isPlayableProcessingMp3,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    private val now: () -> Instant = Instant::now,
) {
    private val downloads = CoroutineScope(scope.coroutineContext + SupervisorJob(scope.coroutineContext[CoroutineJob]))
    private data class Request(val session: ProcessingSession, val jobId: String, val revision: Long)
    private val lock = Any()
    private var revision = 0L
    private val requests = mutableMapOf<Request, Deferred<File>>()
    private val deleted = mutableSetOf<String>()
    private val mutableProgress = MutableStateFlow<Map<String, ArtifactProgress>>(emptyMap())
    val progress: StateFlow<Map<String, ArtifactProgress>> = mutableProgress.asStateFlow()

    suspend fun ensureOutput(jobId: String): File {
        if (!jobId.matches(Regex("[a-fA-F0-9]{24}"))) throw JobsFailure(JobsProblem.INVALID_INPUT)
        val (request, task) = synchronized(lock) {
            val session = sessionProvider()?.takeIf { it.uid.isNotBlank() }
                ?: throw JobsFailure(JobsProblem.UNAUTHENTICATED)
            if (cacheIdentity(session.uid, jobId) in deleted)
                throw ArtifactException(ArtifactProblem.NOT_READY)
            val request = Request(session, jobId.lowercase(java.util.Locale.ROOT), revision)
            val task = requests[request] ?: downloads.async(start = CoroutineStart.LAZY) {
                try { fetch(request) }
                finally {
                    synchronized(lock) {
                        requests.remove(request)
                        if (current(request)) mutableProgress.value = mutableProgress.value - request.jobId
                    }
                }
            }.also { requests[request] = it }
            request to task
        }
        task.start()
        return task.await().also {
            // A caller resuming after an account switch may not open the old file.
            currentCoroutineContext().ensureActive()
            requireCurrent(request)
        }
    }

    /** Called immediately on sign-out/account change; retained cache files remain untouched. */
    fun onSessionChanged() {
        val pending = synchronized(lock) {
            revision++
            mutableProgress.value = emptyMap()
            requests.values.toList()
        }
        pending.forEach { it.cancel(CancellationException("Processing session changed")) }
    }

    suspend fun purgeOwner(uid: String) {
        val pending = synchronized(lock) {
            val owned = requests.filterKeys { it.session.uid == uid }
            if (sessionProvider()?.uid == uid) mutableProgress.value = emptyMap()
            owned.values.toList()
        }
        // Requests stay tracked until their file-writing coroutine has actually terminated.
        pending.forEach { it.cancel(); it.join() }
        val directory = processingOwnerDirectory(root, uid)
        if (directory.exists() && !directory.deleteRecursively()) throw ArtifactException(ArtifactProblem.STORAGE)
    }

    suspend fun evict(jobId: String) {
        if (!jobId.matches(Regex("[a-fA-F0-9]{24}"))) throw JobsFailure(JobsProblem.INVALID_INPUT)
        val session = sessionProvider() ?: throw JobsFailure(JobsProblem.UNAUTHENTICATED)
        val normalized = jobId.lowercase(java.util.Locale.ROOT)
        val identity = cacheIdentity(session.uid, normalized)
        val cancelled = synchronized(lock) {
            deleted += identity
            mutableProgress.value = mutableProgress.value - normalized
            requests.filterKeys { it.session == session && it.jobId == normalized }.values.toList().also {
                requests.keys.removeAll { request -> request.session == session && request.jobId == normalized }
            }
        }
        cancelled.forEach { it.cancel(CancellationException("Processing output deleted")) }
        val destination = File(
            File(processingOwnerDirectory(root, session.uid), "outputs"),
            "${outputCacheKey(session.uid, normalized)}.mp3",
        )
        if (destination.isFile && !destination.delete()) throw ArtifactException(ArtifactProblem.STORAGE)
        destination.parentFile?.listFiles()?.filter {
            it.name.startsWith(destination.name + ".") && it.name.endsWith(".partial")
        }?.forEach { it.delete() }
    }

    private fun current(request: Request): Boolean =
        revision == request.revision && sessionProvider() == request.session &&
            cacheIdentity(request.session.uid, request.jobId) !in deleted

    private fun requireCurrent(request: Request) = synchronized(lock) {
        if (!current(request)) throw CancellationException("Processing session changed")
    }

    private fun valid(file: File): Boolean = file.isFile && file.length() > 0 &&
        runCatching { isPlayableMp3(file) }.getOrDefault(false)

    private suspend fun fetch(request: Request): File {
        requireCurrent(request)
        val directory = File(processingOwnerDirectory(root, request.session.uid), "outputs")
        val destination = File(directory, "${outputCacheKey(request.session.uid, request.jobId)}.mp3")
        val partial = File(directory, "${destination.name}.${UUID.randomUUID()}.partial")
        try {
            if (!destination.canonicalPath.startsWith(root.canonicalPath + File.separator))
                throw ArtifactException(ArtifactProblem.STORAGE)
            if (valid(destination)) {
                requireCurrent(request)
                return destination
            }
            if (!directory.isDirectory && !directory.mkdirs()) throw ArtifactException(ArtifactProblem.STORAGE)
            var grant = readyGrant(request)
            for (attempt in 0..1) {
                requireCurrent(request)
                if (!grant.expiresAt.isAfter(now())) {
                    if (attempt == 1) throw ArtifactException(ArtifactProblem.EXPIRED_GRANT)
                    grant = readyGrant(request)
                    continue
                }
                try {
                    downloader.download(grant.url, partial) { bytes, total ->
                        synchronized(lock) {
                            if (current(request)) mutableProgress.value = mutableProgress.value +
                                (request.jobId to ArtifactProgress(bytes, total))
                        }
                    }
                } catch (error: ArtifactHttpException) {
                    requireCurrent(request)
                    // Only a genuinely expired grant is renewable; an arbitrary 403 is not.
                    if (attempt == 0 && error.status == 403 && !grant.expiresAt.isAfter(now())) {
                        partial.delete()
                        grant = readyGrant(request)
                        continue
                    }
                    throw ArtifactException(ArtifactProblem.TRANSFER)
                }
                currentCoroutineContext().ensureActive()
                requireCurrent(request)
                if (!valid(partial)) throw ArtifactException(ArtifactProblem.INVALID_OUTPUT)
                return synchronized(lock) {
                    requireCurrent(request)
                    // Never replace a valid cache created while this attempt was in flight.
                    if (!valid(destination)) {
                        try {
                            Files.move(partial.toPath(), destination.toPath(),
                                StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
                        } catch (_: IOException) { throw ArtifactException(ArtifactProblem.STORAGE) }
                    }
                    destination
                }
            }
            throw ArtifactException(ArtifactProblem.EXPIRED_GRANT)
        } catch (error: CancellationException) {
            throw error
        } catch (error: JobsFailure) {
            throw error
        } catch (error: ArtifactException) {
            throw error
        } catch (_: Exception) {
            throw ArtifactException(ArtifactProblem.TRANSFER)
        } finally {
            // This random attempt-owned partial is the only file eligible for cleanup.
            partial.delete()
        }
    }

    private suspend fun readyGrant(request: Request): DownloadGrant {
        requireCurrent(request)
        val job = api.detail(request.jobId)
        requireCurrent(request)
        if (job.id != request.jobId || job.status != "ready" || !job.canDownloadOutput)
            throw ArtifactException(ArtifactProblem.NOT_READY)
        return api.download(request.jobId, "output").also { requireCurrent(request) }
    }
}

private fun cacheIdentity(uid: String, jobId: String) = "$uid:$jobId"

/** Require an actual MP3 audio track, a platform decoder and readable sample data. */
internal fun isPlayableProcessingMp3(file: File): Boolean {
    if (!file.isFile || file.length() <= 0 || sniffProcessingContainer(file) != "audio/mpeg") return false
    val extractor = MediaExtractor()
    return try {
        extractor.setDataSource(file.absolutePath)
        var audioTrack = -1
        for (index in 0 until extractor.trackCount) {
            val format = extractor.getTrackFormat(index)
            val mime = format.getString(MediaFormat.KEY_MIME).orEmpty()
            if (mime.startsWith("video/")) return false
            if (mime.startsWith("audio/")) {
                if (mime != "audio/mpeg" || !format.containsKey(MediaFormat.KEY_DURATION) ||
                    format.getLong(MediaFormat.KEY_DURATION) <= 0 ||
                    MediaCodecList(MediaCodecList.REGULAR_CODECS).findDecoderForFormat(format) == null) return false
                audioTrack = index
            }
        }
        if (audioTrack < 0) false else {
            extractor.selectTrack(audioTrack)
            extractor.readSampleData(ByteBuffer.allocate(64 * 1024), 0) > 0
        }
    } catch (_: Exception) { false }
    finally { extractor.release() }
}
