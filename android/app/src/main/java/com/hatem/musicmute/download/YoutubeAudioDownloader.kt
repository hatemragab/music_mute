package com.hatem.musicmute.download

import android.content.Context
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import java.io.File
import com.hatem.musicmute.processing.ProcessingMediaPolicy
import com.hatem.musicmute.processing.JobsFailure
import com.hatem.musicmute.processing.JobsProblem
import kotlinx.coroutines.delay
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

interface AudioDownloader {
    suspend fun download(
        id: String,
        url: String,
        directory: File,
        onProgress: (DownloadProgress) -> Unit,
    ): DownloadedAudio

    fun cancel(id: String)
}

class YoutubeAudioDownloader(private val context: Context, private val mediaPolicy: suspend () -> ProcessingMediaPolicy = { ProcessingMediaPolicy.STANDARD }) : AudioDownloader {
    private val engineLock = Mutex()
    private var extractorVersion = "unknown"
    private var lastDownloadFinishedNanos = 0L

    override suspend fun download(
        id: String,
        url: String,
        directory: File,
        onProgress: (DownloadProgress) -> Unit,
    ): DownloadedAudio =
        engineLock.withLock {
            coroutineScope {
                YouTubePreflight.validateUrl(url)
                // Maintenance and pacing do not consume the source transfer deadline.
                maintainExtractor(id)
                val waitMillis = 5_000 - (System.nanoTime() - lastDownloadFinishedNanos) / 1_000_000
                if (lastDownloadFinishedNanos != 0L && waitMillis > 0) delay(waitMillis)
                val policy = mediaPolicy()
                if (!policy.acceptNewJobs || !policy.youtubePreparationReady)
                    throw JobsFailure(JobsProblem.PROCESSING_CAPACITY_UNAVAILABLE)
                val maxBytes = policy.maxSourceDownloadBytes ?: throw JobsFailure(JobsProblem.PROCESSING_POLICY_INCOMPATIBLE)
                val deadlineSeconds = (policy.maxSourceDownloadSeconds ?: 120L).coerceAtMost(3600)
                val startedAt = System.nanoTime()
                val bounds = SourceDownloadBounds(maxBytes, deadlineSeconds)
                val job = currentCoroutineContext().job
                var stage = "metadata"
                fun boundsFailure(): Exception = if (bounds.failure == SourceBound.BYTES)
                    JobsFailure(JobsProblem.MEDIA_TOO_LARGE)
                else YoutubeSourceFailure(DownloadError.NETWORK, "deadline", extractorVersion)
                val boundsWatcher = launch(Dispatchers.IO) {
                    while (true) {
                        delay(100)
                        val bytes = directory.listFiles()?.sumOf { if (it.isFile) it.length() else 0L } ?: 0L
                        if (!bounds.check(bytes, (System.nanoTime() - startedAt) / 1_000_000_000)) {
                            cancel(id); break
                        }
                    }
                }
                val cancellationWatcher =
                    launch(Dispatchers.IO, start = CoroutineStart.UNDISPATCHED) {
                        try {
                            awaitCancellation()
                        } finally {
                            cancel(id)
                        }
                    }
                try {
                    runInterruptible(Dispatchers.IO) {
                        onProgress(DownloadProgress(0))
                        val engine = YoutubeDL.getInstance()
                        engine.init(context)
                        check(directory.isDirectory || directory.mkdirs()) {
                            "Unable to create download directory"
                        }
                        val metadata = YoutubeDLRequest(url).apply {
                            addOption("--ignore-config"); addOption("--no-playlist"); addOption("--skip-download")
                            addOption("--socket-timeout", "15")
                            addOption("--retries", "1"); addOption("--extractor-retries", "1")
                            addOption("--print", "{\"duration\":%(duration)j,\"is_live\":%(is_live)j,\"live_status\":%(live_status)j,\"_type\":%(_type)j}")
                        }
                        // The minimal print projection avoids retaining private stream URLs.
                        job.ensureActive()
                        if (bounds.failure != null) throw boundsFailure()
                        val response = engine.execute(metadata, id)
                        job.ensureActive()
                        if (bounds.failure != null) throw boundsFailure()
                        val projected = response.out.lineSequence().firstOrNull { it.startsWith("{\"duration\"") }
                            ?: throw JobsFailure(JobsProblem.MEDIA_DURATION_UNKNOWN)
                        policy.requireLongJobAvailable(YouTubePreflight.validateMetadata(projected, policy.maxDurationSeconds))
                        val request = createAudioRequest(url, directory).apply { addOption("--max-filesize", maxBytes.toString()) }
                        job.ensureActive()
                        if (bounds.failure != null) throw boundsFailure()
                        stage = "download"
                        try { engine.execute(request, id) { progress, _, line ->
                            val parsed = DownloadProgress.parse(progress, line)
                            val bytes = directory.listFiles()?.sumOf { if (it.isFile) it.length() else 0L } ?: 0L
                            if (!bounds.check(maxOf(bytes, parsed.downloadedBytes), (System.nanoTime() - startedAt) / 1_000_000_000)) {
                                cancel(id)
                            }
                            onProgress(parsed)
                        } } catch (error: Exception) {
                            if (bounds.failure != null) throw boundsFailure()
                            throw error
                        }
                        if (bounds.failure != null) throw boundsFailure()
                        stage = "output"
                        DownloadedAudioReader.read(directory).also {
                            if (it.file.length() > maxBytes) throw JobsFailure(JobsProblem.MEDIA_TOO_LARGE)
                        }
                    }
                } catch (error: Exception) {
                    job.ensureActive()
                    if (bounds.failure != null) throw boundsFailure()
                    if (error is JobsFailure || error is YoutubeSourceFailure) throw error
                    throw YoutubeSourceFailure(classifyDownloadError(error), stage, extractorVersion)
                } finally {
                    lastDownloadFinishedNanos = System.nanoTime()
                    withContext(NonCancellable) { boundsWatcher.cancelAndJoin(); cancellationWatcher.cancelAndJoin() }
                }
            }
        }

