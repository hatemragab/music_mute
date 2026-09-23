package com.hatem.musicmute.processing

import android.content.Context
import android.net.Uri
import androidx.work.*
import com.hatem.musicmute.VocalApplication
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

interface MediaPreparationScheduler {
    suspend fun enqueue(ownerUid: String, operationId: String, epoch: Long)
    suspend fun cancel(ownerUid: String, operationId: String)
    suspend fun cancelOwner(ownerUid: String)
}
class WorkManagerMediaPreparationScheduler(context: Context) : MediaPreparationScheduler {
    private val work = WorkManager.getInstance(context)
    private fun ownerTag(uid: String) = "media-preparation-${processingOwnerDirectory(File("."), uid).name}"
    private fun tag(uid: String, id: String) = "${ownerTag(uid)}-$id"
    override suspend fun enqueue(ownerUid: String, operationId: String, epoch: Long) = withContext(Dispatchers.IO) {
        val request = OneTimeWorkRequestBuilder<MediaPreparationWorker>()
            .setInputData(workDataOf("owner" to ownerUid, "operation" to operationId, "epoch" to epoch))
            .addTag(ownerTag(ownerUid)).addTag(tag(ownerUid, operationId)).build()
        work.enqueueUniqueWork("${tag(ownerUid, operationId)}-$epoch", ExistingWorkPolicy.KEEP, request).result.get()
        Unit
    }
    override suspend fun cancel(ownerUid: String, operationId: String) = withContext(Dispatchers.IO) {
        work.cancelAllWorkByTag(tag(ownerUid, operationId)).result.get(); Unit
    }
    override suspend fun cancelOwner(ownerUid: String) = withContext(Dispatchers.IO) {
        work.cancelAllWorkByTag(ownerTag(ownerUid)).result.get(); Unit
    }
}

class MediaPreparationWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val app = applicationContext as? VocalApplication ?: return Result.failure()
        val owner = inputData.getString("owner") ?: return Result.failure()
        val operationId = inputData.getString("operation") ?: return Result.failure()
        val epoch = inputData.getLong("epoch", Long.MIN_VALUE)
        val repository = app.processingRepository
        fun checkOwner() {
            if (!repository.isCurrentSession(owner, epoch)) throw CancellationException("Processing session changed")
        }
        checkOwner()
        val operation = repository.store.get(owner, operationId) ?: return Result.failure()
        if (operation.cancellationRequested || operation.pendingDelete || operation.input != null) return Result.success()
        if (runAttemptCount >= 3) {
            repository.store.update(owner, operationId) { it.copy(phase = ProcessingPhase.PAUSED, localProblem = ProcessingLocalProblem.RETRY_EXHAUSTED) }
            return Result.failure()
        }
        val uri = operation.sourceUri?.let(Uri::parse) ?: return Result.failure()
        val name = operation.sourceName ?: return Result.failure()
        val temporary = File(File(processingOwnerDirectory(app.processingStagingRoot, owner), operationId), ".export-$id.m4a")
        return try {
            app.audioPipelineCoordinator.withLocalSlot(owner, epoch) {
                withContext(Dispatchers.IO) {
                    temporary.parentFile?.listFiles()?.filter { it.isFile && it.name.startsWith(".export-") && it != temporary }?.forEach { it.delete() }
                }
                val target = AudioTaskNotificationTarget(owner, operationId, epoch, workRequestId = id.toString())
                setForeground(AudioTaskNotifications(applicationContext).foreground(target, audioTaskNotificationProjection(operation, target)))
                val fetched = try { app.jobsApi.mediaPolicy() } catch (error: JobsFailure) {
                    if (error.problem in setOf(JobsProblem.JOB_NOT_FOUND, JobsProblem.OFFLINE)) ProcessingMediaPolicy.STANDARD else throw error
                }
                if (!fetched.acceptNewJobs || !fetched.localPreparationReady)
                    throw JobsFailure(JobsProblem.PROCESSING_CAPACITY_UNAVAILABLE)
                val policy = fetched
                checkOwner()
                repository.store.update(owner, operationId) { it.copy(mediaPolicy = policy, phase = ProcessingPhase.INSPECTING) }
                val engine = AudioPreparationEngine(applicationContext)
                val prepared = withTimeout((policy.maxPreparationSeconds ?: 120).coerceAtMost(3600) * 1000) {
                    app.audioInputPreparer.recover(owner, operationId, name, policy, operation.mediaSource)?.let { return@withTimeout it }
                    val inspection = engine.inspect(uri)
                    if (!policy.acceptsDuration(inspection.audio.durationSeconds)) throw InputPreparationException(InputPreparationError.TOO_LONG)
                    policy.requireLongJobAvailable(inspection.audio.durationSeconds)
                    val sourceKind = if (inspection.hasVideo) "video_file" else "audio_file"
                    repository.store.update(owner, operationId) { it.copy(mediaSource = sourceKind, phase = ProcessingPhase.PREPARING_INPUT) }
                    val canCopy = !inspection.hasVideo && inspection.audioTrackCount == 1 &&
                        inspection.audio.bitRate != null && inspection.audio.bitRate <= 160_000 &&
                        processingContentType(name.substringAfterLast('.', "").lowercase()) != null
                    try {
                        if (!canCopy) throw InputPreparationException(InputPreparationError.UNSUPPORTED)
                        app.audioInputPreparer.prepare(owner, name, operationId, policy, sourceKind) {
                            applicationContext.contentResolver.openInputStream(uri) ?: throw InputPreparationException(InputPreparationError.STORAGE)
                        }
                    } catch (error: InputPreparationException) {
                        if (!policy.localPreparationReady || error.reason !in setOf(InputPreparationError.UNSUPPORTED, InputPreparationError.TOO_LARGE, InputPreparationError.INVALID_AUDIO)) throw error
                        engine.prepare(uri, temporary, policy)
                        // The engine already inspected the generated audio and decoded the
                        // source when conversion was needed. Staging still checks its
                        // container, duration, size and checksum before upload.
                        app.audioInputPreparer.prepare(owner, "${name.substringBeforeLast('.', name)}.m4a",
                            operationId, policy, sourceKind, validateFullDecode = false) { temporary.inputStream() }
                    }
                }
                checkOwner()
                val latest = repository.store.get(owner, operationId) ?: return@withLocalSlot Result.failure()
                if (latest.cancellationRequested || latest.pendingDelete) return@withLocalSlot Result.success()
                repository.submit(prepared)
                Result.success()
            }
        } catch (error: kotlinx.coroutines.TimeoutCancellationException) {
            if (repository.isCurrentSession(owner, epoch)) repository.store.update(owner, operationId) {
                it.copy(phase = ProcessingPhase.PAUSED, localProblem = ProcessingLocalProblem.RETRY_EXHAUSTED)
            }
            Result.failure()
        } catch (error: CancellationException) { throw error }
        catch (error: JobsFailure) {
            checkOwner()
            repository.store.update(owner, operationId) { it.copy(phase = ProcessingPhase.PAUSED, problem = error.problem) }
            Result.failure()
        } catch (error: Exception) {
            checkOwner()
            val reason = (error as? InputPreparationException)?.reason
            val problem = when (reason) {
                InputPreparationError.TOO_LONG -> JobsProblem.MEDIA_TOO_LONG
                InputPreparationError.TOO_LARGE -> JobsProblem.MEDIA_TOO_LARGE
                InputPreparationError.NO_AUDIO -> JobsProblem.MEDIA_NO_AUDIO
                InputPreparationError.DEFAULT_TRACK_UNAVAILABLE -> JobsProblem.MEDIA_DEFAULT_TRACK_UNAVAILABLE
                InputPreparationError.DURATION_UNKNOWN -> JobsProblem.MEDIA_DURATION_UNKNOWN
                InputPreparationError.UNSUPPORTED -> JobsProblem.MEDIA_UNSUPPORTED
                else -> null
            }
            repository.store.update(owner, operationId) { it.copy(phase = ProcessingPhase.PAUSED, problem = problem,
                localProblem = if (problem == null) ProcessingLocalProblem.STORAGE else null) }
            Result.failure()
        } finally { temporary.delete() }
    }
}
