package com.hatem.musicmute.playback

import com.hatem.musicmute.library.LibraryKey
import com.hatem.musicmute.processing.ArtifactException
import com.hatem.musicmute.processing.ArtifactProblem
import com.hatem.musicmute.processing.ClientErrorCode
import com.hatem.musicmute.processing.JobsFailure
import com.hatem.musicmute.processing.JobsProblem
import com.hatem.musicmute.processing.ProcessingSession
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import kotlin.random.Random
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

enum class RepeatMode { OFF, ALL, ONE }

/** Main-thread restore gate: initial auth attachment is as significant as a later owner switch. */
internal class OwnerQueueRestore {
    private var attached: ProcessingSession? = null
    private var ready = false
    fun attach(owner: ProcessingSession?): Boolean {
        if (attached == owner) return false
        attached = owner
        ready = false
        return true
    }
    fun restored(owner: ProcessingSession) {
        if (attached == owner) ready = true
    }
    fun canCheckpoint(owner: ProcessingSession?): Boolean = owner != null && attached == owner && ready
}
data class QueueTrack(val key: LibraryKey, val title: String)

enum class PlaybackFailureSource { JOB_API, ARTIFACT, LOCAL_IO, PLAYER }

data class PlaybackFailureDiagnostic(
    val source: PlaybackFailureSource,
    val code: ClientErrorCode,
    val retryable: Boolean,
    val causeType: String,
)

internal fun classifyPlaybackFailure(error: Throwable): PlaybackFailureDiagnostic {
    val causes = generateSequence(error) { it.cause }.take(16).toList()
    causes.filterIsInstance<JobsFailure>().firstOrNull()?.let { failure ->
        val (code, retryable) = when (failure.problem) {
            JobsProblem.OFFLINE -> ClientErrorCode.NETWORK to true
            JobsProblem.UNAUTHENTICATED,
            JobsProblem.ACCOUNT_DISABLED,
            JobsProblem.EMAIL_VERIFICATION_REQUIRED,
            JobsProblem.PROFILE_SYNC_REQUIRED,
            JobsProblem.DEVICE_SYNC_REQUIRED,
            JobsProblem.DEVICE_REPORT_CONFLICT,
            JobsProblem.APP_UPDATE_REQUIRED,
            JobsProblem.POLICY_DENIED -> ClientErrorCode.AUTHENTICATION to false
            JobsProblem.JOB_NOT_FOUND -> ClientErrorCode.JOB_NOT_FOUND to false
            JobsProblem.JOB_STATE_CONFLICT,
            JobsProblem.IDEMPOTENCY_CONFLICT,
            JobsProblem.NEW_INPUT_REQUIRED -> ClientErrorCode.JOB_CONFLICT to false
            JobsProblem.SERVICE_UNAVAILABLE,
            JobsProblem.RATE_LIMITED,
            JobsProblem.PROCESSING_CAPACITY_UNAVAILABLE -> ClientErrorCode.SERVER to true
            else -> ClientErrorCode.SERVER to false
        }
        return PlaybackFailureDiagnostic(
            PlaybackFailureSource.JOB_API,
            code,
            retryable,
            failure::class.java.simpleName,
        )
    }
    causes.filterIsInstance<ArtifactException>().firstOrNull()?.let { failure ->
        val (code, retryable) = when (failure.problem) {
            ArtifactProblem.NOT_READY,
            ArtifactProblem.EXPIRED_GRANT -> ClientErrorCode.SOURCE_UNAVAILABLE to true
            ArtifactProblem.INVALID_OUTPUT -> ClientErrorCode.INVALID_MEDIA to false
            ArtifactProblem.TRANSFER -> ClientErrorCode.NETWORK to true
            ArtifactProblem.STORAGE -> ClientErrorCode.STORAGE to false
        }
        return PlaybackFailureDiagnostic(
            PlaybackFailureSource.ARTIFACT,
            code,
            retryable,
            failure::class.java.simpleName,
        )
    }
    val cause = causes.lastOrNull() ?: error
    return PlaybackFailureDiagnostic(
        if (cause is IOException) PlaybackFailureSource.LOCAL_IO else PlaybackFailureSource.PLAYER,
        if (cause is IOException) ClientErrorCode.LOCAL_IO else ClientErrorCode.UNKNOWN,
        false,
        cause::class.java.simpleName,
    )
}

interface QueueCommands {
    fun playQueue(tracks: List<QueueTrack>, startKey: LibraryKey)
    fun next()
    fun previous()
    fun setShuffle(enabled: Boolean)
    fun setRepeat(mode: RepeatMode)
    fun setAutoNext(enabled: Boolean)
}

/** Application-owned dependencies; resolution must return a completely validated private file. */
interface PlaybackDependencies {
    fun currentPlaybackSession(): ProcessingSession?
    val playbackSessions: StateFlow<ProcessingSession?>
    val playbackQueueStore: PlaybackQueueStore
    suspend fun resolvePlaybackFile(key: LibraryKey): File
    suspend fun reportPlaybackFailure(key: LibraryKey, diagnostic: PlaybackFailureDiagnostic) {}
}

