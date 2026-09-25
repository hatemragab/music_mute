package com.hatem.musicmute.processing

import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

/** Coordinates local-file preparation and durable cloud uploads. */
class AudioPipelineCoordinator(
    private val repository: ProcessingRepository,
    private val preparer: AudioInputPreparer,
    private val session: () -> ProcessingSession?,
    private val usageRepository: ProcessingUsageRepository? = null,
    private val preparationScheduler: MediaPreparationScheduler? = null,
    private val policyReader: suspend () -> ProcessingMediaPolicy = { ProcessingMediaPolicy.STANDARD },
) {
    private val localSlots = Semaphore(1)
    private data class ActiveImport(val owner: ProcessingSession, val job: Job)
    private val activeImports = ConcurrentHashMap<String, ActiveImport>()

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
        repository.resume(operationId)
    }

    suspend fun onSessionChanged(previousOwnerUid: String?) {
        if (previousOwnerUid != null && session()?.uid != previousOwnerUid) {
            activeImports.values.filter { it.owner.uid == previousOwnerUid }.forEach {
                it.job.cancelAndJoin()
            }
            usageRepository?.clear()
            preparationScheduler?.cancelOwner(previousOwnerUid)
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
        }
    }

    suspend fun pauseForUpdate() {
        val owner = session() ?: return
        activeImports.values.filter { it.owner == owner }.forEach { it.job.cancelAndJoin() }
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
