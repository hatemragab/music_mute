package com.hatem.musicmute.processing

import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job as CoroutineJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

interface ProcessingScheduler {
    suspend fun enqueue(ownerUid: String, operationId: String, epoch: Long)
    suspend fun cancel(ownerUid: String, operationId: String)
    suspend fun cancelOwner(ownerUid: String)
    suspend fun cancelSession(ownerUid: String, epoch: Long) = cancelOwner(ownerUid)
    suspend fun enqueueAfter(ownerUid: String, operationId: String, epoch: Long, delayMillis: Long) = enqueue(ownerUid, operationId, epoch)
}

enum class ProcessingRunResult { COMPLETE, RETRY, PAUSED }

/** The persisted request ID is the authority across retries and process recreation.
 * Every store write and network completion is fenced by both UID and session epoch.
 */
class ProcessingRepository(
    val store: ProcessingStore,
    private val stagingRoot: File,
    private val api: JobsApi,
    private val session: () -> ProcessingSession?,
    private val scheduler: ProcessingScheduler,
    private val uploader: FormUploader = S3FormUploader(),
    private val now: () -> Long = System::currentTimeMillis,
    private val availableSpace: () -> Long = { stagingRoot.usableSpace },
    private val updateBlocked: () -> Boolean = { false },
) {
    private val submitLock = Mutex()
    private val runLocks = ConcurrentHashMap<String, Mutex>()
    private data class ActiveRun(val session: ProcessingSession, val job: CoroutineJob)
    private val activeRuns = ConcurrentHashMap<String, ActiveRun>()
    private var previousSession: ProcessingSession? = session()

    suspend fun acceptIntent(
        operationId: String,
        sourceKind: SourceKind,
        sourceTitle: String,
        sourceUrl: String? = null,
    ): ProcessingOperation = submitLock.withLock {
        requireUpdateAllowed()
        val owner = requireSession()
        require(UUID.fromString(operationId).toString() == operationId)
        val normalizedTitle = boundedSourceTitle(sourceTitle)
        require((sourceKind == SourceKind.URL) == (sourceUrl != null))
        store.get(owner.uid, operationId)?.let { existing ->
            require(existing.sourceKind == sourceKind && existing.sourceUrl == sourceUrl)
            return@withLock existing
        }
        val acceptedAt = now()
        ProcessingOperation(
            operationId = operationId,
            ownerUid = owner.uid,
            requestId = operationId,
            displayName = normalizedTitle.substringBeforeLast('.').ifBlank { normalizedTitle },
            sourceKind = sourceKind,
            sourceTitle = normalizedTitle.substringBeforeLast('.').ifBlank { normalizedTitle },
            sourceUrl = sourceUrl,
            clientStartedAtMillis = acceptedAt,
            acceptedAtMillis = acceptedAt,
            phase = if (sourceKind == SourceKind.URL) ProcessingPhase.DOWNLOADING_SOURCE else ProcessingPhase.PREPARING_INPUT,
        ).also { store.put(owner.uid, it) }
    }

    suspend fun submit(
        prepared: PreparedInput,
        expectedSourceWorkRequestId: String? = null,
        requireCloudConsent: Boolean = false,
    ): ProcessingOperation = submitLock.withLock {
        requireUpdateAllowed()
        val owner = requireSession()
        if (prepared.ownerUid != owner.uid) changedSession()
        require(UUID.fromString(prepared.operationId).toString() == prepared.operationId)
        val relative = withContext(Dispatchers.IO) {
            val file = prepared.file.canonicalFile
            val directory = processingOwnerDirectory(stagingRoot, owner.uid).canonicalFile
            require(file.toPath().startsWith(directory.toPath()))
            stagingRoot.canonicalFile.toPath().relativize(file.toPath()).toString()
        }
        checkSession(owner)
        val existing = store.get(owner.uid, prepared.operationId)
        checkSession(owner)
        if (existing?.input != null) {
            require(existing.input == prepared.declaration && existing.stagedRelativePath == relative)
            if (expectedSourceWorkRequestId != null &&
                existing.sourceWorkRequestId != expectedSourceWorkRequestId) changedSession()
            return@withLock existing
        }
        val candidate = if (existing == null) ProcessingOperation(
            prepared.operationId, owner.uid, prepared.operationId,
            prepared.declaration, relative, prepared.displayName.substringBeforeLast('.'),
            mediaPolicy = prepared.mediaPolicy, mediaSource = prepared.mediaSource,
            sourceKind = SourceKind.FILE,
            sourceTitle = prepared.displayName.substringBeforeLast('.'),
            clientStartedAtMillis = now(), acceptedAtMillis = now(),
            phase = if (requireCloudConsent) ProcessingPhase.PAUSED else ProcessingPhase.WAITING,
            awaitingCloudConsent = requireCloudConsent,
        ) else existing.copy(
            input = prepared.declaration,
            mediaPolicy = prepared.mediaPolicy, mediaSource = prepared.mediaSource,
            stagedRelativePath = relative,
            displayName = existing.displayName.ifBlank { prepared.displayName.substringBeforeLast('.') },
            sourceTitle = existing.sourceTitle.ifBlank { prepared.displayName.substringBeforeLast('.') },
            phase = if (requireCloudConsent) ProcessingPhase.PAUSED else ProcessingPhase.WAITING,
            awaitingCloudConsent = requireCloudConsent,
            localProblem = null,
        )
        verifyInput(candidate)
        checkSession(owner)
        val operation = if (existing == null) {
            store.put(owner.uid, candidate)
            candidate
        } else {
            store.update(owner.uid, prepared.operationId) { latest ->
                checkSession(owner)
                if (expectedSourceWorkRequestId != null &&
                    latest.sourceWorkRequestId != expectedSourceWorkRequestId) changedSession()
                if (latest.cancellationRequested || latest.pendingDelete) latest
                else latest.copy(
                    input = prepared.declaration,
                    mediaPolicy = prepared.mediaPolicy, mediaSource = prepared.mediaSource,
                    stagedRelativePath = relative,
                    displayName = latest.displayName.ifBlank { prepared.displayName.substringBeforeLast('.') },
                    sourceTitle = latest.sourceTitle.ifBlank { prepared.displayName.substringBeforeLast('.') },
                    phase = if (requireCloudConsent) ProcessingPhase.PAUSED else ProcessingPhase.WAITING,
                    awaitingCloudConsent = requireCloudConsent,
                    localProblem = null,
                )
            } ?: changedSession()
        }
        checkSession(owner)
        if (!operation.awaitingCloudConsent && !operation.cancellationRequested && !operation.pendingDelete && operation.input != null)
            schedule(owner, operation)
        operation
    }

    suspend fun confirmCloudProcessing(operationId: String, rightsConfirmed: Boolean) {
        requireUpdateAllowed()
        require(rightsConfirmed)
        val owner = requireSession()
        store.update(owner.uid, operationId) {
            checkSession(owner)
            require(it.input != null && !it.cancellationRequested && !it.pendingDelete)
            if (it.awaitingCloudConsent) it.copy(awaitingCloudConsent = false, phase = ProcessingPhase.WAITING) else it
        } ?: return
        checkSession(owner)
        resume(operationId)
    }

    suspend fun resume(operationId: String) {
        requireUpdateAllowed()
        val owner = requireSession()
        val operation = store.get(owner.uid, operationId) ?: return
        checkSession(owner)
        if (operation.awaitingCloudConsent || (operation.phase == ProcessingPhase.COMPLETE && !operation.cancellationRequested)) return
        store.update(owner.uid, operationId) {
            checkSession(owner)
            it.copy(phase = ProcessingPhase.WAITING, runId = null, problem = null,
                localProblem = null, transientRetryCount = 0)
        }
        checkSession(owner)
        stopRun(owner, operationId)
        checkSession(owner)
        schedule(owner, operation)
    }

    /** Resume interrupted client work after this owner has completed session bootstrap.
     * Explicitly paused/exhausted operations require a user action.
     */
    suspend fun resumePending() {
        if (updateBlocked()) return
        val owner = requireSession()
        val operations = store.operations(owner.uid).first()
        checkSession(owner)
        for (operation in operations) {
            if ((operation.phase in setOf(ProcessingPhase.WAITING, ProcessingPhase.RESERVING,
                    ProcessingPhase.UPLOADING, ProcessingPhase.CONFIRMING,
                    ProcessingPhase.CANCELLING, ProcessingPhase.RETRY_WAIT) ||
                    (operation.phase == ProcessingPhase.SOURCE_QUEUED && operation.input != null)) &&
                operation.localProblem == null
            ) {
                checkSession(owner)
                schedule(owner, operation)
            }
        }
    }

    suspend fun stopLocalTransfer(operationId: String) {
        val owner = requireSession()
        store.update(owner.uid, operationId) {
            checkSession(owner)
            if (it.phase == ProcessingPhase.COMPLETE) it
            else it.copy(phase = ProcessingPhase.PAUSED, runId = null)
        }
        checkSession(owner)
        stopRun(owner, operationId)
    }

    /** Pause only client-side reservation/upload work for a mandatory app update.
     * Server jobs, staged inputs, request IDs and user cancellation intent are preserved.
     */
    suspend fun pauseForUpdate() {
        val owner = session() ?: return
        val restartable =
            setOf(
                ProcessingPhase.WAITING,
                ProcessingPhase.RESERVING,
                ProcessingPhase.UPLOADING,
                ProcessingPhase.CONFIRMING,
                ProcessingPhase.RETRY_WAIT,
                ProcessingPhase.CANCELLING,
            )
        val operations = store.operations(owner.uid).first().filter { it.phase in restartable }
        for (operation in operations) {
            checkSession(owner)
            activeRuns[key(owner.uid, operation.operationId)]?.job?.cancelAndJoin()
            checkSession(owner)
            store.update(owner.uid, operation.operationId) {
                if (it.phase !in restartable) it
                else
                    it.copy(
                        phase = ProcessingPhase.WAITING,
                        runId = null,
                        problem = JobsProblem.APP_UPDATE_REQUIRED,
                    )
            }
            checkSession(owner)
            scheduler.cancel(owner.uid, operation.operationId)
        }
    }

    /** Resolve an uncertain reservation with its saved request ID before cancelling it. */
    suspend fun requestCancellation(operationId: String): ProcessingOperation? {
        val owner = requireSession()
        return store.update(owner.uid, operationId) {
            checkSession(owner)
            it.copy(cancellationRequested = true, phase = ProcessingPhase.CANCELLING, runId = null)
        }
    }

    suspend fun cancelOperation(operationId: String) {
        val owner = requireSession()
        val operation = requestCancellation(operationId) ?: return
        checkSession(owner)
        stopRun(owner, operation.operationId)
        checkSession(owner)
        if (runUpload(owner.uid, operation.operationId, owner.epoch) == ProcessingRunResult.RETRY) {
            val pending = store.get(owner.uid, operation.operationId) ?: return
            checkSession(owner)
            schedule(owner, pending)
        }
    }

    suspend fun cancel(jobId: String): JobMutation {
        val owner = requireSession()
        val operation = store.operations(owner.uid).first().find { it.jobId == jobId }
        checkSession(owner)
        if (operation == null) {
            val result = api.cancel(jobId)
            checkSession(owner)
            return result
        }
        cancelOperation(operation.operationId)
        checkSession(owner)
        val updated = store.get(owner.uid, operation.operationId) ?: changedSession()
        checkSession(owner)
        if (updated.phase != ProcessingPhase.COMPLETE) throw JobsFailure(updated.problem ?: JobsProblem.SERVICE_UNAVAILABLE)
        return JobMutation(jobId, updated.serverStatus ?: "cancel_requested")
    }

    suspend fun retry(jobId: String): ProcessingOperation = submitLock.withLock {
        requireUpdateAllowed()
        val owner = requireSession()
        val existing = store.operations(owner.uid).first().find { it.retryOfJobId == jobId }
        checkSession(owner)
        if (existing != null) {
            if (existing.phase != ProcessingPhase.COMPLETE) schedule(owner, existing)
            return@withLock existing
        }
        val original = api.detail(jobId)
        checkSession(owner)
        if (original.status != "failed") throw JobsFailure(JobsProblem.JOB_STATE_CONFLICT)
        val requestId = UUID.randomUUID().toString()
        val operation = ProcessingOperation(
            operationId = requestId,
            ownerUid = owner.uid,
            requestId = requestId,
            displayName = original.displayName ?: original.sourceTitle.orEmpty(),
            retryOfJobId = jobId,
            sourceKind = original.sourceKind?.let { kind -> SourceKind.entries.find { it.wireValue == kind } },
            sourceTitle = original.sourceTitle.orEmpty(),
            clientStartedAtMillis = now(),
            acceptedAtMillis = now(),
        )
        store.put(owner.uid, operation)
        checkSession(owner)
        schedule(owner, operation)
        operation
    }

    suspend fun purgeOwner(uid: String) {
        activeRuns.values.filter { it.session.uid == uid }.forEach { it.job.cancelAndJoin() }
        scheduler.cancelOwner(uid)
    }

    suspend fun onSessionChanged() {
        val current = session()
        val old = previousSession
        previousSession = current
        activeRuns.values.filter { it.session != current }.forEach { it.job.cancelAndJoin() }
        if (old != null && old != current) scheduler.cancelSession(old.uid, old.epoch)
    }

    suspend fun runUpload(ownerUid: String, operationId: String, epoch: Long, attempt: Int = 0): ProcessingRunResult {
        val owner = ProcessingSession(ownerUid, epoch)
        checkSession(owner)
        if (updateBlocked()) {
            store.update(ownerUid, operationId) {
                if (it.phase == ProcessingPhase.COMPLETE) it
                else
                    it.copy(
                        phase = ProcessingPhase.WAITING,
                        runId = null,
                        problem = JobsProblem.APP_UPDATE_REQUIRED,
                    )
            }
            return ProcessingRunResult.PAUSED
        }
        val key = key(ownerUid, operationId)
        return runLocks.computeIfAbsent(key) { Mutex() }.withLock {
            coroutineScope {
                checkSession(owner)
                val initial = store.get(ownerUid, operationId) ?: return@coroutineScope ProcessingRunResult.PAUSED
                checkSession(owner)
                if (initial.awaitingCloudConsent && !initial.cancellationRequested) return@coroutineScope ProcessingRunResult.PAUSED
                if (initial.phase == ProcessingPhase.COMPLETE && !initial.cancellationRequested) return@coroutineScope ProcessingRunResult.COMPLETE
                if (initial.retryNotBeforeMillis > now()) return@coroutineScope ProcessingRunResult.RETRY
                val runId = UUID.randomUUID().toString()
                val running = ActiveRun(owner, currentCoroutineContext()[CoroutineJob]!!)
                activeRuns[key] = running
                try {
                    store.update(ownerUid, operationId) {
                        checkSession(owner)
                        it.copy(runId = runId, problem = null, localProblem = null)
                    }
                    process(owner, operationId, runId)
                } catch (error: CancellationException) {
                    throw error
                } catch (error: ProcessingTransferException) {
                    change(owner, operationId, runId) { it.copy(phase = ProcessingPhase.PAUSED, localProblem = error.problem) }
                    ProcessingRunResult.PAUSED
                } catch (error: JobsFailure) {
                    recordFailure(owner, operationId, runId, error, attempt)
                } catch (_: IOException) {
                    recordFailure(owner, operationId, runId, JobsFailure(JobsProblem.OFFLINE), attempt)
                } finally {
                    activeRuns.remove(key, running)
                }
            }
        }
    }

    private suspend fun process(owner: ProcessingSession, operationId: String, runId: String): ProcessingRunResult {
        var operation = current(owner, operationId, runId)
        var grant: UploadGrant? = null
        if (operation.jobId == null) {
            if (operation.cancellationRequested && !operation.reservationAttempted) {
                change(owner, operationId, runId) {
                    it.copy(phase = ProcessingPhase.COMPLETE, serverStatus = "cancelled")
                }
                withContext(Dispatchers.IO) { PreparedMediaCleanup(stagingRoot).abandonedBeforeReservation(operation) }
                return ProcessingRunResult.COMPLETE
            }
            if (operation.retryOfJobId == null && !operation.cancellationRequested) verifyInput(operation)
            change(owner, operationId, runId) {
                it.copy(phase = ProcessingPhase.RESERVING, reservationAttempted = true)
            }
            if (operation.retryOfJobId != null) {
                val result = api.retry(operation.retryOfJobId, operation.requestId)
                operation = change(owner, operationId, runId) { it.copy(jobId = result.id, serverStatus = result.status) }
            } else {
                val result = api.createWithMetadata(
                    operation.requestId,
                    operation.input ?: throw ProcessingTransferException(ProcessingLocalProblem.INPUT_CHANGED),
                    CreateJobMetadata(
                        operation.sourceTitle.takeIf { it.isNotBlank() },
                        operation.sourceKind,
                        operation.clientStartedAtMillis.takeIf { it > 0 }?.let(java.time.Instant::ofEpochMilli),
                        operation.sourceUrl,
                        operation.mediaPolicy.version.takeIf { it == 2 },
                        operation.mediaPolicy.profileId,
                        operation.mediaSource.takeIf { operation.mediaPolicy.version == 2 },
                    ),
                )
                if (result.requestId != null && result.requestId != operation.requestId)
                    throw JobsFailure(JobsProblem.IDEMPOTENCY_CONFLICT)
                operation = change(owner, operationId, runId) { it.copy(jobId = result.id, serverStatus = result.status) }
                grant = result.upload
                if (operation.displayName.isNotBlank() && operation.displayName != operation.sourceTitle) {
                    val renamed = api.rename(result.id, operation.displayName)
                    operation = change(owner, operationId, runId) { it.copy(serverStatus = renamed.status) }
                }
            }
        } else {
            val detail = api.detail(operation.jobId)
            operation = change(owner, operationId, runId) { it.copy(serverStatus = detail.status) }
        }
        val jobId = operation.jobId ?: throw JobsFailure(JobsProblem.SERVICE_UNAVAILABLE)
        if (operation.cancellationRequested) {
            change(owner, operationId, runId) { it.copy(phase = ProcessingPhase.CANCELLING) }
            val result = try { api.cancel(jobId) } catch (error: JobsFailure) {
                if (error.problem != JobsProblem.JOB_STATE_CONFLICT) throw error
                val detail = api.detail(jobId)
                checkSession(owner)
                JobMutation(jobId, detail.status)
            }
            change(owner, operationId, runId) { it.copy(phase = ProcessingPhase.COMPLETE, serverStatus = result.status) }
            return ProcessingRunResult.COMPLETE
        }
        if (operation.serverStatus != "awaiting_upload") return finishKnown(owner, operationId, runId, operation.serverStatus)

        // Confirmation always precedes any renewed grant or repeat of a whole-file transfer.
        change(owner, operationId, runId) { it.copy(phase = ProcessingPhase.CONFIRMING) }
        try {
            val confirmed = api.confirmUpload(jobId)
            change(owner, operationId, runId) { it.copy(serverStatus = confirmed.status) }
            return finishKnown(owner, operationId, runId, confirmed.status)
        } catch (error: JobsFailure) {
            checkSession(owner)
            if (error.problem == JobsProblem.JOB_STATE_CONFLICT) {
                val detail = api.detail(jobId)
                change(owner, operationId, runId) { it.copy(serverStatus = detail.status) }
                if (detail.status != "awaiting_upload") return finishKnown(owner, operationId, runId, detail.status)
                throw error
            }
            if (error.problem != JobsProblem.UPLOAD_NOT_READY) throw error
        }
        operation = current(owner, operationId, runId)
        val file = verifyInput(operation)
        current(owner, operationId, runId)
        if (grant == null) {
            grant = api.renewUpload(jobId)
            current(owner, operationId, runId)
        }
        val uploadGrant = grant ?: throw JobsFailure(JobsProblem.SERVICE_UNAVAILABLE)
        val declaration = operation.input ?: throw ProcessingTransferException(ProcessingLocalProblem.INPUT_CHANGED)
        change(owner, operationId, runId) { it.copy(phase = ProcessingPhase.UPLOADING, uploadedBytes = 0) }
        coroutineScope {
            val progress = Channel<Long>(Channel.CONFLATED)
            val reporter = launch {
                var lastWrite = 0L
                for (sent in progress) {
                    if (now() - lastWrite >= 250 || sent == declaration.bytes) {
                        change(owner, operationId, runId) { it.copy(uploadedBytes = sent.coerceIn(0, declaration.bytes)) }
                        lastWrite = now()
                    }
                }
            }
            try {
                uploader.upload(file, declaration, uploadGrant) { sent, _ -> progress.trySend(sent) }
            } finally {
                progress.close()
                reporter.join()
            }
        }
        change(owner, operationId, runId) { it.copy(phase = ProcessingPhase.CONFIRMING) }
        val result = try { api.confirmUpload(jobId) } catch (error: JobsFailure) {
            if (error.problem != JobsProblem.JOB_STATE_CONFLICT) throw error
            val detail = api.detail(jobId)
            checkSession(owner)
            if (detail.status == "awaiting_upload") throw error
            JobMutation(jobId, detail.status)
        }
        change(owner, operationId, runId) { it.copy(serverStatus = result.status) }
        return finishKnown(owner, operationId, runId, result.status)
    }

    private suspend fun finishKnown(owner: ProcessingSession, operationId: String, runId: String, status: String?): ProcessingRunResult {
        if (status == "awaiting_upload") throw JobsFailure(JobsProblem.JOB_STATE_CONFLICT)
        val known = JobStatus.entries.any { it.wireValue == status }
        change(owner, operationId, runId) {
            it.copy(phase = if (known) ProcessingPhase.COMPLETE else ProcessingPhase.PAUSED,
                localProblem = if (known) null else ProcessingLocalProblem.UNKNOWN_STATE)
        }
        if (known) {
            val confirmed = current(owner, operationId, runId).copy(serverStatus = status)
            withContext(Dispatchers.IO) { runCatching { PreparedMediaCleanup(stagingRoot).afterConfirmedUpload(confirmed) } }
        }
        return if (known) ProcessingRunResult.COMPLETE else ProcessingRunResult.PAUSED
    }

    private suspend fun recordFailure(owner: ProcessingSession, operationId: String, runId: String, error: JobsFailure, attempt: Int): ProcessingRunResult {
        val retryable = error.problem in setOf(JobsProblem.OFFLINE, JobsProblem.SERVICE_UNAVAILABLE, JobsProblem.RATE_LIMITED)
        val current = current(owner, operationId, runId)
        val offline = error.problem == JobsProblem.OFFLINE
        val retry = retryable && (offline || current.transientRetryCount < MAX_ATTEMPTS - 1)
        change(owner, operationId, runId) {
            it.copy(phase = if (retry) ProcessingPhase.RETRY_WAIT else ProcessingPhase.PAUSED,
                problem = error.problem,
                localProblem = if (retryable && !retry) ProcessingLocalProblem.RETRY_EXHAUSTED else null,
                transientRetryCount = if (retry && !offline) it.transientRetryCount + 1 else it.transientRetryCount,
                retryNotBeforeMillis = error.retryAfterSeconds?.let { seconds -> now() + seconds * 1000 }
                    ?: 0)
        }
        return if (retry) ProcessingRunResult.RETRY else ProcessingRunResult.PAUSED
    }

    private suspend fun verifyInput(operation: ProcessingOperation): File = withContext(Dispatchers.IO) {
        val input = operation.input ?: throw ProcessingTransferException(ProcessingLocalProblem.INPUT_CHANGED)
        val relative = operation.stagedRelativePath ?: throw ProcessingTransferException(ProcessingLocalProblem.INPUT_CHANGED)
        val file = File(stagingRoot, relative).canonicalFile
        val owner = processingOwnerDirectory(stagingRoot, operation.ownerUid).canonicalFile
        if (!file.toPath().startsWith(owner.toPath()) || !file.isFile || !file.canRead() ||
            file.length() != input.bytes || !operation.mediaPolicy.acceptsPrepared(input.bytes, input.durationSeconds)
        ) throw ProcessingTransferException(ProcessingLocalProblem.INPUT_CHANGED)
        if (availableSpace() < 1_048_576) throw ProcessingTransferException(ProcessingLocalProblem.STORAGE)
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { stream ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                currentCoroutineContext().ensureActive()
                val count = stream.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        if (Base64.getEncoder().encodeToString(digest.digest()) != input.sha256)
            throw ProcessingTransferException(ProcessingLocalProblem.INPUT_CHANGED)
        file
    }

    private suspend fun current(owner: ProcessingSession, operationId: String, runId: String): ProcessingOperation {
        currentCoroutineContext().ensureActive()
        checkSession(owner)
        val result = store.get(owner.uid, operationId) ?: changedSession()
        checkSession(owner)
        if (result.runId != runId) changedSession()
        return result
    }

    private suspend fun change(owner: ProcessingSession, operationId: String, runId: String, transform: (ProcessingOperation) -> ProcessingOperation): ProcessingOperation {
        currentCoroutineContext().ensureActive()
        checkSession(owner)
        val result = store.update(owner.uid, operationId) {
            checkSession(owner)
            if (it.runId != runId) changedSession()
            transform(it)
        } ?: changedSession()
        checkSession(owner)
        return result
    }

    private suspend fun schedule(owner: ProcessingSession, operation: ProcessingOperation) {
        checkSession(owner)
        try {
            scheduler.enqueueAfter(owner.uid, operation.operationId, owner.epoch, (operation.retryNotBeforeMillis - now()).coerceAtLeast(0))
            checkSession(owner)
        } catch (error: CancellationException) { throw error } catch (error: Exception) {
            store.update(owner.uid, operation.operationId) {
                checkSession(owner)
                it.copy(phase = ProcessingPhase.PAUSED, localProblem = ProcessingLocalProblem.STORAGE)
            }
            throw error
        }
    }

    private suspend fun stopRun(owner: ProcessingSession, operationId: String) {
        activeRuns[key(owner.uid, operationId)]?.job?.cancelAndJoin()
        checkSession(owner)
        scheduler.cancel(owner.uid, operationId)
    }

    fun isCurrentSession(ownerUid: String, epoch: Long): Boolean = session() == ProcessingSession(ownerUid, epoch)

    suspend fun markLocalFailure(operationId: String, problem: ProcessingLocalProblem) {
        val owner = requireSession()
        store.update(owner.uid, operationId) {
            checkSession(owner)
            if (it.cancellationRequested || it.pendingDelete) it
            else it.copy(phase = ProcessingPhase.PAUSED, localProblem = problem)
        }
    }

    suspend fun updateSourceTitle(operationId: String, sourceTitle: String): ProcessingOperation? {
        val owner = requireSession()
        val safe = boundedSourceTitle(sourceTitle)
        return store.update(owner.uid, operationId) {
            checkSession(owner)
            it.copy(
                sourceTitle = safe,
                displayName = if (it.displayName.isBlank() || it.displayName == "Audio") safe else it.displayName,
            )
        }
    }

    suspend fun renameOperation(operationId: String, displayName: String): Job? {
        val owner = requireSession()
        val safe = validateDisplayName(displayName)
        val operation = store.update(owner.uid, operationId) {
            checkSession(owner)
            it.copy(displayName = safe)
        } ?: return null
        checkSession(owner)
        return operation.jobId?.let { api.rename(it, safe).also { checkSession(owner) } }
    }

    suspend fun renameJob(jobId: String, displayName: String): Job {
        val owner = requireSession()
        val result = api.rename(jobId, displayName)
        checkSession(owner)
        store.updateLibraryJob(owner.uid, result)
        store.operations(owner.uid).first().firstOrNull { it.jobId == jobId }?.let { operation ->
            store.update(owner.uid, operation.operationId) {
                it.copy(displayName = result.displayName ?: displayName.trim())
            }
        }
        return result
    }

    suspend fun deleteJob(jobId: String) {
        val owner = requireSession()
        val operation = store.operations(owner.uid).first().firstOrNull { it.jobId == jobId }
        operation?.let { stored ->
            store.update(owner.uid, stored.operationId) { it.copy(pendingDelete = true) }
        }
        try {
            api.delete(jobId)
            checkSession(owner)
            store.removeLibraryJob(owner.uid, jobId)
            operation?.let { store.removeOperation(owner.uid, it.operationId) }
        } catch (error: JobsFailure) {
            if (error.problem == JobsProblem.JOB_NOT_FOUND) {
                checkSession(owner)
                store.removeLibraryJob(owner.uid, jobId)
                operation?.let { store.removeOperation(owner.uid, it.operationId) }
            } else throw error
        }
    }

    suspend fun deleteOperation(operationId: String) {
        val owner = requireSession()
        val operation = store.get(owner.uid, operationId) ?: return
        require(operation.jobId == null)
        stopRun(owner, operationId)
        checkSession(owner)
        store.removeOperation(owner.uid, operationId)
        withContext(Dispatchers.IO) {
            File(processingOwnerDirectory(stagingRoot, owner.uid), operationId).deleteRecursively()
        }
    }

    private fun requireSession(): ProcessingSession = session() ?: throw JobsFailure(JobsProblem.UNAUTHENTICATED)
    fun requireUpdateAllowed() {
        if (updateBlocked()) throw JobsFailure(JobsProblem.APP_UPDATE_REQUIRED)
    }
    private fun checkSession(expected: ProcessingSession) { if (session() != expected) changedSession() }
    private fun changedSession(): Nothing = throw CancellationException("Processing session changed")
    private fun key(uid: String, operationId: String) = "$uid:$operationId"

    companion object { const val MAX_ATTEMPTS = 4 }
}
