package com.hatem.musicmute.processing

import java.io.File
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

enum class InputPreparationError { UNSUPPORTED, INVALID_AUDIO, TOO_LARGE, TOO_LONG, STORAGE, NO_AUDIO, DEFAULT_TRACK_UNAVAILABLE, DURATION_UNKNOWN, PREPARATION_TIMEOUT }

class InputPreparationException(val reason: InputPreparationError) : IOException(reason.name)

data class AudioInspection(
    val durationSeconds: Double,
    val hasAudio: Boolean,
    val hasVideo: Boolean,
    val contentType: String,
)

data class PreparedInput(
    val operationId: String,
    val ownerUid: String,
    val file: File,
    val declaration: InputDeclaration,
    val displayName: String,
    val mediaPolicy: ProcessingMediaPolicy = ProcessingMediaPolicy.LEGACY,
    val mediaSource: String = "audio_file",
)

fun validProcessingInput(bytes: Long, durationSeconds: Double): Boolean =
    bytes in 1..29_999_999 && durationSeconds.isFinite() && durationSeconds > 0 && durationSeconds < 600

fun processingOwnerDirectory(root: File, uid: String): File {
    require(uid.isNotBlank())
    val digest = MessageDigest.getInstance("SHA-256").digest(uid.toByteArray(Charsets.UTF_8))
    val name = digest.joinToString("") { "%02x".format(it) }
    return File(root, name)
}

fun processingContentType(extension: String): String? = when (extension) {
    "m4a", "mp4" -> "audio/mp4"
    "webm" -> "audio/webm"
    "opus", "ogg" -> "audio/ogg"
    "aac" -> "audio/aac"
    "mp3" -> "audio/mpeg"
    else -> null
}

