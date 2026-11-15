package com.hatem.musicmute.library

import com.hatem.musicmute.processing.validatedThumbnailUrl
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

internal const val MAX_THUMBNAIL_BYTES = 1_048_576

/** Public-image transport only: no session headers, cookies, redirects, metadata or retries. */
internal class ThumbnailHttpFetcher(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .connectTimeout(5, TimeUnit.SECONDS).readTimeout(5, TimeUnit.SECONDS)
        .callTimeout(10, TimeUnit.SECONDS).build(),
) {
    suspend fun fetch(value: String): ByteArray? {
        val url = validatedThumbnailUrl(value) ?: return null
        return suspendCancellableCoroutine { continuation ->
            val call = client.newCall(Request.Builder().url(url)
                .header("Accept", "image/jpeg,image/webp").get().build())
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (continuation.isActive) continuation.resume(null)
                }

                override fun onResponse(call: Call, response: Response) {
                    val bytes = response.use {
                        if (!continuation.isActive || response.code != 200) return@use null
                        val type = response.header("Content-Type")?.substringBefore(';')?.trim()?.lowercase()
                        val body = response.body
                        if (type !in setOf("image/jpeg", "image/webp") ||
                            body.contentLength() > MAX_THUMBNAIL_BYTES) return@use null
                        try {
                            body.byteStream().use { input ->
                                val output = ByteArrayOutputStream()
                                val buffer = ByteArray(8192)
                                while (continuation.isActive) {
                                    val count = input.read(buffer)
                                    if (count < 0) return@use output.toByteArray().takeIf { it.isNotEmpty() }
                                    if (output.size() + count > MAX_THUMBNAIL_BYTES) return@use null
                                    output.write(buffer, 0, count)
                                }
                                null
                            }
                        } catch (_: IOException) { null }
                    }
                    if (continuation.isActive) continuation.resume(bytes)
                }
            })
        }
    }
}

/** Small memory-only LRU cache; concurrent rows reuse a single original-URL image request. */
internal class LibraryThumbnailLoader(
    private val fetch: suspend (String) -> ByteArray? = ThumbnailHttpFetcher()::fetch,
    private val cacheLimitBytes: Int = 4 * MAX_THUMBNAIL_BYTES,
    private val requestScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    private class PendingThumbnail(
        val identity: Any,
        val result: Deferred<ByteArray?>,
        var subscribers: Int = 0,
    )

    private val mutex = Mutex()
    private val slots = Semaphore(4)
    private val cache = LinkedHashMap<String, ByteArray>(16, 0.75f, true)
    private val pending = mutableMapOf<String, PendingThumbnail>()
    private var cacheBytes = 0

    suspend fun load(value: String?): ByteArray? {
        val url = validatedThumbnailUrl(value) ?: return null
        val request = mutex.withLock {
            cache[url]?.let { return it }
            val shared = pending[url] ?: run {
                val identity = Any()
                PendingThumbnail(identity, requestScope.async(start = CoroutineStart.LAZY) {
                    download(url, identity)
                }).also { pending[url] = it }
            }
            shared.also { it.subscribers++ }
        }
        try {
            request.result.start()
            return request.result.await()
        } finally {
            withContext(NonCancellable) {
                mutex.withLock {
                    request.subscribers--
                    if (request.subscribers == 0 && pending[url] === request) {
                        // A row's cancellation never interrupts other rows displaying this URL.
                        // Cancel queued/network work immediately when its final subscriber leaves.
                        pending.remove(url)
                        request.result.cancel()
                    }
                }
            }
        }
    }

    private suspend fun download(url: String, identity: Any): ByteArray? {
        var result: ByteArray? = null
        try {
            result = slots.withPermit { fetch(url) }?.takeIf { it.isNotEmpty() && it.size <= MAX_THUMBNAIL_BYTES }
            return result
        } catch (error: CancellationException) { throw error }
        catch (_: Exception) { return null }
        finally {
            withContext(NonCancellable) {
                mutex.withLock {
                    // An abandoned request must not remove or cache over its newer replacement.
                    if (pending[url]?.identity === identity) {
                        result?.takeIf { it.size <= cacheLimitBytes }?.let { bytes ->
                            cache[url] = bytes
                            cacheBytes += bytes.size
                            while (cacheBytes > cacheLimitBytes) {
                                val oldest = cache.entries.iterator()
                                cacheBytes -= oldest.next().value.size
                                oldest.remove()
                            }
                        }
                        pending.remove(url)
                    }
                }
            }
        }
    }
}
