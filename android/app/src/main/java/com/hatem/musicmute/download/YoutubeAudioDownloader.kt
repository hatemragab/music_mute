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
    private val pacing = SourceRequestPacing(context)
    private val diagnostics = SourceDiagnostics(context)
    private var initialized = false
    private val installed get() = File(context.noBackupFilesDir, "youtubedl-android/yt-dlp/yt-dlp")
    private val cache get() = File(context.noBackupFilesDir, "youtube-extractor-cache")

    override suspend fun download(
        id: String,
        url: String,
        directory: File,
        onProgress: (DownloadProgress) -> Unit,
    ): DownloadedAudio =
        engineLock.withLock {
            coroutineScope {
                YouTubePreflight.validateUrl(url)
                // No GitHub access here. Respect a persisted cooldown even if callers race.
                val waitMillis = pacing.remainingMillis()
                if (waitMillis > SOURCE_GAP_MILLIS)
                    throw YoutubeSourceFailure(DownloadError.UNAVAILABLE, "pacing", extractorVersion, SourceRefusal.RATE_LIMITED)
                if (waitMillis > 0) delay(waitMillis)
                initializeExtractor(id)
                val policy = mediaPolicy()
                if (!policy.acceptNewJobs || !policy.youtubePreparationReady)
                    throw JobsFailure(JobsProblem.PROCESSING_CAPACITY_UNAVAILABLE)
                val maxBytes = policy.maxSourceDownloadBytes ?: throw JobsFailure(JobsProblem.PROCESSING_POLICY_INCOMPATIBLE)
                val deadlineSeconds = (policy.maxSourceDownloadSeconds ?: 120L).coerceAtMost(3600)
                val startedAt = System.nanoTime()
                val bounds = SourceDownloadBounds(maxBytes, deadlineSeconds)
                val job = currentCoroutineContext().job
                var stage = "metadata"
                var stageStartedAt = startedAt
                var refusal = SourceRefusal.NONE
                var hint = SourceHint.NONE
                diagnostics.event("attempt", "START", startedAt, extractorVersion)
                diagnostics.event(stage, "START", stageStartedAt, extractorVersion)
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
                        val metadata = createAudioRequest(url, directory).apply {
                            addOption("--skip-download")
                            addOption("--cache-dir", cache.absolutePath)
                            addOption("--print", "{\"duration\":%(duration)j,\"is_live\":%(is_live)j,\"live_status\":%(live_status)j,\"_type\":%(_type)j}")
                        }
                        // Private info JSON lives only in this bounded attempt directory.
                        job.ensureActive()
                        if (bounds.failure != null) throw boundsFailure()
                        val response = engine.execute(metadata, id)
                        job.ensureActive()
                        if (bounds.failure != null) throw boundsFailure()
                        hint = sourceHint(response.err)
                        diagnostics.event(stage, "SUCCESS", stageStartedAt, extractorVersion, hint = hint)
                        val projected = response.out.lineSequence().firstOrNull { it.startsWith("{\"duration\"") }
                            ?: throw JobsFailure(JobsProblem.MEDIA_DURATION_UNKNOWN)
                        policy.requireLongJobAvailable(YouTubePreflight.validateMetadata(projected, policy.maxDurationSeconds))
                        prepareCachedSource(directory)
                        val request = createCachedAudioRequest(directory).apply {
                            addOption("--max-filesize", maxBytes.toString())
                            addOption("--cache-dir", cache.absolutePath)
                        }
                        job.ensureActive()
                        if (bounds.failure != null) throw boundsFailure()
                        stage = "download"
                        stageStartedAt = System.nanoTime()
                        diagnostics.event(stage, "START", stageStartedAt, extractorVersion)
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
                        diagnostics.event(stage, "SUCCESS", stageStartedAt, extractorVersion)
                        stage = "output"
                        DownloadedAudioReader.read(directory).also {
                            if (it.file.length() > maxBytes) throw JobsFailure(JobsProblem.MEDIA_TOO_LARGE)
                            diagnostics.event("attempt", "SUCCESS", startedAt, extractorVersion, bytes = it.file.length())
                        }
                    }
                } catch (error: Exception) {
                    if (!job.isActive) {
                        diagnostics.event(stage, "CANCELLED", stageStartedAt, extractorVersion)
                        job.ensureActive()
                    }
                    refusal = sourceRefusal(error.message.orEmpty())
                    val failureHint = sourceHint(error.message.orEmpty()).takeUnless { it == SourceHint.NONE } ?: hint
                    val failure = if (bounds.failure != null) boundsFailure() else error
                    diagnostics.event(stage, "FAILED", stageStartedAt, extractorVersion,
                        classifyDownloadError(failure), refusal, failureHint)
                    if (failure is JobsFailure || failure is YoutubeSourceFailure) throw failure
                    throw YoutubeSourceFailure(classifyDownloadError(failure), stage, extractorVersion, refusal, failureHint)
                } finally {
                    withContext(NonCancellable + Dispatchers.IO) {
                        boundsWatcher.cancelAndJoin()
                        cancellationWatcher.cancelAndJoin()
                        pacing.finish(refusal)
                    }
                }
            }
        }

    override fun cancel(id: String) {
        YoutubeDL.getInstance().destroyProcessById(id)
    }

    private suspend fun initializeExtractor(id: String) = coroutineScope {
        if (initialized) return@coroutineScope
        val startedAt = System.nanoTime()
        diagnostics.event("initialization", "START", startedAt, extractorVersion)
        val watcher = launch(Dispatchers.IO, start = CoroutineStart.UNDISPATCHED) {
            try { awaitCancellation() } finally { cancel(id) }
        }
        try {
            runInterruptible(Dispatchers.IO) {
                val engine = YoutubeDL.getInstance()
                engine.init(context)
                ExtractorMaintenance(installed).recover()
                extractorVersion = probe(engine, id)
                initialized = true
                diagnostics.event("initialization", "SUCCESS", startedAt, extractorVersion)
            }
        } catch (error: Exception) {
            currentCoroutineContext().ensureActive()
            diagnostics.event("initialization", "FAILED", startedAt, extractorVersion, classifyDownloadError(error))
            throw YoutubeSourceFailure(classifyDownloadError(error), "initialization", extractorVersion)
        } finally {
            withContext(NonCancellable) { watcher.cancelAndJoin() }
        }
    }

    private fun probe(engine: YoutubeDL, id: String): String = engine.execute(YoutubeDLRequest("").apply {
        addOption("--ignore-config")
        addOption("--version")
    }, id).out.trim().takeIf { it.matches(Regex("[0-9]{4}\\.[0-9]{2}\\.[0-9]{2}")) }
        ?: error("Invalid extractor version")

    /** Network fetch never owns the engine mutex; busy downloads defer activation. */
    internal suspend fun updateExtractor(): Boolean = coroutineScope {
        val processId = "extractor-maintenance"
        val startedAt = System.nanoTime()
        if (!engineLock.tryLock()) return@coroutineScope false
        val version = try {
            initializeExtractor(processId)
            extractorVersion
        } finally { engineLock.unlock() }
        val maintenance = ExtractorMaintenance(installed)
        if (maintenance.isDeferred()) return@coroutineScope true
        diagnostics.event("update", "START", startedAt, version)
        try {
            val candidate = runInterruptible(Dispatchers.IO) { maintenance.prepare(version) }
                ?: return@coroutineScope true.also { diagnostics.event("update", "SUCCESS", startedAt, version) }
            // Maintenance waits for an active transfer; transfers never wait for GitHub.
            engineLock.lock()
            try {
                val watcher = launch(Dispatchers.IO, start = CoroutineStart.UNDISPATCHED) {
                    try { awaitCancellation() } finally { cancel(processId) }
                }
                try {
                    runInterruptible(Dispatchers.IO) {
                        maintenance.activate(candidate) { probe(YoutubeDL.getInstance(), processId) }
                        extractorVersion = candidate.release.version
                    }
                } finally { withContext(NonCancellable) { watcher.cancelAndJoin() } }
            } finally { engineLock.unlock() }
            diagnostics.event("update", "SUCCESS", startedAt, extractorVersion)
            true
        } catch (error: Exception) {
            currentCoroutineContext().ensureActive()
            diagnostics.event("update", "FAILED", startedAt, version, DownloadError.ENGINE)
            true // Persisted maintenance backoff; never retry a user download to update.
        }
    }

}

/** Allowlisted diagnostic only: never retain native stderr, source URLs, or signed URLs. */
internal class YoutubeSourceFailure(
    val reason: DownloadError, stage: String, version: String,
    val refusal: SourceRefusal = SourceRefusal.NONE, val hint: SourceHint = SourceHint.NONE,
) :
    Exception("YouTube source ${reason.name}") {
    val diagnostic = "stage=$stage;extractor=$version;category=${reason.name};refusal=${refusal.name};hint=${hint.name}"
}

internal fun createAudioRequest(url: String, directory: File): YoutubeDLRequest =
    YoutubeDLRequest(url).apply {
        AudioDownloadPolicy.flags.forEach { addOption(it) }
        AudioDownloadPolicy.options.forEach { (option, value) -> addOption(option, value) }
        addOption("-o", File(directory, "audio.%(ext)s").absolutePath)
    }
