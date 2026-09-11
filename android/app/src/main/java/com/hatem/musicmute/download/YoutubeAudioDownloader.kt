package com.hatem.musicmute.download

import android.content.Context
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import java.io.File
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

class YoutubeAudioDownloader(private val context: Context) : AudioDownloader {
    private val engineLock = Mutex()
    private var lastUpdateAttempt = 0L

    override suspend fun download(
        id: String,
        url: String,
        directory: File,
        onProgress: (DownloadProgress) -> Unit,
    ): DownloadedAudio =
        engineLock.withLock {
            coroutineScope {
                val job = currentCoroutineContext().job
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
                        if (System.currentTimeMillis() - lastUpdateAttempt > 24 * 60 * 60 * 1000L) {
                            // An update outage must not prevent trying the bundled extractor.
                            try {
                                engine.updateYoutubeDL(context)
                            } catch (error: InterruptedException) {
                                throw error
                            } catch (_: Exception) {
                                /* The actual download still reports failures normally. */
                            }
                            lastUpdateAttempt = System.currentTimeMillis()
                        }
                        check(directory.isDirectory || directory.mkdirs()) {
                            "Unable to create download directory"
                        }
                        val request = createAudioRequest(url, directory)
                        job.ensureActive()
                        engine.execute(request, id) { progress, _, line ->
                            onProgress(DownloadProgress.parse(progress, line))
                        }
                        DownloadedAudioReader.read(directory)
                    }
                } finally {
                    withContext(NonCancellable) { cancellationWatcher.cancelAndJoin() }
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