    override fun cancel(id: String) {
        YoutubeDL.getInstance().destroyProcessById(id)
    }

    private suspend fun maintainExtractor(id: String) = coroutineScope {
        val watcher = launch(Dispatchers.IO, start = CoroutineStart.UNDISPATCHED) {
            try { awaitCancellation() } finally { cancel(id) }
        }
        try {
            runInterruptible(Dispatchers.IO) {
                val engine = YoutubeDL.getInstance()
                engine.init(context)
                val installed = File(context.noBackupFilesDir, "youtubedl-android/yt-dlp/yt-dlp")
                fun probe(): String = engine.execute(YoutubeDLRequest("").apply {
                    addOption("--ignore-config"); addOption("--version")
                }, id).out.trim()
                val result = ExtractorMaintenance(installed).refresh(::probe)
                extractorVersion = probe().takeIf { it.matches(Regex("[0-9]{4}\\.[0-9]{2}\\.[0-9]{2}")) } ?: "unknown"
                android.util.Log.i("YoutubeSource", "extractor=$extractorVersion update=${result.name}")
            }
        } catch (error: Exception) {
            currentCoroutineContext().ensureActive()
            throw YoutubeSourceFailure(classifyDownloadError(error), "initialization", extractorVersion)
        } finally {
            withContext(NonCancellable) { watcher.cancelAndJoin() }
        }
    }
}

/** Allowlisted diagnostic only: never retain native stderr, source URLs, or signed URLs. */
internal class YoutubeSourceFailure(val reason: DownloadError, stage: String, version: String) :
    Exception("YouTube source ${reason.name}") {
    val diagnostic = "stage=$stage;extractor=$version;category=${reason.name}"
}

internal fun createAudioRequest(url: String, directory: File): YoutubeDLRequest =
    YoutubeDLRequest(url).apply {
        AudioDownloadPolicy.flags.forEach { addOption(it) }
        AudioDownloadPolicy.options.forEach { (option, value) -> addOption(option, value) }
        addOption("-o", File(directory, "audio.%(ext)s").absolutePath)
    }
