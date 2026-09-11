package com.hatem.musicmute.processing

import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
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
                            val boundary = "vocal-${UUID.randomUUID()}"
                            val parts = signedFormParts(grant.fields, input.extension, boundary)
                            if (!file.isFile || file.length() != input.bytes)
                                throw ProcessingTransferException(ProcessingLocalProblem.INPUT_CHANGED)
                            val client = connection(uri)
                            current.set(client)
                            if (!continuation.isActive) return@submit
                            client.requestMethod = "POST"
                            client.instanceFollowRedirects = false
                            client.connectTimeout = 15_000
                            client.readTimeout = 30_000
                            client.useCaches = false
                            client.doOutput = true
                            client.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
                            client.setFixedLengthStreamingMode(parts.first.size.toLong() + input.bytes + parts.second.size)
                            val digest = MessageDigest.getInstance("SHA-256")
                            client.outputStream.use { output ->
                                output.write(parts.first)
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
                                output.write(parts.second)
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

/** Signed values are emitted verbatim; the file is always the final form item. */
internal fun signedFormParts(fields: Map<String, String>, extension: String, boundary: String): Pair<ByteArray, ByteArray> {
    require(extension.matches(Regex("[a-z0-9]{1,8}")))
    require(boundary.matches(Regex("[a-zA-Z0-9-]+")))
    val prefix = buildString {
        fields.forEach { (name, value) ->
            require(name.isNotEmpty() && name.none { it.isISOControl() })
            val escaped = name.replace("\\", "\\\\").replace("\"", "\\\"")
            append("--$boundary\r\nContent-Disposition: form-data; name=\"$escaped\"\r\n\r\n")
            append(value)
            append("\r\n")
        }
        append("--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"input.$extension\"\r\n")
        append("Content-Type: application/octet-stream\r\n\r\n")
    }.toByteArray(Charsets.UTF_8)
    return prefix to "\r\n--$boundary--\r\n".toByteArray(Charsets.UTF_8)
}
