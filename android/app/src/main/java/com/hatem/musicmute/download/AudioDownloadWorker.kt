package com.hatem.musicmute.download

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import com.hatem.musicmute.MainActivity
import com.hatem.musicmute.R
import com.hatem.musicmute.VocalApplication
import com.hatem.musicmute.BuildConfig
import com.hatem.musicmute.processing.AudioTaskNotificationTarget
import com.hatem.musicmute.processing.AudioPreparationEngine
import com.hatem.musicmute.processing.AudioTaskNotifications
import com.hatem.musicmute.processing.AudioTaskNotificationThrottle
import com.hatem.musicmute.processing.AudioTaskStage
import com.hatem.musicmute.processing.ClientErrorCode
import com.hatem.musicmute.processing.ClientErrorStage
import com.hatem.musicmute.processing.InputPreparationException
import com.hatem.musicmute.processing.InputPreparationError
import com.hatem.musicmute.processing.ProcessingLocalProblem
import com.hatem.musicmute.processing.ProcessingMediaPolicy
import com.hatem.musicmute.processing.ProcessingPhase
import com.hatem.musicmute.processing.ProcessingOperation
import com.hatem.musicmute.processing.WorkManagerProcessingScheduler
import com.hatem.musicmute.processing.audioTaskNotificationProjection
import com.hatem.musicmute.processing.sourceTaskNotificationTarget
import com.hatem.musicmute.processing.canUpdateAudioSource
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class AudioDownloadWorker(context: Context, parameters: WorkerParameters) :
    CoroutineWorker(context, parameters) {
    private val app
        get() = applicationContext as VocalApplication

    override suspend fun getForegroundInfo(): ForegroundInfo {
        val record = inputData.getString(DownloadRepository.KEY_ID)?.let { app.downloadRepository.store.get(it) }
        val target = record?.let(::pipelineTarget)
        if (target != null && target.matches(app.processingSession())) {
            app.processingRepository.store.get(target.ownerUid, target.operationId)?.let { operation ->
                return AudioTaskNotifications(applicationContext).foreground(target,
                    audioTaskNotificationProjection(operation, target, stage = AudioTaskStage.DOWNLOADING_SOURCE,
                        transferredBytes = record.downloadedBytes, totalBytes = record.totalBytes))
            }
        }
        val manager = applicationContext.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL,
                applicationContext.getString(R.string.download_channel),
                NotificationManager.IMPORTANCE_LOW,
            )
        )
        val openApp = MainActivity.historyPendingIntent(applicationContext)
        val notification =
            NotificationCompat.Builder(applicationContext, CHANNEL)
                .setSmallIcon(R.drawable.ic_vocal_monochrome)
                .setContentTitle(applicationContext.getString(R.string.downloading))
                .setContentText(applicationContext.getString(R.string.original_quality_notice))
                .setContentIntent(openApp)
                .setOngoing(true)
                .setSilent(true)
                .setOnlyAlertOnce(true)
                .setProgress(0, 0, true)
                .build()
        return if (Build.VERSION.SDK_INT >= 29)
            ForegroundInfo(
                id.hashCode(),
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        else ForegroundInfo(id.hashCode(), notification)
    }

    override suspend fun doWork(): Result {
        if (app.updateAdmission.isBlocked()) return Result.retry()
        val recordId = inputData.getString(DownloadRepository.KEY_ID) ?: return Result.failure()
        if (runCatching { UUID.fromString(recordId).toString() == recordId }.getOrDefault(false).not()) return Result.failure()
        val repository = app.downloadRepository
        val record = repository.store.get(recordId) ?: return Result.failure()
        if (record.status == DownloadStatus.CANCELLED) return Result.failure()
        val target = pipelineTarget(record)
        if ((record.ownerUid != null || record.operationId != null || record.sessionEpoch != null) && target == null) return Result.failure()
        if (target != null && !target.matches(app.processingSession())) return Result.failure()
        if (record.status == DownloadStatus.COMPLETE && target == null) return Result.success()
        // A replacement epoch/work request must never share native process or
        // partial-file ownership with a worker that is still stopping.
        val nativeId = id.toString()
        val directory = File(repository.audioRoot, "$recordId/$nativeId")
        return try {
            if (target != null) {
                val pending = app.processingRepository.store.get(target.ownerUid, target.operationId)
                    ?: return Result.failure()
                // This wait owns neither a foreground service nor a local slot.
                // WorkManager's own backoff survives process death; the saved
                // deadline also covers restoration into a replacement request.
                val waitMillis = (pending.retryNotBeforeMillis - System.currentTimeMillis()).coerceAtLeast(0)
                if (waitMillis > 300_000) return Result.retry()
                if (waitMillis > 0) delay(waitMillis)
            }
            withPipelineSlot(record) {
                checkPipeline(record)
                setForeground(getForegroundInfo())
                if (record.status == DownloadStatus.COMPLETE) {
                    val source = resolveAudioFile(repository.audioRoot, record.relativePath)
                        ?: throw java.io.IOException("Source file missing")
                    handoff(record, source, record.title, record.bitrateKbps)
                    return@withPipelineSlot Result.success()
                }
                withContext(Dispatchers.IO) {
                    check(repository.audioRoot.isDirectory || repository.audioRoot.mkdirs())
                    if (repository.audioRoot.usableSpace < 32 * 1024 * 1024)
                        throw java.io.IOException("No space left")
                }
                updateDownload(record) {
                    if (it.status == DownloadStatus.CANCELLED) it
                    else
                        it.copy(
                            status = DownloadStatus.QUEUED,
                            progress = 0,
                            downloadedBytes = 0,
                            totalBytes = null,
                            error = DownloadError.NONE,
                        )
                }
                if (target != null) app.processingRepository.store.update(target.ownerUid, target.operationId) {
                    if (!canUpdateSource(target, it)) it
                    else it.copy(phase = ProcessingPhase.DOWNLOADING_SOURCE,
                        sourceDownloadedBytes = 0, sourceTotalBytes = null, retryNotBeforeMillis = 0)
                }
                val audio = coroutineScope {
                    val progress = Channel<DownloadProgress>(Channel.CONFLATED)
                    val throttle = AudioTaskNotificationThrottle()
                    val notifications = AudioTaskNotifications(applicationContext)
                    val reporter = launch {
                        var lastProgress: DownloadProgress? = null
                        for (value in progress) {
                            if (value != lastProgress) {
                                checkPipeline(record)
                                updateDownload(record) { current ->
                                    if (
                                        current.status in
                                            setOf(DownloadStatus.QUEUED, DownloadStatus.DOWNLOADING)
                                    )
                                        current.copy(
                                            status = DownloadStatus.DOWNLOADING,
                                            progress = value.percent,
                                            downloadedBytes = value.downloadedBytes,
                                            totalBytes = value.totalBytes,
                                        )
                                    else current
                                }
                                if (target != null) {
                                    app.processingRepository.store.update(target.ownerUid, target.operationId) {
                                        if (!canUpdateSource(target, it)) it
                                        else it.copy(
                                            phase = ProcessingPhase.DOWNLOADING_SOURCE,
                                            sourceDownloadedBytes = value.downloadedBytes,
                                            sourceTotalBytes = value.totalBytes,
                                        )
                                    }
                                }
                                if (target != null) {
                                    app.processingRepository.store.get(target.ownerUid, target.operationId)?.let { operation ->
                                        if (!canUpdateSource(target, operation)) return@let
                                        val projection = audioTaskNotificationProjection(operation, target,
                                            stage = AudioTaskStage.DOWNLOADING_SOURCE,
                                            transferredBytes = value.downloadedBytes, totalBytes = value.totalBytes)
                                        if (throttle.shouldUpdate(projection, SystemClock.elapsedRealtime()))
                                            notifications.updateIfVisible(target, projection)
                                    }
                                }
                                lastProgress = value
                            }
                        }
                    }
                    try {
                        app.audioDownloader.download(nativeId, record.url, directory) {
                            progress.trySend(it)
                        }
                    } finally {
                        progress.close()
                        reporter.join()
                    }
                }
                checkPipeline(record)
                updateDownload(record) {
                    if (it.status == DownloadStatus.CANCELLED) it
                    else
                        it.copy(
                            status = DownloadStatus.COMPLETE,
                            progress = 100,
                            title = audio.title,
                            relativePath = "${record.id}/$nativeId/${audio.file.name}",
                            codec = audio.codec,
                            extension = audio.extension,
                            bitrateKbps = audio.bitrateKbps,
                            durationMs = audio.durationMs,
                            sizeBytes = audio.file.length(),
                            error = DownloadError.NONE,
                        )
                }
                // yt-dlp metadata can contain expiring URLs; keep only the fields persisted above.
                withContext(Dispatchers.IO) { File(directory, "audio.info.json").delete() }
                if (target != null) handoff(record, audio.file, audio.title, audio.bitrateKbps)
                Result.success()
            }
        } catch (error: CancellationException) {
            withContext(NonCancellable + Dispatchers.IO) {
                app.audioDownloader.cancel(nativeId)
                updateDownload(record) {
                    if (it.status in setOf(DownloadStatus.COMPLETE, DownloadStatus.CANCELLED)) it
                    else it.copy(status = DownloadStatus.QUEUED)
                }
            }
            throw error
        } catch (error: Exception) {
            if (target != null && target.matches(app.processingSession())) {
                if (isStopped || repository.store.get(recordId)?.workRequestId != nativeId) return Result.failure()
                val current = app.processingRepository.store.get(target.ownerUid, target.operationId) ?: return Result.failure()
                if (!canUpdateSource(target, current)) return Result.failure()
                val reason = classifyDownloadError(error)
                val stage = if (current.input != null) ClientErrorStage.RESERVING_JOB
                    else if (repository.store.get(recordId)?.status == DownloadStatus.COMPLETE) ClientErrorStage.PREPARING_INPUT
                    else ClientErrorStage.DOWNLOADING_SOURCE
                val safeProblem = (error as? com.hatem.musicmute.processing.JobsFailure)?.problem
                val transient = safeProblem == null && (reason == DownloadError.NETWORK || reason == DownloadError.ENGINE)
                val retries = current.transientRetryCount
                val retry = sourceRetryPlan(reason, retries, connected(), System.currentTimeMillis(), Math.random())
                if (safeProblem == null && retry.shouldRetry) {
                    app.processingRepository.store.update(target.ownerUid, target.operationId) {
                        if (!canUpdateSource(target, it)) it
                        else it.copy(phase = if (it.input == null) ProcessingPhase.SOURCE_QUEUED else ProcessingPhase.WAITING,
                            transientRetryCount = maxOf(it.transientRetryCount, retry.nextRetryCount),
                            retryNotBeforeMillis = retry.retryNotBeforeMillis)
                    }
                    updateDownload(record) {
                        if (it.status == DownloadStatus.COMPLETE) it
                        else it.copy(status = DownloadStatus.QUEUED, error = DownloadError.NONE,
                            sourceDiagnostic = (error as? YoutubeSourceFailure)?.diagnostic)
                    }
                    captureFailure(target, stage, reason, retryable = true)
                    return Result.retry()
                }
                val problem = if (reason == DownloadError.STORAGE) ProcessingLocalProblem.STORAGE
                    else if (error is InputPreparationException || reason == DownloadError.INVALID_AUDIO)
                        ProcessingLocalProblem.INPUT_CHANGED
                    else if (transient) ProcessingLocalProblem.RETRY_EXHAUSTED else ProcessingLocalProblem.TRANSFER
                app.processingRepository.store.update(target.ownerUid, target.operationId) {
                    if (!canUpdateSource(target, it)) it
                    else it.copy(phase = ProcessingPhase.PAUSED, localProblem = if (safeProblem == null) problem else null, problem = safeProblem)
                }
                captureFailure(target, stage, reason, retryable = transient)
                app.processingRepository.store.get(target.ownerUid, target.operationId)?.let { failed ->
                    if (canUpdateSource(target, failed))
                        AudioTaskNotifications(applicationContext).sourceFailed(target, failed)
                }
            }
            updateDownload(record) { current ->
                if (current.status == DownloadStatus.CANCELLED) current
                else
                    current.copy(
                        status = DownloadStatus.FAILED,
                        error = classifyDownloadError(error),
                        sourceDiagnostic = (error as? YoutubeSourceFailure)?.diagnostic,
                    )
            }
            Result.failure()
        } finally {
            withContext(NonCancellable + Dispatchers.IO) {
                val retained = repository.store.get(recordId)
                val keepsThisAttempt = retained?.status == DownloadStatus.COMPLETE &&
                    File(repository.audioRoot, retained.relativePath).canonicalFile.toPath().startsWith(directory.canonicalFile.toPath())
                if (!keepsThisAttempt)
                    directory.deleteRecursively()
            }
        }
    }

    private fun pipelineTarget(record: DownloadRecord): AudioTaskNotificationTarget? = sourceTaskNotificationTarget(
        record,
        inputData.getString(WorkManagerProcessingScheduler.KEY_OWNER),
        inputData.getString(WorkManagerProcessingScheduler.KEY_OPERATION),
        inputData.getLong(WorkManagerProcessingScheduler.KEY_EPOCH, Long.MIN_VALUE),
        id.toString(),
    )

    private suspend fun updateDownload(expected: DownloadRecord, transform: (DownloadRecord) -> DownloadRecord) {
        app.downloadRepository.store.update(expected.id) { current ->
            val target = pipelineTarget(expected)
            if (current.ownerUid != expected.ownerUid || current.operationId != expected.operationId ||
                current.sessionEpoch != expected.sessionEpoch ||
                current.workRequestId != expected.workRequestId ||
                (expected.workRequestId != null && expected.workRequestId != id.toString()) ||
                (expected.ownerUid != null && target?.matches(app.processingSession()) != true)) current
            else transform(current)
        }
    }

    private suspend fun checkPipeline(record: DownloadRecord) {
        val target = pipelineTarget(record) ?: return
        if (app.updateAdmission.isBlocked()) throw CancellationException("App update required")
        if (!target.matches(app.processingSession()) || isStopped) throw CancellationException("Source task stopped")
        if (app.downloadRepository.store.get(record.id)?.workRequestId != id.toString())
            throw CancellationException("Source task replaced")
        val operation = app.processingRepository.store.get(target.ownerUid, target.operationId)
            ?: throw CancellationException("Source task unavailable")
        if (operation.cancellationRequested || operation.pendingDelete || operation.sourceWorkRequestId != id.toString() ||
            !target.matches(app.processingSession()))
            throw CancellationException("Source task stopped")
    }

    private fun canUpdateSource(target: AudioTaskNotificationTarget, operation: ProcessingOperation): Boolean =
        canUpdateAudioSource(operation, target, app.processingSession())

    private suspend fun <T> withPipelineSlot(record: DownloadRecord, action: suspend () -> T): T {
        val target = pipelineTarget(record) ?: return action()
        return app.audioPipelineCoordinator.withLocalSlot(target.ownerUid, target.epoch, action)
    }

    private suspend fun handoff(record: DownloadRecord, file: File, title: String, downloadedBitrateKbps: Int) {
        val target = pipelineTarget(record) ?: return
        checkPipeline(record)
        val operation = app.processingRepository.store.update(target.ownerUid, target.operationId) {
            if (!canUpdateSource(target, it) || it.input != null) it
            else it.copy(phase = ProcessingPhase.PREPARING_INPUT)
        } ?: return
        AudioTaskNotifications(applicationContext).updateIfVisible(target,
            audioTaskNotificationProjection(operation, target, stage = AudioTaskStage.PREPARING_INPUT))
        checkPipeline(record)
        val engine = AudioPreparationEngine(applicationContext)
        val preparedFile = File(file.parentFile, "upload.m4a")
        if (preparedFile.exists() && preparedFile.length() !in 1L..ProcessingMediaPolicy.STANDARD.maxPreparedAudioBytes)
            preparedFile.delete()
        val source = if (preparedFile.isFile) {
            try {
                val inspected = engine.inspect(Uri.fromFile(preparedFile))
                if (canReuseDownloadedAudio(inspected.hasVideo, inspected.audioTrackCount,
                        inspected.audio.bitRate, 0, preparedFile.extension))
                    preparedFile else { preparedFile.delete(); file }
            } catch (_: InputPreparationException) {
                preparedFile.delete()
                file
            }
        } else file
        val uploadFile = if (source == preparedFile) source else {
            val inspection = engine.inspect(Uri.fromFile(file))
            if (canReuseDownloadedAudio(inspection.hasVideo, inspection.audioTrackCount,
                    inspection.audio.bitRate, downloadedBitrateKbps, file.extension)) file
            else engine.prepare(Uri.fromFile(file), preparedFile, ProcessingMediaPolicy.STANDARD)
        }
        app.audioPipelineCoordinator.completeUrlDownload(
            target.ownerUid, target.operationId, target.epoch, title, uploadFile, id.toString()
        )
    }

    private fun connected(): Boolean {
        val manager = applicationContext.getSystemService(ConnectivityManager::class.java)
        val capabilities = manager.getNetworkCapabilities(manager.activeNetwork) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    private suspend fun captureFailure(target: AudioTaskNotificationTarget, stage: ClientErrorStage, reason: DownloadError, retryable: Boolean) {
        try {
            if (!target.matches(app.processingSession())) return
            val current = app.processingRepository.store.get(target.ownerUid, target.operationId) ?: return
            if (!canUpdateSource(target, current)) return
            app.clientErrorOutbox.capture(target.operationId, null, stage,
                when (reason) {
                    DownloadError.NETWORK -> ClientErrorCode.NETWORK
                    DownloadError.STORAGE -> ClientErrorCode.STORAGE
                    DownloadError.UNAVAILABLE -> ClientErrorCode.SOURCE_UNAVAILABLE
                    DownloadError.INVALID_AUDIO -> ClientErrorCode.INVALID_MEDIA
                    else -> ClientErrorCode.UNKNOWN
                }, retryable, BuildConfig.VERSION_NAME, Build.VERSION.RELEASE)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            // Reporting availability never gates source processing.
        }
    }

    private companion object {
        const val CHANNEL = "audio-downloads"
    }
}

