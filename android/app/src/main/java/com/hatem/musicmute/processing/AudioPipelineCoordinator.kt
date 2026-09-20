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
    private val usageRepository: ProcessingUsageRepository? = null,
    private val preparationScheduler: MediaPreparationScheduler? = null,
    private val policyReader: suspend () -> ProcessingMediaPolicy = { ProcessingMediaPolicy.STANDARD },
) {
    private val localSlots = Semaphore(1)
    private data class ActiveImport(val owner: ProcessingSession, val job: Job)
    private val activeImports = ConcurrentHashMap<String, ActiveImport>()

    suspend fun acceptUrl(operationId: String, rawUrl: String): ProcessingOperation {
        repository.requireUpdateAllowed()
        val owner = requireSession()
        com.hatem.musicmute.download.YouTubePreflight.validateUrl(rawUrl)
        val url = requireNotNull(YouTubeUrl.canonical(rawUrl))
        preflightAvailability()
        checkSession(owner)
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
        preflightAvailability()
        checkSession(owner)
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
                val prepared = preparer.prepare(owner.uid, "$safeTitle.$extension", operationId, open = open)
                repository.requireUpdateAllowed()
                checkSession(owner)
                repository.submit(prepared)
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

    suspend fun acceptDocument(operationId: String, name: String, uri: String): ProcessingOperation {
        repository.requireUpdateAllowed()
        val owner = requireSession()
        preflightAvailability()
        checkSession(owner)
        val existing = repository.store.operations(owner.uid).first().firstOrNull {
            it.sourceUri == uri && !it.cancellationRequested && it.phase != ProcessingPhase.COMPLETE
        }
        if (existing != null) return existing
        repository.acceptIntent(operationId, SourceKind.FILE, boundedSourceTitle(name.substringBeforeLast('.', name)))
        val operation = repository.store.update(owner.uid, operationId) {
            it.copy(sourceUri = uri, sourceName = name, phase = ProcessingPhase.SOURCE_QUEUED)
        } ?: changedSession()
        checkSession(owner)
        preparationScheduler?.enqueue(owner.uid, operationId, owner.epoch)
            ?: throw InputPreparationException(InputPreparationError.STORAGE)
        return operation
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
        val policy = policyReader()
        if (!policy.acceptNewJobs || !policy.youtubePreparationReady)
            throw JobsFailure(JobsProblem.PROCESSING_CAPACITY_UNAVAILABLE)
        val prepared = preparer.prepare(ownerUid, "$sourceTitle.$extension", operationId, policy, "youtube") {
            downloadedFile.inputStream()
        }
        checkSession(owner)
        val preparedCurrent = repository.store.get(ownerUid, operationId) ?: changedSession()
        if (expectedWorkRequestId != null && preparedCurrent.sourceWorkRequestId != expectedWorkRequestId)
            changedSession()
        return repository.submit(prepared, expectedWorkRequestId).also { checkSession(owner) }
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
        preparationScheduler?.cancel(owner.uid, operationId)
        sourceScheduler.cancel(owner.uid, operationId)
        checkSession(owner)
        repository.cancelOperation(operationId)
    }

    suspend fun retry(operationId: String) {
        repository.requireUpdateAllowed()
        val owner = requireSession()
        val operation = repository.store.get(owner.uid, operationId) ?: return
        if (operation.sourceUri != null && operation.input == null && !operation.cancellationRequested) {
            repository.store.update(owner.uid, operationId) { it.copy(localProblem = null, problem = null, phase = ProcessingPhase.PREPARING_INPUT) }
            preparationScheduler?.enqueue(owner.uid, operationId, owner.epoch)
            return
        }
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
            usageRepository?.clear()
            preparationScheduler?.cancelOwner(previousOwnerUid)
            sourceScheduler.cancelOwner(previousOwnerUid)
        }
    }

    suspend fun resumePendingSources() {
        repository.requireUpdateAllowed()
        val owner = requireSession()
        repository.store.operations(owner.uid).first().forEach { operation ->
            if (operation.sourceUri != null && operation.input == null && !operation.cancellationRequested &&
                operation.phase != ProcessingPhase.COMPLETE && operation.localProblem == null && operation.problem == null) {
                preparationScheduler?.enqueue(owner.uid, operation.operationId, owner.epoch)
            }
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

    private suspend fun preflightAvailability() {
        val policy = policyReader()
        usageRepository?.refresh()?.requireAvailable(policy.localPreparationReady && policy.acceptNewJobs)
    }

    private fun requireSession() = session() ?: throw JobsFailure(JobsProblem.UNAUTHENTICATED)
    private fun checkSession(expected: ProcessingSession) {
        if (session() != expected) changedSession()
    }
    private fun changedSession(): Nothing = throw CancellationException("Processing session changed")
    private fun key(uid: String, operationId: String) = "$uid:$operationId"
}