/** Fence both sides of a possibly long transfer, including same-user sign-out/sign-in epochs. */
suspend fun resolveQueueFile(
    key: LibraryKey,
    expected: ProcessingSession,
    current: () -> ProcessingSession?,
    acquire: suspend (LibraryKey) -> File,
): File {
    if (key.ownerUid != expected.uid || current() != expected) throw IOException("Playback account changed")
    val file = acquire(key)
    if (current() != expected || !file.isFile || file.length() == 0L) throw IOException("Audio unavailable")
    return file
}

data class QueueSnapshot(
    val tracks: List<QueueTrack>,
    val index: Int = 0,
    val positionMs: Long = 0,
    val repeat: RepeatMode = RepeatMode.OFF,
    val shuffle: Boolean = false,
    val autoNext: Boolean = true,
    val shuffleSeed: Long = 0,
    val order: List<Int> = emptyList(),
)

fun queueNextIndex(index: Int, size: Int, repeat: RepeatMode, autoNext: Boolean, manual: Boolean = false): Int {
    if (size == 0 || index !in 0 until size) return -1
    if (!manual && repeat == RepeatMode.ONE) return index
    if (!manual && !autoNext) return -1
    return if (index + 1 < size) index + 1 else if (repeat == RepeatMode.ALL) 0 else -1
}
fun queuePreviousIndex(index: Int, positionMs: Long): Int =
    if (positionMs > 3000) index else (index - 1).coerceAtLeast(0)

/** A finite preview of the service's real traversal order, including loop precedence. */
fun upcomingTracks(order: List<QueueTrack>, current: LibraryKey?, repeat: RepeatMode,
    autoNext: Boolean, limit: Int = 2): List<QueueTrack> {
    val index = order.indexOfFirst { it.key == current }
    if (index < 0 || limit <= 0) return emptyList()
    if (repeat == RepeatMode.ONE) return listOf(order[index])
    if (!autoNext) return emptyList()
    return (order.drop(index + 1) + if (repeat == RepeatMode.ALL) order.take(index + 1) else emptyList()).take(limit)
}

fun queueOrder(size: Int, shuffle: Boolean, seed: Long, current: Int): List<Int> {
    val all = (0 until size).toList()
    return if (!shuffle || current !in all) all
    else listOf(current) + all.filter { it != current }.shuffled(Random(seed))
}

fun unavailableCandidates(index: Int, order: List<Int>, repeat: RepeatMode): List<Int> {
    if (repeat == RepeatMode.ONE) return emptyList()
    val at = order.indexOf(index)
    if (at < 0) return emptyList()
    return order.drop(at + 1) + if (repeat == RepeatMode.ALL) order.take(at) else emptyList()
}

@Serializable private data class StoredQueueTrack(val jobId: String, val title: String)
@Serializable private data class StoredQueue(
    val tracks: List<StoredQueueTrack>, val index: Int, val positionMs: Long,
    val repeat: String, val shuffle: Boolean, val autoNext: Boolean, val shuffleSeed: Long,
    val order: List<Int> = emptyList(),
)

/** Small atomic owner-scoped checkpoint, containing identities only, never signed URLs. Call on IO. */
class PlaybackQueueStore(private val root: File) {
    private val json = Json { ignoreUnknownKeys = true }
    private fun file(uid: String): File {
        require(uid.isNotBlank())
        val hash = MessageDigest.getInstance("SHA-256").digest(uid.toByteArray()).joinToString("") { "%02x".format(it) }
        return File(root, "$hash.json")
    }
    @Synchronized fun save(uid: String, snapshot: QueueSnapshot, isCurrent: () -> Boolean = { true }) {
        if (!isCurrent()) return
        if (snapshot.tracks.any { it.key.ownerUid != uid || it.key.jobId.isBlank() }) return
        root.mkdirs()
        val target = file(uid)
        val temp = File(root, "${target.name}.tmp")
        val stored = StoredQueue(snapshot.tracks.map { StoredQueueTrack(it.key.jobId, it.title) },
            snapshot.index.coerceIn(0, (snapshot.tracks.size - 1).coerceAtLeast(0)), snapshot.positionMs.coerceAtLeast(0),
            snapshot.repeat.name, snapshot.shuffle, snapshot.autoNext, snapshot.shuffleSeed, snapshot.order)
        temp.outputStream().use { out -> out.write(json.encodeToString(stored).toByteArray()); out.fd.sync() }
        check(temp.renameTo(target)) { "Unable to checkpoint playback" }
    }
    @Synchronized fun load(uid: String): QueueSnapshot? = try {
        val stored = json.decodeFromString<StoredQueue>(file(uid).readText())
        QueueSnapshot(stored.tracks.map { QueueTrack(LibraryKey(uid, it.jobId), it.title) },
            stored.index.coerceIn(0, (stored.tracks.size - 1).coerceAtLeast(0)), stored.positionMs.coerceAtLeast(0),
            RepeatMode.entries.firstOrNull { it.name == stored.repeat } ?: RepeatMode.OFF,
            stored.shuffle, stored.autoNext, stored.shuffleSeed, stored.order)
    } catch (_: Exception) { null }
    @Synchronized fun clear(uid: String) { file(uid).delete(); File(root, "${file(uid).name}.tmp").delete() }
}