/** Copies once into operation-owned storage; upload retries always read these exact bytes. */
class AudioInputPreparer(
    private val root: File,
    private val maxBytes: Long = 30_000_000,
    private val validateDecoded: suspend (File, ProcessingMediaPolicy) -> Unit = { _, _ -> },
    private val inspect: (File) -> AudioInspection,
) {
    suspend fun prepare(
        ownerUid: String,
        displayName: String,
        operationId: String = UUID.randomUUID().toString(),
        policy: ProcessingMediaPolicy = ProcessingMediaPolicy.LEGACY,
        mediaSource: String = "audio_file",
        open: () -> InputStream,
    ): PreparedInput =
        withContext(Dispatchers.IO) {
            val extension = displayName.substringAfterLast('.', "").lowercase(java.util.Locale.ROOT)
            val contentType = processingContentType(extension)
                ?: throw InputPreparationException(InputPreparationError.UNSUPPORTED)
            require(UUID.fromString(operationId).toString() == operationId)
            val directory = File(processingOwnerDirectory(root, ownerUid), operationId)
            val deadline = System.nanoTime() + (policy.maxPreparationSeconds ?: 120).coerceAtMost(3600) * 1_000_000_000
            withPreparationLock(directory.absolutePath) {
                val file = File(directory, "input.$extension")
                val pending = File(directory, ".input.pending.$extension")
                val marker = File(directory, "input.json")
                val markerPending = File(directory, ".input.json.pending")
                var ownsPending = false
                var publishedMarker = false
                try {
                    if (!directory.isDirectory && !directory.mkdirs()) throw IOException("Could not create staging directory")
                    if (marker.isFile) {
                        if (marker.length() > 4096) throw IOException("Invalid staging metadata")
                        val declaration = Json.decodeFromString<InputDeclaration>(marker.readText())
                        if (declaration.extension != extension || declaration.contentType != contentType ||
                            !policy.acceptsPrepared(declaration.bytes, declaration.durationSeconds))
                            throw IOException("Staging metadata mismatch")
                        val committed = if (file.isFile) file else pending
                        if (!committed.isFile || committed.length() != declaration.bytes || sha256(committed) != declaration.sha256)
                            throw IOException("Staged input changed")
                        currentCoroutineContext().ensureActive()
                        if (committed == pending) Files.move(pending.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE)
                        return@withPreparationLock PreparedInput(operationId, ownerUid, file, declaration, displayName, policy, mediaSource)
                    }
                    // Older/uncommitted input may belong to another operation path.
                    // Never adopt or delete it merely because mkdirs returned false.
                    if (file.exists()) throw IOException("Existing input has no completion record")
                    if (directory.usableSpace < policy.maxPreparedAudioBytes + 16 * 1024 * 1024)
                        throw InputPreparationException(InputPreparationError.STORAGE)
                    ownsPending = true
                    val digest = MessageDigest.getInstance("SHA-256")
                    var bytes = 0L
                    open().use { source ->
                        pending.outputStream().use { destination ->
                            val buffer = ByteArray(64 * 1024)
                            while (true) {
                                currentCoroutineContext().ensureActive()
                                if (System.nanoTime() >= deadline) throw InputPreparationException(InputPreparationError.PREPARATION_TIMEOUT)
                                val count = source.read(buffer)
                                if (count < 0) break
                                if (count == 0) continue
                                bytes += count
                                if (if (policy.version == 1) bytes >= minOf(maxBytes, policy.maxPreparedAudioBytes) else bytes > policy.maxPreparedAudioBytes) throw InputPreparationException(InputPreparationError.TOO_LARGE)
                                digest.update(buffer, 0, count)
                                destination.write(buffer, 0, count)
                            }
                            destination.fd.sync()
                        }
                    }
                    if (bytes == 0L) throw InputPreparationException(InputPreparationError.INVALID_AUDIO)
                    val media = inspect(pending)
                    currentCoroutineContext().ensureActive()
                    if (!media.hasAudio || media.hasVideo || media.contentType != contentType ||
                        !media.durationSeconds.isFinite() || media.durationSeconds <= 0
                    ) throw InputPreparationException(InputPreparationError.INVALID_AUDIO)
                    if (!policy.acceptsDuration(media.durationSeconds)) throw InputPreparationException(InputPreparationError.TOO_LONG)
                    validateDecoded(pending, policy)
                    currentCoroutineContext().ensureActive()
                    val declaration = InputDeclaration(extension, contentType, bytes, media.durationSeconds,
                        Base64.getEncoder().encodeToString(digest.digest()))
                    markerPending.outputStream().use {
                        it.write(Json.encodeToString(declaration).toByteArray(Charsets.UTF_8))
                        it.fd.sync()
                    }
                    // Marker first: after a crash, its checksum safely identifies
                    // the validated pending file for the final atomic rename.
                    Files.move(markerPending.toPath(), marker.toPath(), StandardCopyOption.ATOMIC_MOVE)
                    publishedMarker = true
                    Files.move(pending.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE)
                    PreparedInput(operationId, ownerUid, file, declaration, displayName, policy, mediaSource)
                } catch (error: Exception) {
                    if (ownsPending && !publishedMarker) {
                        pending.delete()
                        markerPending.delete()
                    }
                    when (error) {
                        is CancellationException -> throw error
                        is InputPreparationException -> throw error
                        else -> throw InputPreparationException(InputPreparationError.STORAGE)
                    }
                }
            }
        }

    suspend fun recover(ownerUid: String, operationId: String, displayName: String, policy: ProcessingMediaPolicy,
        mediaSource: String = "audio_file"): PreparedInput? = withContext(Dispatchers.IO) {
        require(UUID.fromString(operationId).toString() == operationId)
        val marker = File(File(processingOwnerDirectory(root, ownerUid), operationId), "input.json")
        if (!marker.isFile) return@withContext null
        if (marker.length() > 4096) throw InputPreparationException(InputPreparationError.STORAGE)
        val declaration = Json.decodeFromString<InputDeclaration>(marker.readText())
        prepare(ownerUid, "${displayName.substringBeforeLast('.', displayName)}.${declaration.extension}",
            operationId, policy, mediaSource) { throw InputPreparationException(InputPreparationError.STORAGE) }
    }

    private suspend fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                currentCoroutineContext().ensureActive()
                val count = input.read(buffer)
                if (count < 0) break
                if (count > 0) digest.update(buffer, 0, count)
            }
        }
        return Base64.getEncoder().encodeToString(digest.digest())
    }

    private suspend fun <T> withPreparationLock(key: String, block: suspend () -> T): T {
        val entry = synchronized(locks) {
            locks.getOrPut(key) { PreparationLock() }.also { it.users += 1 }
        }
        return try {
            entry.mutex.withLock { block() }
        } finally {
            synchronized(locks) {
                entry.users -= 1
                if (entry.users == 0) locks.remove(key)
            }
        }
    }

    private class PreparationLock(val mutex: Mutex = Mutex(), var users: Int = 0)
    private companion object { val locks = mutableMapOf<String, PreparationLock>() }
}