fun classifyDownloadError(error: Exception): DownloadError {
    if (error is YoutubeSourceFailure) return error.reason
    if (error is InputPreparationException) return when (error.reason) {
        InputPreparationError.STORAGE -> DownloadError.STORAGE
        else -> DownloadError.INVALID_AUDIO
    }
    val message = error.message.orEmpty().lowercase()
    return when {
        "no space left" in message || "disk full" in message || "permission denied" in message ->
            DownloadError.STORAGE
        "429" in message || "too many requests" in message ||
            "try again later" in message || "403" in message -> DownloadError.NETWORK
        "requested format" in message || "signature extraction" in message ||
            "nsig extraction" in message -> DownloadError.ENGINE
        "sign in" in message ||
            "not available" in message ||
            "unavailable" in message ||
            "private" in message -> DownloadError.UNAVAILABLE
        "timed out" in message ||
            "network" in message ||
            "resolve" in message ||
            "connection" in message -> DownloadError.NETWORK
        error is IllegalArgumentException -> DownloadError.INVALID_AUDIO
        else -> DownloadError.ENGINE
    }
}

data class SourceRetryPlan(val shouldRetry: Boolean, val nextRetryCount: Int, val retryNotBeforeMillis: Long)

fun sourceRetryPlan(error: DownloadError, previousRetries: Int, online: Boolean, nowMillis: Long, jitter: Double): SourceRetryPlan {
    if (error !in setOf(DownloadError.NETWORK, DownloadError.ENGINE)) return SourceRetryPlan(false, previousRetries, 0)
    if (!online) return SourceRetryPlan(true, previousRetries, 0)
    if (previousRetries >= 3) return SourceRetryPlan(false, previousRetries, 0)
    val base = 30_000L * (1L shl previousRetries.coerceAtLeast(0))
    return SourceRetryPlan(true, previousRetries + 1, nowMillis + base + (base / 2 * jitter.coerceIn(0.0, 1.0)).toLong())
}
