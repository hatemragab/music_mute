package com.hatem.musicmute.state

import android.content.ContentResolver
import android.content.Intent
import android.os.Build
import android.net.Uri
import android.provider.OpenableColumns
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.hatem.musicmute.R
import com.hatem.musicmute.BuildConfig
import com.hatem.musicmute.download.DownloadRecord
import com.hatem.musicmute.download.DownloadStatus
import com.hatem.musicmute.download.processedAudioExportName
import com.hatem.musicmute.playback.AudioPlaybackController
import com.hatem.musicmute.processing.*
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job as CoroutineJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class ProcessingUiState(
    val preparing: Boolean = false,
    val busy: Boolean = false,
    val pendingInputName: String? = null,
    val operations: List<ProcessingOperation> = emptyList(),
    val selectedOperationId: String? = null,
    val message: Int? = null,
)

class ProcessingViewModel(
    api: JobsApi,
    private val repository: ProcessingRepository,
    private val coordinator: AudioPipelineCoordinator,
    private val session: () -> ProcessingSession?,
    private val resolver: ContentResolver,
    val playback: AudioPlaybackController,
    private val outputFile: suspend (String) -> File,
    private val share: ProcessedAudioShare,
    private val evictOutput: suspend (String) -> Unit,
    private val errorOutbox: ClientErrorOutbox,
) : ViewModel() {
    val history = JobHistoryController(api, viewModelScope,
        loadCached = { repository.store.snapshots(it).first() },
        saveCached = { uid, jobs -> repository.store.saveSnapshots(uid, jobs) },
        onMissing = { jobId ->
            session()?.let { current ->
                playback.removeTrack(com.hatem.musicmute.library.LibraryKey(current.uid, jobId))
                repository.store.removeLibraryJob(current.uid, jobId)
                evictOutput(jobId)
                share.evict(current.uid, jobId)
            }
        })
    private val mutableState = MutableStateFlow(ProcessingUiState())
    val state = mutableState.asStateFlow()
    private var owner: ProcessingSession? = null
    private var operationsTask: CoroutineJob? = null
    private var actionTask: CoroutineJob? = null
    private var activeIntakes = 0

    fun bindSession(value: ProcessingSession?) {
        if (value == owner) return
        operationsTask?.cancel()
        actionTask?.cancel()
        // Service/session ownership handles invalidation. Attaching a new screen must not stop playback.
        owner = value
        mutableState.value = ProcessingUiState()
        // Force a new epoch even when the same account signs in again.
        history.bindOwner(null)
        history.bindOwner(value?.uid)
        if (value != null) operationsTask = viewModelScope.launch {
            try {
                repository.store.operations(value.uid).collect { operations ->
                    if (owner == value && session() == value) {
                        mutableState.update { it.copy(operations = operations) }
                    }
                }
            } catch (error: CancellationException) { throw error }
            catch (_: Exception) { if (owner == value) mutableState.update { it.copy(message = R.string.processing_error_storage) } }
        }
    }

    fun importAudio(uri: Uri) {
        val operationId = UUID.randomUUID().toString()
        performIntake(operationId) { ticket ->
        val name = withContext(Dispatchers.IO) {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            } ?: uri.lastPathSegment.orEmpty()
        }
        coordinator.acceptImport(operationId, name) {
            resolver.openInputStream(uri) ?: throw InputPreparationException(InputPreparationError.STORAGE)
        }
        checkSession(ticket)
        history.refresh()
        }
    }

    fun submitUrl(url: String, onAccepted: () -> Unit = {}) {
        val operationId = UUID.randomUUID().toString()
        performIntake(operationId) { ticket ->
            coordinator.acceptUrl(operationId, url)
            checkSession(ticket)
            onAccepted()
            history.refresh()
        }
    }

    fun removeMusic(record: DownloadRecord, file: File) {
        val operationId = UUID.randomUUID().toString()
        performIntake(operationId) { ticket ->
        coordinator.acceptImport(
            operationId,
            "${record.title.ifBlank { "Audio" }}.${record.extension}",
        ) { file.inputStream() }
        checkSession(ticket)
        history.refresh()
        }
    }

    fun confirmCloudProcessing(id: String, rightsConfirmed: Boolean) = perform { ticket ->
        repository.confirmCloudProcessing(id, rightsConfirmed)
        checkSession(ticket)
        history.refresh()
    }

    fun discardReview(id: String) = perform { ticket ->
        repository.deleteOperation(id)
        checkSession(ticket)
    }

    fun resume(id: String) = perform { ticket -> coordinator.retry(id); checkSession(ticket); history.refresh() }
    fun cancelOperation(id: String) = perform { ticket -> coordinator.cancel(id); checkSession(ticket); history.refresh() }

    fun selectTask(operationId: String?, jobId: String?) {
        mutableState.update { it.copy(selectedOperationId = operationId) }
        history.select(jobId)
    }

    fun clearSelection() {
        mutableState.update { it.copy(selectedOperationId = null) }
        history.select(null)
    }

    fun renameSelected(displayName: String) =
        renameTask(mutableState.value.selectedOperationId, history.state.value.selectedId, displayName)

    fun renameTask(operationId: String?, jobId: String?, displayName: String) = perform { ticket ->
        when {
            operationId != null -> repository.renameOperation(operationId, displayName)
            jobId != null -> repository.renameJob(jobId, displayName)
            else -> return@perform
        }
        checkSession(ticket)
        history.refresh()
    }

    fun deleteSelected(onDeleted: () -> Unit = {}) =
        deleteTask(mutableState.value.selectedOperationId, history.state.value.selectedId, onDeleted)

    fun deleteTask(operationId: String?, jobId: String?, onDeleted: () -> Unit) = perform { ticket ->
        if (jobId != null) {
            repository.deleteJob(jobId)
            checkSession(ticket)
            playback.removeTrack(com.hatem.musicmute.library.LibraryKey(ticket.uid, jobId))
            evictOutput(jobId)
            share.evict(ticket.uid, jobId)
        } else if (operationId != null) {
            repository.deleteOperation(operationId)
        } else return@perform
        checkSession(ticket)
        if (history.state.value.selectedId == jobId && mutableState.value.selectedOperationId == operationId) clearSelection()
        history.refresh()
        onDeleted()
    }

    fun renameLibraryTrack(key: com.hatem.musicmute.library.LibraryKey, title: String) = perform { ticket ->
        if (ticket.uid != key.ownerUid) throw CancellationException("Library owner changed")
        repository.renameJob(key.jobId, title)
        checkSession(ticket)
        history.refresh()
    }

    fun deleteLibraryTrack(key: com.hatem.musicmute.library.LibraryKey, onDeleted: () -> Unit) = perform { ticket ->
        if (ticket.uid != key.ownerUid) throw CancellationException("Library owner changed")
        repository.deleteJob(key.jobId)
        checkSession(ticket)
        playback.removeTrack(key)
        evictOutput(key.jobId)
        share.evict(ticket.uid, key.jobId)
        checkSession(ticket)
        if (history.state.value.selectedId == key.jobId) clearSelection()
        history.refresh()
        onDeleted()
    }

    private fun performIntake(operationId: String, action: suspend (ProcessingSession) -> Unit) {
        val ticket = owner?.takeIf { it == session() } ?: return
        activeIntakes++
        mutableState.update { it.copy(preparing = true, message = null) }
        viewModelScope.launch {
            try {
                action(ticket)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (owner == ticket && session() == ticket) {
                    mutableState.update { it.copy(message = processingActionFailureLabel(error)) }
                    captureFailure(ticket, operationId, null, ClientErrorStage.SOURCE_INTAKE, error)
                }
            } finally {
                activeIntakes = (activeIntakes - 1).coerceAtLeast(0)
                if (owner == ticket) mutableState.update { it.copy(preparing = activeIntakes > 0) }
            }
        }
    }

    fun cancelSelected() = history.state.value.selectedId?.let(::cancelJob)
    fun cancelJob(id: String) = perform { ticket -> repository.cancel(id); checkSession(ticket); history.refresh() }

    fun retrySelected() = history.state.value.selectedId?.let(::retryJob)
    fun retryJob(id: String) =
        perform { ticket ->
            val operation = repository.retry(id)
            checkSession(ticket)
            history.refresh()
            if (history.state.value.selectedId == id) operation.jobId?.let(history::select)
        }

    fun downloadSelected(onReady: ((File, String) -> Unit)? = null) = history.state.value.detail?.let { job ->
        perform { ticket ->
            val file = outputFile(job.id)
            checkSession(ticket)
            mutableState.update { it.copy(message = R.string.processing_downloaded) }
            onReady?.invoke(file, processedAudioExportName(job.displayName ?: job.sourceTitle ?: "Voice"))
        }
    }

    /** Library actions must not depend on a successful online job-detail refresh. */
    fun downloadLibraryTrack(key: com.hatem.musicmute.library.LibraryKey, title: String,
        onReady: ((File, String) -> Unit)? = null) = perform { ticket ->
        if (ticket.uid != key.ownerUid) throw CancellationException("Library owner changed")
        val file = outputFile(key.jobId)
        checkSession(ticket)
        mutableState.update { it.copy(message = R.string.processing_downloaded) }
        onReady?.invoke(file, processedAudioExportName(title))
    }

    fun shareLibraryTrack(key: com.hatem.musicmute.library.LibraryKey, title: String,
        onReady: (Intent) -> Unit) = perform { ticket ->
        if (ticket.uid != key.ownerUid) throw CancellationException("Library owner changed")
        val file = outputFile(key.jobId)
        checkSession(ticket)
        val intent = withContext(Dispatchers.IO) { share.intent(file, title, ticket.uid, key.jobId) }
        checkSession(ticket)
        onReady(intent)
    }

    fun shareSelected(onReady: (Intent) -> Unit) = history.state.value.detail?.let { job ->
        perform { ticket ->
            val file = outputFile(job.id)
            checkSession(ticket)
            val intent = withContext(Dispatchers.IO) {
                share.intent(file, job.displayName ?: job.sourceTitle ?: "Voice", ticket.uid, job.id)
            }
            checkSession(ticket)
            onReady(intent)
        }
    }

    fun playSelected(trackTitle: String) = history.state.value.detail?.let { job ->
        perform { ticket ->
            outputFile(job.id)
            checkSession(ticket)
            val key = com.hatem.musicmute.library.LibraryKey(ticket.uid, job.id)
            val playing = playback.state.value
            if (playing.queue.getOrNull(playing.currentIndex)?.key == key) playback.togglePlayback()
            else playback.playQueue(listOf(com.hatem.musicmute.playback.QueueTrack(key, trackTitle)), key)
        }
    }

    fun export(file: File, destination: Uri, expectedOwner: ProcessingSession) = perform { ticket ->
        if (ticket != expectedOwner) throw CancellationException("Session changed")
        withContext(Dispatchers.IO) {
            resolver.openOutputStream(destination, "w")?.use { target ->
                file.inputStream().use { source ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        currentCoroutineContext().ensureActive()
                        checkSession(ticket)
                        val count = source.read(buffer)
                        if (count < 0) break
                        target.write(buffer, 0, count)
                    }
                    target.flush()
                }
            } ?: throw InputPreparationException(InputPreparationError.STORAGE)
        }
        checkSession(ticket)
        mutableState.update { it.copy(message = R.string.audio_export_success) }
    }

    fun clearMessage() { mutableState.update { it.copy(message = null) } }

    private fun perform(preparing: Boolean = false, action: suspend (ProcessingSession) -> Unit) {
        if (mutableState.value.busy) return
        val ticket = owner?.takeIf { it == session() } ?: return
        mutableState.update { it.copy(busy = !preparing, preparing = preparing, message = null) }
        actionTask = viewModelScope.launch {
            try { action(ticket) }
            catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                if (owner == ticket && session() == ticket) {
                    mutableState.update { it.copy(message = processingActionFailureLabel(error)) }
                    val operationId = mutableState.value.selectedOperationId
                        ?: history.state.value.detail?.requestId
                    if (operationId != null) {
                        captureFailure(
                            ticket,
                            operationId,
                            history.state.value.selectedId,
                            if (error is ArtifactException) ClientErrorStage.FETCHING_OUTPUT
                            else ClientErrorStage.UNKNOWN,
                            error,
                        )
                    }
                    history.refresh()
                }
            } finally {
                if (owner == ticket) mutableState.update {
                    it.copy(busy = false, preparing = if (preparing) false else it.preparing)
                }
            }
        }
    }

    private fun checkSession(expected: ProcessingSession) {
        if (session() != expected) throw CancellationException("Session changed")
    }

    private suspend fun captureFailure(
        ticket: ProcessingSession,
        operationId: String,
        jobId: String?,
        stage: ClientErrorStage,
        error: Exception,
    ) {
        if (session() != ticket) return
        val code = when (error) {
            is InputPreparationException -> when (error.reason) {
                InputPreparationError.STORAGE -> ClientErrorCode.STORAGE
                else -> ClientErrorCode.INVALID_MEDIA
            }
            is ArtifactException -> when (error.problem) {
                ArtifactProblem.STORAGE -> ClientErrorCode.STORAGE
                ArtifactProblem.INVALID_OUTPUT -> ClientErrorCode.INVALID_MEDIA
                else -> ClientErrorCode.NETWORK
            }
            is JobsFailure -> when (error.problem) {
                JobsProblem.OFFLINE -> ClientErrorCode.NETWORK
                JobsProblem.UNAUTHENTICATED -> ClientErrorCode.AUTHENTICATION
                JobsProblem.JOB_NOT_FOUND -> ClientErrorCode.JOB_NOT_FOUND
                JobsProblem.JOB_STATE_CONFLICT, JobsProblem.IDEMPOTENCY_CONFLICT ->
                    ClientErrorCode.JOB_CONFLICT
                else -> ClientErrorCode.SERVER
            }
            else -> ClientErrorCode.LOCAL_IO
        }
        try {
            errorOutbox.capture(
                operationId,
                jobId,
                stage,
                code,
                error is JobsFailure && error.problem in setOf(
                    JobsProblem.OFFLINE,
                    JobsProblem.SERVICE_UNAVAILABLE,
                    JobsProblem.RATE_LIMITED,
                ),
                BuildConfig.VERSION_NAME,
                Build.VERSION.RELEASE,
            )
        } catch (_: Exception) {
            // Diagnostics are best effort and never replace the user-visible failure.
        }
    }

    override fun onCleared() { history.close() }
}

internal fun processingActionFailureLabel(error: Exception): Int = when (error) {
    is InputPreparationException -> if (error.reason == InputPreparationError.STORAGE)
        R.string.processing_error_storage else R.string.processing_error_input
    is JobsFailure -> com.hatem.musicmute.ui.processingFailureLabel(error.problem)
    is ArtifactException -> when (error.problem) {
        ArtifactProblem.STORAGE -> R.string.processing_error_storage
        ArtifactProblem.NOT_READY -> R.string.processing_error_state
        else -> R.string.processing_error_service
    }
    else -> R.string.processing_error_service
}
