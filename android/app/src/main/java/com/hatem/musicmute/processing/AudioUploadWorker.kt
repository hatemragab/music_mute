package com.hatem.musicmute.processing

import android.content.Context
import android.os.Build
import android.os.SystemClock
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.hatem.musicmute.VocalApplication
import com.hatem.musicmute.BuildConfig
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

interface ProcessingWorkerHost { val processingRepository: ProcessingRepository }

class WorkManagerProcessingScheduler(context: Context) : ProcessingScheduler {
    private val work = WorkManager.getInstance(context)

    override suspend fun enqueue(ownerUid: String, operationId: String, epoch: Long) =
        enqueueAfter(ownerUid, operationId, epoch, 0)

    override suspend fun enqueueAfter(ownerUid: String, operationId: String, epoch: Long, delayMillis: Long) {
        val request = OneTimeWorkRequestBuilder<AudioUploadWorker>()
            .setInputData(workDataOf(KEY_OWNER to ownerUid, KEY_OPERATION to operationId, KEY_EPOCH to epoch))
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setInitialDelay(delayMillis.coerceAtLeast(0), TimeUnit.MILLISECONDS)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .addTag(workName(ownerUid, operationId))
            .addTag(ownerTag(ownerUid))
            .addTag(sessionTag(ownerUid, epoch))
            .build()
        withContext(Dispatchers.IO) {
            work.enqueueUniqueWork("${workName(ownerUid, operationId)}-$epoch", ExistingWorkPolicy.KEEP, request).result.get()
        }
    }

    override suspend fun cancel(ownerUid: String, operationId: String) {
        withContext(Dispatchers.IO) { work.cancelAllWorkByTag(workName(ownerUid, operationId)).result.get() }
    }

    override suspend fun cancelOwner(ownerUid: String) {
        withContext(Dispatchers.IO) { work.cancelAllWorkByTag(ownerTag(ownerUid)).result.get() }
    }

    override suspend fun cancelSession(ownerUid: String, epoch: Long) {
        withContext(Dispatchers.IO) { work.cancelAllWorkByTag(sessionTag(ownerUid, epoch)).result.get() }
    }

    companion object {
        const val KEY_OWNER = "processing_owner"
        const val KEY_OPERATION = "processing_operation"
        const val KEY_EPOCH = "processing_epoch"
        private fun ownerTag(uid: String) = "processing-${processingOwnerDirectory(java.io.File("."), uid).name}"
        private fun sessionTag(uid: String, epoch: Long) = "${ownerTag(uid)}-session-$epoch"
        fun workName(uid: String, operationId: String) = "${ownerTag(uid)}-$operationId"
    }
}

class AudioUploadWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun getForegroundInfo(): ForegroundInfo {
        val target = target()
        val repository = (applicationContext as? ProcessingWorkerHost)?.processingRepository
        val operation = if (repository?.isCurrentSession(target.ownerUid, target.epoch) == true)
            repository.store.get(target.ownerUid, target.operationId) else null
        val state = operation ?: ProcessingOperation(target.operationId, target.ownerUid, target.operationId)
        return AudioTaskNotifications(applicationContext).foreground(target.copy(jobId = operation?.jobId),
            audioTaskNotificationProjection(state, target))
    }

    private fun target() = AudioTaskNotificationTarget(
        inputData.getString(WorkManagerProcessingScheduler.KEY_OWNER).orEmpty(),
        inputData.getString(WorkManagerProcessingScheduler.KEY_OPERATION) ?: id.toString(),
        inputData.getLong(WorkManagerProcessingScheduler.KEY_EPOCH, Long.MIN_VALUE),
        workRequestId = id.toString(),
    )

    override suspend fun doWork(): Result {
        val owner = inputData.getString(WorkManagerProcessingScheduler.KEY_OWNER) ?: return Result.failure()
        val operation = inputData.getString(WorkManagerProcessingScheduler.KEY_OPERATION) ?: return Result.failure()
        val epoch = inputData.getLong(WorkManagerProcessingScheduler.KEY_EPOCH, Long.MIN_VALUE)
        val repository = (applicationContext as? ProcessingWorkerHost)?.processingRepository ?: return Result.failure()
        val app = applicationContext as? VocalApplication ?: return Result.failure()
        if (!repository.isCurrentSession(owner, epoch)) return Result.failure()
        return try {
            app.audioPipelineCoordinator.withLocalSlot(owner, epoch) {
                setForeground(getForegroundInfo())
                coroutineScope {
                    val notifications = AudioTaskNotifications(applicationContext)
                    val throttle = AudioTaskNotificationThrottle()
                    val reporter = launch {
                        repository.store.operations(owner).catch { error ->
                            if (error is CancellationException) throw error
                        }.collect { operations ->
                            if (!repository.isCurrentSession(owner, epoch)) return@collect
                            val current = operations.find { it.operationId == operation } ?: return@collect
                            val target = target().copy(jobId = current.jobId)
                            val projection = audioTaskNotificationProjection(current, target)
                            if (throttle.shouldUpdate(projection, SystemClock.elapsedRealtime()))
                                notifications.updateIfVisible(target, projection)
                        }
                    }
                    try {
                        when (repository.runUpload(owner, operation, epoch, runAttemptCount)) {
                            ProcessingRunResult.COMPLETE -> Result.success()
                            ProcessingRunResult.RETRY -> Result.retry()
                            ProcessingRunResult.PAUSED -> {
                                captureFailure(app, owner, operation, epoch)
                                Result.failure()
                            }
                        }
                    } finally {
                        reporter.cancelAndJoin()
                    }
                }
            }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            if (runAttemptCount < ProcessingRepository.MAX_ATTEMPTS - 1) Result.retry() else Result.failure()
        }
    }

    private suspend fun captureFailure(
        app: VocalApplication,
        owner: String,
        operationId: String,
        epoch: Long,
    ) {
        val operation = app.processingRepository.store.get(owner, operationId) ?: return
        if (!app.processingRepository.isCurrentSession(owner, epoch) ||
            operation.cancellationRequested || operation.pendingDelete) return
        val code = when {
            operation.localProblem == ProcessingLocalProblem.INPUT_CHANGED -> ClientErrorCode.INVALID_MEDIA
            operation.localProblem == ProcessingLocalProblem.STORAGE -> ClientErrorCode.STORAGE
            operation.problem == JobsProblem.OFFLINE -> ClientErrorCode.NETWORK
            operation.problem == JobsProblem.UNAUTHENTICATED -> ClientErrorCode.AUTHENTICATION
            operation.problem == JobsProblem.JOB_NOT_FOUND -> ClientErrorCode.JOB_NOT_FOUND
            operation.problem in setOf(JobsProblem.JOB_STATE_CONFLICT, JobsProblem.IDEMPOTENCY_CONFLICT) ->
                ClientErrorCode.JOB_CONFLICT
            else -> ClientErrorCode.SERVER
        }
        val stage = when {
            operation.jobId == null -> ClientErrorStage.RESERVING_JOB
            operation.serverStatus == "awaiting_upload" && operation.uploadedBytes > 0 ->
                ClientErrorStage.CONFIRMING_UPLOAD
            else -> ClientErrorStage.UPLOADING_INPUT
        }
        try {
            app.clientErrorOutbox.capture(
                operationId,
                operation.jobId,
                stage,
                code,
                operation.problem in setOf(
                    JobsProblem.OFFLINE,
                    JobsProblem.SERVICE_UNAVAILABLE,
                    JobsProblem.RATE_LIMITED,
                ),
                BuildConfig.VERSION_NAME,
                Build.VERSION.RELEASE,
            )
        } catch (_: Exception) {
            // Diagnostics remain best effort and never change the task result.
        }
    }

}
