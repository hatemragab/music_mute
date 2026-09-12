package com.hatem.musicmute.processing

import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout

fun interface FormUploader {
    suspend fun upload(file: File, input: InputDeclaration, grant: UploadGrant, progress: (Long, Long) -> Unit)
}

class ProcessingTransferException(val problem: ProcessingLocalProblem) : IOException(problem.name)

/** Dedicated unauthenticated whole-file transport. It never accepts API headers or follows redirects. */
class S3FormUploader(
    private val connection: (URI) -> HttpURLConnection = { it.toURL().openConnection() as HttpURLConnection },
) : FormUploader {
    override suspend fun upload(file: File, input: InputDeclaration, grant: UploadGrant, progress: (Long, Long) -> Unit) {
        try {
            withTimeout(300_000) {
                suspendCancellableCoroutine<Unit> { continuation ->
                    val current = AtomicReference<HttpURLConnection?>()
                    val future = executor.submit {
                        try {
                            val uri = URI(grant.url)
                            if (uri.scheme != "https" || uri.host.isNullOrBlank() || uri.rawUserInfo != null || uri.rawFragment != null)
                                throw IOException("Upload grant is invalid")
                            if (!file.isFile || file.length() != input.bytes)
                                throw ProcessingTransferException(ProcessingLocalProblem.INPUT_CHANGED)
                            val expectedHeaders = setOf("content-type", "x-amz-checksum-sha256", "if-none-match")
                            if (grant.method != UploadMethod.PUT ||
                                grant.headers.keys.map(String::lowercase).toSet() != expectedHeaders ||
                                grant.headers.entries.any { (name, value) -> name.any(Char::isISOControl) || value.any(Char::isISOControl) } ||
                                grant.headers.entries.firstOrNull { it.key.equals("Content-Type", true) }?.value != input.contentType ||
                                grant.headers.entries.firstOrNull { it.key.equals("x-amz-checksum-sha256", true) }?.value != input.sha256 ||
                                grant.headers.entries.firstOrNull { it.key.equals("If-None-Match", true) }?.value != "*"
                            ) throw IOException("Upload grant is invalid")
                            val client = connection(uri)
                            current.set(client)
                            if (!continuation.isActive) return@submit
                            client.requestMethod = "PUT"
                            client.instanceFollowRedirects = false
                            client.connectTimeout = 15_000
                            client.readTimeout = 30_000
                            client.useCaches = false
                            client.doOutput = true
                            grant.headers.forEach(client::setRequestProperty)
                            client.setRequestProperty("Content-Length", input.bytes.toString())
                            client.setFixedLengthStreamingMode(input.bytes)
                            val digest = MessageDigest.getInstance("SHA-256")
                            client.outputStream.use { output ->
                                var sent = 0L
                                file.inputStream().use { source ->
                                    val buffer = ByteArray(64 * 1024)
                                    while (true) {
                                        if (!continuation.isActive || Thread.currentThread().isInterrupted) throw IOException("Upload stopped")
                                        val count = source.read(buffer)
                                        if (count < 0) break
                                        sent += count
                                        if (sent > input.bytes) throw ProcessingTransferException(ProcessingLocalProblem.INPUT_CHANGED)
                                        digest.update(buffer, 0, count)
                                        output.write(buffer, 0, count)
                                        progress(sent, input.bytes)
                                    }
                                }
                                if (sent != input.bytes || Base64.getEncoder().encodeToString(digest.digest()) != input.sha256)
                                    throw ProcessingTransferException(ProcessingLocalProblem.INPUT_CHANGED)
                            }
                            if (client.responseCode !in 200..299) throw IOException("Storage did not accept the upload")
                            if (continuation.isActive) continuation.resume(Unit)
                        } catch (error: Exception) {
                            if (continuation.isActive) continuation.resumeWithException(
                                if (error is ProcessingTransferException) error else IOException("Upload could not be completed")
                            )
                        } finally {
                            current.get()?.disconnect()
                        }
                    }
                    continuation.invokeOnCancellation {
                        current.get()?.disconnect()
                        future.cancel(true)
                    }
                }
            }
        } catch (_: TimeoutCancellationException) {
            throw IOException("Upload timed out")
        }
    }

    companion object {
        private val executor = Executors.newFixedThreadPool(2) { task -> Thread(task, "processing-upload").apply { isDaemon = true } }
    }
}
