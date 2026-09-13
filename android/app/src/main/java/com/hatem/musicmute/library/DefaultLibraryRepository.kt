package com.hatem.musicmute.library

import com.hatem.musicmute.processing.ArtifactException
import com.hatem.musicmute.processing.ArtifactProblem
import com.hatem.musicmute.processing.JobArtifactRepository
import com.hatem.musicmute.processing.JobsFailure
import com.hatem.musicmute.processing.JobsProblem
import com.hatem.musicmute.processing.ProcessingSession
import com.hatem.musicmute.processing.ProcessingStore
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** One account-scoped catalog for every screen, without fetching audio on observation. */
class DefaultLibraryRepository(
    private val store: ProcessingStore,
    private val artifacts: JobArtifactRepository,
    private val sessions: StateFlow<ProcessingSession?>,
    scope: CoroutineScope,
) : LibraryRepository {
    private val mutableEntries = MutableStateFlow<List<LibraryEntry>>(emptyList())
    override val entries = mutableEntries.asStateFlow()
    private val failures = MutableStateFlow<Map<LibraryKey, LibraryProblem>>(emptyMap())
    private val mutableLoadFailed = MutableStateFlow(false)
    val loadFailed = mutableLoadFailed.asStateFlow()
    private val reloads = MutableStateFlow(0L)

    /** Recheck local metadata/files after an I/O failure or returning to the foreground. */
    fun refreshLocal() { reloads.update { it + 1 } }

    init {
        scope.launch {
            var displayedSession: ProcessingSession? = null
            combine(sessions, reloads) { session, _ -> session }.collectLatest { session ->
                if (session != displayedSession) mutableEntries.value = emptyList()
                displayedSession = session
                failures.value = emptyMap()
                mutableLoadFailed.value = false
                if (session == null) return@collectLatest
                try {
                    coroutineScope {
                        // Validate once per newly discovered item, away from UI rendering/progress ticks.
                        launch {
                            val inspected = mutableSetOf<String>()
                            store.library(session.uid).distinctUntilChanged().collect { records ->
                                for (record in records) {
                                    if (inspected.add(record.job.id)) {
                                        try { localFile(LibraryKey(session.uid, record.job.id)) }
                                        catch (error: CancellationException) { throw error }
                                        catch (_: Exception) { /* Item remains remote-only until an explicit retry. */ }
                                    }
                                }
                            }
                        }
                        combine(store.library(session.uid), artifacts.progress, artifacts.availability, failures) {
                                records, progress, available, problems ->
                            records.map { record ->
                                val job = record.job
                                val key = LibraryKey(session.uid, job.id)
                                val transfer = progress[job.id]
                                val problem = problems[key]
                                LibraryEntry(
                                    key = key,
                                    title = job.displayName?.takeIf { it.isNotBlank() }
                                        ?: job.sourceTitle?.takeIf { it.isNotBlank() } ?: "Audio",
                                    createdAtEpochMs = job.createdAt.toEpochMilli(),
                                    durationMs = job.input.durationSeconds.takeIf { it.isFinite() && it >= 0 }
                                        ?.let { (it * 1000).toLong() },
                                    starred = record.starred,
                                    hidden = record.hidden,
                                    offlineStatus = when {
                                        transfer != null -> OfflineStatus.DOWNLOADING
                                        available[job.id] == true -> OfflineStatus.AVAILABLE
                                        problem != null -> OfflineStatus.FAILED
                                        else -> OfflineStatus.REMOTE_ONLY
                                    },
                                    downloadedBytes = transfer?.bytes ?: 0,
                                    totalBytes = transfer?.totalBytes,
                                    problem = problem,
                                )
                            }
                        }.collect { entries ->
                            if (sessions.value == session) mutableEntries.value = entries
                        }
                    }
                } catch (error: CancellationException) { throw error }
                catch (_: Exception) {
                    if (sessions.value == session) mutableLoadFailed.value = true
                }
            }
        }
    }

    override suspend fun setStarred(key: LibraryKey, starred: Boolean) {
        val session = requireOwner(key)
        store.updateLibraryFlags(session.uid, key.jobId, starred = starred)
        checkSession(session)
    }

    suspend fun toggleStar(key: LibraryKey) {
        val session = requireOwner(key)
        store.toggleLibraryStar(session.uid, key.jobId)
        checkSession(session)
    }

    override suspend fun setHidden(key: LibraryKey, hidden: Boolean) {
        val session = requireOwner(key)
        store.updateLibraryFlags(session.uid, key.jobId, hidden = hidden)
        checkSession(session)
    }

    override suspend fun localFile(key: LibraryKey): File? {
        val session = requireOwner(key)
        return artifacts.localOutput(key.jobId).also { checkSession(session) }
    }

    /** Detail metadata is available after restart without refreshing a cloud job. */
    suspend fun storedJob(key: LibraryKey): com.hatem.musicmute.processing.Job? {
        val session = requireOwner(key)
        return store.library(session.uid).first().firstOrNull { it.job.id == key.jobId }?.job
            .also { checkSession(session) }
    }

    override suspend fun ensureLocal(key: LibraryKey): File {
        val session = requireOwner(key)
        failures.update { it - key }
        try {
            return artifacts.ensureOutput(key.jobId).also { checkSession(session) }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            if (sessions.value == session) failures.update { it + (key to problem(error)) }
            throw error
        }
    }

    private fun requireOwner(key: LibraryKey): ProcessingSession =
        sessions.value?.takeIf { it.uid == key.ownerUid }
            ?: throw JobsFailure(JobsProblem.UNAUTHENTICATED)

    private fun checkSession(session: ProcessingSession) {
        if (sessions.value != session) throw CancellationException("Library session changed")
    }

    private fun problem(error: Exception): LibraryProblem = when {
        error is JobsFailure && error.problem == JobsProblem.OFFLINE -> LibraryProblem.OFFLINE
        error is ArtifactException && error.problem == ArtifactProblem.STORAGE -> LibraryProblem.STORAGE
        error is ArtifactException && error.problem == ArtifactProblem.INVALID_OUTPUT -> LibraryProblem.INVALID_AUDIO
        else -> LibraryProblem.TRANSFER
    }
}
