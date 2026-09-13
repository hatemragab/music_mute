package com.hatem.musicmute.download

import android.content.Context
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import java.io.File
import com.hatem.musicmute.processing.ProcessingMediaPolicy
import com.hatem.musicmute.processing.JobsFailure
import com.hatem.musicmute.processing.JobsProblem
import kotlinx.coroutines.delay
import java.util.concurrent.atomic.AtomicBoolean
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

class YoutubeAudioDownloader(private val context: Context, private val mediaPolicy: suspend () -> ProcessingMediaPolicy = { ProcessingMediaPolicy.LEGACY }) : AudioDownloader {
    private val engineLock = Mutex()

    override suspend fun download(
        id: String,
        url: String,
        directory: File,
        onProgress: (DownloadProgress) -> Unit,
    ): DownloadedAudio =
        engineLock.withLock {
            coroutineScope {
                YouTubePreflight.validateUrl(url)
                val fetched = mediaPolicy()
                val policy = if (fetched.youtubeExpansionReady && fetched.acceptNewJobs) fetched else ProcessingMediaPolicy.LEGACY
                val maxBytes = policy.maxSourceDownloadBytes ?: 29_999_999L
                val deadlineSeconds = (policy.maxSourceDownloadSeconds ?: 120L).coerceAtMost(3600)
                val startedAt = System.nanoTime()
                val exceeded = AtomicBoolean(false)
                val job = currentCoroutineContext().job
                val boundsWatcher = launch(Dispatchers.IO) {
                    while (true) {
                        delay(100)
                        val bytes = directory.listFiles()?.sumOf { if (it.isFile) it.length() else 0L } ?: 0L
                        if (!withinSourceDownloadBounds(bytes, (System.nanoTime() - startedAt) / 1_000_000_000, maxBytes, deadlineSeconds)) {
                            exceeded.set(true); cancel(id); break
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
                        if (exceeded.get()) throw JobsFailure(JobsProblem.MEDIA_TOO_LARGE)
                        val response = engine.execute(metadata, id)
                        job.ensureActive()
                        if (exceeded.get()) throw JobsFailure(JobsProblem.MEDIA_TOO_LARGE)
                        val projected = response.out.lineSequence().firstOrNull { it.startsWith("{\"duration\"") }
                            ?: throw JobsFailure(JobsProblem.MEDIA_DURATION_UNKNOWN)
                        policy.requireLongJobAvailable(YouTubePreflight.validateMetadata(projected, policy.maxDurationSeconds, policy.version == 2))
                        val request = createAudioRequest(url, directory).apply { addOption("--max-filesize", maxBytes.toString()) }
                        job.ensureActive()
                        try { engine.execute(request, id) { progress, _, line ->
                            val parsed = DownloadProgress.parse(progress, line)
                            val bytes = directory.listFiles()?.sumOf { if (it.isFile) it.length() else 0L } ?: 0L
                            if (!withinSourceDownloadBounds(maxOf(bytes, parsed.downloadedBytes), (System.nanoTime() - startedAt) / 1_000_000_000, maxBytes, deadlineSeconds)) {
                                exceeded.set(true); cancel(id)
                            }
                            onProgress(parsed)
                        } } catch (error: Exception) {
                            if (exceeded.get()) throw JobsFailure(JobsProblem.MEDIA_TOO_LARGE)
                            throw error
                        }
                        if (exceeded.get()) throw JobsFailure(JobsProblem.MEDIA_TOO_LARGE)
                        DownloadedAudioReader.read(directory).also {
                            if (it.file.length() > maxBytes) throw JobsFailure(JobsProblem.MEDIA_TOO_LARGE)
                        }
                    }
                } finally {
                    withContext(NonCancellable) { boundsWatcher.cancelAndJoin(); cancellationWatcher.cancelAndJoin() }
                }
            }
        }

    override fun cancel(id: String) {
        YoutubeDL.getInstance().destroyProcessById(id)
    }
}

internal fun createAudioRequest(url: String, directory: File): YoutubeDLRequest =
    YoutubeDLRequest(url).apply {
        AudioDownloadPolicy.flags.forEach { addOption(it) }
        AudioDownloadPolicy.options.forEach { (option, value) -> addOption(option, value) }
        addOption("-o", File(directory, "audio.%(ext)s").absolutePath)
    }
