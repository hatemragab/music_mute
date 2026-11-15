package com.hatem.musicmute.processing

import com.hatem.musicmute.diagnostics.LocalDiagnostics
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout

fun interface ArtifactDownloader {
    suspend fun download(url: String, destination: File, progress: (Long, Long?) -> Unit)
}

class ArtifactHttpException(val status: Int) : IOException("Artifact HTTP $status")

/** Dedicated HTTPS storage transport: no API session, bearer or installation headers. */
class UrlConnectionArtifactDownloader(
    private val openConnection: (URI) -> HttpURLConnection = { it.toURL().openConnection() as HttpURLConnection },
) : ArtifactDownloader {
    override suspend fun download(url: String, destination: File, progress: (Long, Long?) -> Unit) {
        val uri = runCatching { URI(url) }.getOrNull()
        if (uri == null || uri.scheme != "https" || uri.host.isNullOrBlank() ||
            uri.rawUserInfo != null || uri.rawFragment != null) throw ArtifactException(ArtifactProblem.TRANSFER)
        withTimeout(120_000) {
            suspendCancellableCoroutine<Unit> { continuation ->
                val connection = AtomicReference<HttpURLConnection?>()
                val output = AtomicReference<FileOutputStream?>()
                val gate = Any()
                val traceId = java.util.UUID.randomUUID().toString()
                val future = executor.submit {
                    val started = System.nanoTime()
                    var result = "failed"
                    var status: Int? = null
                    var received = 0L
                    var failure: Map<String, Any> = emptyMap()
                    try {
                        val client = openConnection(uri)
                        connection.set(client)
                        if (!continuation.isActive) return@submit
                        client.requestMethod = "GET"
                        client.instanceFollowRedirects = false
                        client.connectTimeout = 15_000
                        client.readTimeout = 15_000
                        client.useCaches = false
                        client.setRequestProperty("Cookie", "")
                        client.setRequestProperty("Accept", "audio/mpeg, application/octet-stream")
                        status = client.responseCode
                        if (status != 200) throw ArtifactHttpException(status)
                        val expected = client.contentLengthLong.takeIf { it >= 0 }
                        progress(received, expected)
                        client.inputStream.use { input ->
                            val sink = synchronized(gate) {
                                if (!continuation.isActive) return@submit
                                try { FileOutputStream(destination).also { output.set(it) } }
                                catch (_: IOException) { throw ArtifactException(ArtifactProblem.STORAGE) }
                            }
                            sink.use {
                                val buffer = ByteArray(64 * 1024)
                                while (continuation.isActive) {
                                    val count = input.read(buffer)
                                    if (count < 0) break
                                    if (count == 0) continue
                                    if (!continuation.isActive) return@submit
                                    try { sink.write(buffer, 0, count) }
                                    catch (_: IOException) { throw ArtifactException(ArtifactProblem.STORAGE) }
                                    received += count
                                    if (expected != null && received > expected) throw ArtifactException(ArtifactProblem.TRANSFER)
                                    progress(received, expected)
                                }
                                if (!continuation.isActive) return@submit
                                if (expected != null && received != expected) throw ArtifactException(ArtifactProblem.TRANSFER)
                                try { sink.fd.sync() }
                                catch (_: IOException) { throw ArtifactException(ArtifactProblem.STORAGE) }
                            }
                        }
                        client.disconnect()
                        result = "completed"
                        if (continuation.isActive) continuation.resume(Unit)
                    } catch (error: Exception) {
                        failure = LocalDiagnostics.error(error)
                        if (continuation.isActive) continuation.resumeWithException(
                            if (error is ArtifactHttpException || error is ArtifactException) error
                            else ArtifactException(ArtifactProblem.TRANSFER))
                    } finally {
                        connection.get()?.disconnect()
                        runCatching { output.get()?.close() }
                        if (result == "failed" && !continuation.isActive) result = "aborted_or_failed"
                        LocalDiagnostics.emit("transfer.download_completed", "transfer", if (result == "completed") "info" else "warn", mapOf("operation" to "artifact.download", "bytes" to received, "status" to status, "result" to result, "durationMs" to (System.nanoTime() - started) / 1_000_000.0, "body" to mapOf("omitted" to "binary_stream"), "error" to failure), traceId = traceId)
                    }
                }
                continuation.invokeOnCancellation {
                    synchronized(gate) {
                        connection.get()?.disconnect()
                        runCatching { output.get()?.close() }
                        destination.delete()
                    }
                    future.cancel(true)
                }
            }
        }
    }

    companion object {
        private val executor = Executors.newFixedThreadPool(2) { task ->
            Thread(task, "processing-output").apply { isDaemon = true }
        }
    }
}
