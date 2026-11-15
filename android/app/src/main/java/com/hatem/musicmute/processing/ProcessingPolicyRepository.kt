package com.hatem.musicmute.processing

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job as CoroutineJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

interface ProcessingPolicyCache {
    suspend fun read(ownerUid: String? = null): ProcessingMediaPolicy?
    suspend fun write(value: ProcessingMediaPolicy, ownerUid: String? = null)
}

/** Guest and owner policies live separately in installation-private no-backup storage. */
class FileProcessingPolicyCache(private val file: File) : ProcessingPolicyCache {
    private val json = Json { ignoreUnknownKeys = true }

    private fun scopedFile(ownerUid: String?): File {
        if (ownerUid == null) return file
        val digest = MessageDigest.getInstance("SHA-256").digest(ownerUid.toByteArray())
            .joinToString("") { "%02x".format(it) }
        return File(file.parentFile, "${file.name}.owner-$digest")
    }

    override suspend fun read(ownerUid: String?): ProcessingMediaPolicy? = withContext(Dispatchers.IO) {
        val file = scopedFile(ownerUid)
        if (!file.isFile || file.length() > 256 * 1024) return@withContext null
        runCatching { json.decodeFromString<ProcessingMediaPolicy>(file.readText()) }
            .getOrNull()?.takeIf { it.version == 2 && it.revision >= 0 }
    }

    override suspend fun write(value: ProcessingMediaPolicy, ownerUid: String?) = withContext(Dispatchers.IO) {
        val file = scopedFile(ownerUid)
        file.parentFile?.mkdirs()
        val temporary = File(file.parentFile, "${file.name}.tmp")
        try {
            temporary.outputStream().use { it.write(json.encodeToString(value).toByteArray()) }
            Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            Unit
        } finally {
            temporary.delete()
        }
    }
}

/** Native presentation policy. Foreground/session opens check once, then use the shared socket. */
class ProcessingPolicyRepository(
    private val scope: CoroutineScope,
    private val cache: ProcessingPolicyCache,
    private val checkout: suspend (authenticated: Boolean) -> ProcessingMediaPolicy,
    private val snapshots: () -> Flow<ProcessingMediaPolicy>,
) {
    private val mutablePolicy = MutableStateFlow(ProcessingMediaPolicy.STANDARD)
    val policy = mutablePolicy.asStateFlow()
    private val restoration = Mutex()
    private val persistence = Mutex()
    private var restored = false
    private var owner: ProcessingSession? = null
    private var foreground = false
    private var generation = 0L
    private var snapshotVersion = 0L
    private var opening: CoroutineJob? = null
    private var fetching: CoroutineJob? = null
    private var watching: CoroutineJob? = null

    suspend fun initialize() = restoration.withLock {
        if (restored) return@withLock
        val capturedGeneration = generation
        val ownerUid = owner?.uid
        try {
            val cached = cache.read(ownerUid)
            if (capturedGeneration != generation) return@withLock
            cached?.let { mutablePolicy.value = it }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            // Missing/unusable cache keeps the initial file-only presentation.
        }
        if (capturedGeneration == generation) restored = true
    }

    fun bindSession(value: ProcessingSession?) {
        if (owner == value) return
        if (owner?.uid != value?.uid) {
            mutablePolicy.value = ProcessingMediaPolicy.STANDARD
            restored = false
        }
        owner = value
        open()
    }

    fun setForeground(value: Boolean) {
        if (foreground == value) return
        foreground = value
        open()
    }

    private fun open() {
        val expectedGeneration = ++generation
        opening?.cancel()
        fetching?.cancel()
        watching?.cancel()
        if (!foreground) return
        val authenticated = owner != null
        opening = scope.launch {
            initialize()
            if (expectedGeneration != generation) return@launch
            if (authenticated) watching = scope.launch {
                try {
                    snapshots().collect { result -> apply(result, expectedGeneration, snapshot = true) }
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    // The shared transport owns reconnects; retain the last good policy.
                }
            }
            fetching = scope.launch {
                val startedAtSnapshot = snapshotVersion
                try {
                    apply(checkout(authenticated), expectedGeneration, snapshot = false, startedAtSnapshot)
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    // Offline/error opens use the installation's last good policy.
                }
            }
        }
    }

    private suspend fun apply(
        result: ProcessingMediaPolicy,
        expectedGeneration: Long,
        snapshot: Boolean,
        startedAtSnapshot: Long = snapshotVersion,
    ) {
        if (generation != expectedGeneration) return
        val revision = result.linkImportPolicyRevision ?: result.revision
        val currentRevision = mutablePolicy.value.let { it.linkImportPolicyRevision ?: it.revision }
        if (revision < currentRevision) return
        // A socket snapshot wins equal-revision races, including a new ticket's country.
        if (!snapshot && revision == currentRevision && startedAtSnapshot != snapshotVersion) return
        if (snapshot) snapshotVersion++
        mutablePolicy.value = result
        persistence.withLock {
            if (generation != expectedGeneration || mutablePolicy.value != result) return@withLock
            try {
                cache.write(result, owner?.uid)
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                // A cache failure does not discard a valid live presentation decision.
            }
        }
    }
}
