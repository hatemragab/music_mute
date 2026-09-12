package com.hatem.musicmute.processing

import com.hatem.musicmute.data.YouTubeUrl
import java.io.File
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

interface PipelineSourceScheduler {
    suspend fun enqueue(ownerUid: String, operationId: String, url: String, epoch: Long)
    suspend fun cancel(ownerUid: String, operationId: String)
    suspend fun pause(ownerUid: String, operationId: String) = cancel(ownerUid, operationId)
    suspend fun cancelOwner(ownerUid: String)
}

/** Joins durable source intake to the existing downloader and upload state machines. */
class AudioPipelineCoordinator(
    private val repository: ProcessingRepository,
    private val preparer: AudioInputPreparer,
    private val session: () -> ProcessingSession?,
    private val sourceScheduler: PipelineSourceScheduler,
) {
    private val localSlots = Semaphore(2)
    private data class ActiveImport(val owner: ProcessingSession, val job: Job)
    private val activeImports = ConcurrentHashMap<String, ActiveImport>()

    suspend fun acceptUrl(operationId: String, rawUrl: String): ProcessingOperation {
        repository.requireUpdateAllowed()
        val owner = requireSession()
        val url = requireNotNull(YouTubeUrl.canonical(rawUrl))
        repository.store.get(owner.uid, operationId)?.let { existing ->
            require(existing.sourceKind == SourceKind.URL && existing.sourceUrl == url)
            return existing
        }
        val operation = repository.acceptIntent(operationId, SourceKind.URL, "Audio", url)
        checkSession(owner)
        try {
            sourceScheduler.enqueue(owner.uid, operation.operationId, url, owner.epoch)
        } catch (error: Exception) {
            repository.store.update(owner.uid, operation.operationId) {
                if (it.cancellationRequested) it else it.copy(phase = ProcessingPhase.SOURCE_QUEUED)
            }
            throw error
        }
        checkSession(owner)
        return operation
    }

    suspend fun acceptImport(
        operationId: String,
        sourceName: String,
        open: () -> InputStream,
    ): ProcessingOperation {
        repository.requireUpdateAllowed()
        val owner = requireSession()
        val extension = sourceName.substringAfterLast('.', "").lowercase(java.util.Locale.ROOT)
        if (processingContentType(extension) == null)
            throw InputPreparationException(InputPreparationError.UNSUPPORTED)
        val safeTitle = boundedSourceTitle(sourceName.substringBeforeLast('.', sourceName))
        repository.acceptIntent(
            operationId,
            SourceKind.FILE,
            safeTitle,
        )
        val active = ActiveImport(owner, currentCoroutineContext()[Job] ?: changedSession())
        activeImports[key(owner.uid, operationId)] = active
        return try {
            localSlots.withPermit {
                repository.requireUpdateAllowed()
                checkSession(owner)
                val accepted = repository.store.get(owner.uid, operationId) ?: changedSession()
                if (accepted.cancellationRequested || accepted.pendingDelete) throw CancellationException(
                    "Import cancelled"
                )
                val prepared = preparer.prepare(owner.uid, "$safeTitle.$extension", operationId, open)
                repository.requireUpdateAllowed()
                checkSession(owner)
                repository.submit(prepared, requireCloudConsent = true)
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: InputPreparationException) {
            repository.markLocalFailure(operationId, when (error.reason) {
                InputPreparationError.STORAGE -> ProcessingLocalProblem.STORAGE
                else -> ProcessingLocalProblem.INPUT_CHANGED
            })
            throw error
        } finally {
            activeImports.remove(key(owner.uid, operationId), active)
        }
    }

    suspend fun completeUrlDownload(
        ownerUid: String,
        operationId: String,
        expectedEpoch: Long,
        sourceTitle: String,
        downloadedFile: File,
        expectedWorkRequestId: String? = null,
    ): ProcessingOperation {
        repository.requireUpdateAllowed()
        val owner = ProcessingSession(ownerUid, expectedEpoch)
        checkSession(owner)
        val current = repository.store.get(ownerUid, operationId) ?: changedSession()
        if (expectedWorkRequestId != null && current.sourceWorkRequestId != expectedWorkRequestId)
            changedSession()
        if (current.cancellationRequested) return current
        if (current.input != null) {
            if (current.phase != ProcessingPhase.COMPLETE) repository.resume(operationId)
            checkSession(owner)
            return repository.store.get(ownerUid, operationId) ?: changedSession()
        }
        repository.updateSourceTitle(operationId, sourceTitle)
        checkSession(owner)
        val extension = downloadedFile.extension.lowercase().ifBlank { "mp3" }
        val prepared = preparer.prepare(ownerUid, "$sourceTitle.$extension", operationId) {
            downloadedFile.inputStream()
        }
        checkSession(owner)
        val preparedCurrent = repository.store.get(ownerUid, operationId) ?: changedSession()
        if (expectedWorkRequestId != null && preparedCurrent.sourceWorkRequestId != expectedWorkRequestId)
            changedSession()
        return repository.submit(prepared, expectedWorkRequestId, requireCloudConsent = true).also { checkSession(owner) }
    }

    suspend fun <T> withLocalSlot(
        ownerUid: String,
        expectedEpoch: Long,
        block: suspend () -> T,
    ): T = localSlots.withPermit {
        repository.requireUpdateAllowed()
        val owner = ProcessingSession(ownerUid, expectedEpoch)
        checkSession(owner)
        block().also { checkSession(owner) }
    }

    suspend fun cancel(operationId: String) {
        val owner = requireSession()
        repository.requestCancellation(operationId) ?: return
        activeImports[key(owner.uid, operationId)]?.job?.cancelAndJoin()
        checkSession(owner)
        sourceScheduler.cancel(owner.uid, operationId)
        checkSession(owner)
        repository.cancelOperation(operationId)
    }

    suspend fun retry(operationId: String) {
        repository.requireUpdateAllowed()
        val owner = requireSession()
        val operation = repository.store.get(owner.uid, operationId) ?: return
        if (operation.sourceKind != SourceKind.URL || operation.input != null) {
            repository.resume(operationId)
            return
        }
        val reset = repository.store.update(owner.uid, operationId) {
            checkSession(owner)
            if (it.cancellationRequested || it.pendingDelete) it
            else it.copy(
                phase = ProcessingPhase.SOURCE_QUEUED,
                problem = null,
                localProblem = null,
                transientRetryCount = 0,
                retryNotBeforeMillis = 0,
            )
        } ?: return
        checkSession(owner)
        if (!reset.cancellationRequested && !reset.pendingDelete) {
            sourceScheduler.enqueue(
                owner.uid,
                reset.operationId,
                reset.sourceUrl ?: throw JobsFailure(JobsProblem.INVALID_INPUT),
                owner.epoch,
            )
        }
    }

    suspend fun onSessionChanged(previousOwnerUid: String?) {
        if (previousOwnerUid != null && session()?.uid != previousOwnerUid) {
            activeImports.values.filter { it.owner.uid == previousOwnerUid }.forEach {
                it.job.cancelAndJoin()
            }
            sourceScheduler.cancelOwner(previousOwnerUid)
        }
    }

    suspend fun resumePendingSources() {
        repository.requireUpdateAllowed()
        val owner = requireSession()
        repository.store.operations(owner.uid).first().forEach { operation ->
            if (operation.sourceKind == SourceKind.URL && operation.input == null &&
                !operation.cancellationRequested && operation.phase != ProcessingPhase.COMPLETE
            ) {
                val url = operation.sourceUrl ?: return@forEach
                checkSession(owner)
                sourceScheduler.enqueue(owner.uid, operation.operationId, url, owner.epoch)
            }
        }
    }

    suspend fun pauseForUpdate() {
        val owner = session() ?: return
        activeImports.values.filter { it.owner == owner }.forEach { it.job.cancelAndJoin() }
        val sourceOperations =
            repository.store.operations(owner.uid).first().filter {
                it.sourceKind == SourceKind.URL &&
                    it.input == null &&
                    !it.cancellationRequested &&
                    !it.pendingDelete &&
                    it.phase != ProcessingPhase.COMPLETE
            }
        for (operation in sourceOperations) {
            checkSession(owner)
            sourceScheduler.pause(owner.uid, operation.operationId)
            checkSession(owner)
            repository.store.update(owner.uid, operation.operationId) {
                if (it.input != null || it.phase == ProcessingPhase.COMPLETE) it
                else
                    it.copy(
                        phase = ProcessingPhase.SOURCE_QUEUED,
                        sourceWorkRequestId = null,
                        problem = JobsProblem.APP_UPDATE_REQUIRED,
                    )
            }
        }
        repository.pauseForUpdate()
    }

    private fun requireSession() = session() ?: throw JobsFailure(JobsProblem.UNAUTHENTICATED)
    private fun checkSession(expected: ProcessingSession) {
        if (session() != expected) changedSession()
    }
    private fun changedSession(): Nothing = throw CancellationException("Processing session changed")
    private fun key(uid: String, operationId: String) = "$uid:$operationId"
}
