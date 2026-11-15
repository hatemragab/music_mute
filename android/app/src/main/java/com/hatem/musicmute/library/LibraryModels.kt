package com.hatem.musicmute.library

import com.hatem.musicmute.processing.Job
import java.io.File
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.Serializable

data class LibraryKey(val ownerUid: String, val jobId: String)
enum class OfflineStatus { REMOTE_ONLY, DOWNLOADING, AVAILABLE, FAILED }
enum class LibraryFilter { ALL, STARRED, DOWNLOADED, NOT_DOWNLOADED, REMOVED }
enum class LibrarySort { NEWEST, TITLE }
enum class LibraryProblem { OFFLINE, MISSING_FILE, STORAGE, TRANSFER, INVALID_AUDIO }

@Serializable
data class StoredLibraryTrack(val job: Job, val starred: Boolean = false, val hidden: Boolean = false)

data class LibraryEntry(
    val key: LibraryKey,
    val title: String,
    val createdAtEpochMs: Long,
    val durationMs: Long?,
    val starred: Boolean,
    val hidden: Boolean,
    val offlineStatus: OfflineStatus,
    val downloadedBytes: Long = 0,
    val totalBytes: Long? = null,
    val problem: LibraryProblem? = null,
)

interface LibraryRepository {
    val entries: StateFlow<List<LibraryEntry>>
    suspend fun setStarred(key: LibraryKey, starred: Boolean)
    suspend fun setHidden(key: LibraryKey, hidden: Boolean)
    suspend fun ensureLocal(key: LibraryKey): File
    suspend fun localFile(key: LibraryKey): File?
}
