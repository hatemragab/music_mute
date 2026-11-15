package com.hatem.musicmute.library

import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.MediaType.Companion.toMediaType
import okio.Buffer
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class LibraryThumbnailLoaderTest {
    private val url = "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg"
    private val secondUrl = "https://i.ytimg.com/vi/jNQXAC9IVRw/mqdefault.jpg"

    @Test fun absentAndUnsafeUrlsKeepPlaceholderWithoutAnyRequest() = runTest {
        val loader = LibraryThumbnailLoader(fetch = { error("Unsafe URL must not be fetched") }, requestScope = backgroundScope)
        assertNull(loader.load(null))
        assertNull(loader.load("https://evil.test/image.jpg"))
    }

    @Test fun concurrentRowsAndLaterRecompositionReuseOneImageDownload() = runTest {
        var calls = 0
        val response = CompletableDeferred<ByteArray?>()
        val loader = LibraryThumbnailLoader(fetch = { calls++; response.await() }, requestScope = backgroundScope)
        val first = async { loader.load(url) }
        val second = async { loader.load(url) }
        runCurrent()
        assertEquals(1, calls)
        val bytes = byteArrayOf(1, 2, 3)
        response.complete(bytes)
        assertArrayEquals(bytes, first.await())
        assertArrayEquals(bytes, second.await())
        assertArrayEquals(bytes, loader.load(url))
        assertEquals(1, calls)
    }

    @Test fun cacheEvictsLeastRecentlyUsedBytesAndDoesNotPersistFailures() = runTest {
        var calls = 0
        val loader = LibraryThumbnailLoader(fetch = { calls++; byteArrayOf(1, 2, 3) }, cacheLimitBytes = 3, requestScope = backgroundScope)
        loader.load(url)
        loader.load(secondUrl)
        loader.load(url)
        assertEquals(3, calls)

        var attempts = 0
        val recoverable = LibraryThumbnailLoader(fetch = {
            attempts++
            if (attempts == 1) throw IOException("Synthetic image failure") else byteArrayOf(1)
        }, requestScope = backgroundScope)
        assertNull(recoverable.load(url))
        assertArrayEquals(byteArrayOf(1), recoverable.load(url))
    }

    @Test fun cancellingFirstDuplicateRowKeepsOtherVisibleSubscriberAndCachesCompletedImage() = runTest {
        var attempts = 0
        var transportCancelled = false
        val response = CompletableDeferred<ByteArray?>()
        val loader = LibraryThumbnailLoader(fetch = {
            attempts++
            try { response.await() }
            finally { transportCancelled = !response.isCompleted }
        }, requestScope = backgroundScope)
        val first = async { loader.load(url) }
        val visible = async { loader.load(url) }
        runCurrent()
        assertEquals(1, attempts)
        first.cancelAndJoin()
        runCurrent()
        assertFalse(transportCancelled)
        assertTrue(visible.isActive)
        response.complete(byteArrayOf(1, 2))
        assertArrayEquals(byteArrayOf(1, 2), visible.await())
        assertArrayEquals(byteArrayOf(1, 2), loader.load(url))
        assertEquals(1, attempts)
        assertFalse(transportCancelled)
    }

    @Test fun lastSubscriberLeavingCancelsTransportAndPermitsALaterLoad() = runTest {
        var attempts = 0
        var cancellations = 0
        val started = CompletableDeferred<Unit>()
        val loader = LibraryThumbnailLoader(fetch = {
            attempts++
            if (attempts == 1) {
                started.complete(Unit)
                try { CompletableDeferred<ByteArray?>().await() }
                finally { cancellations++ }
            }
            else byteArrayOf(1)
        }, requestScope = backgroundScope)
        val first = async { loader.load(url) }
        started.await()
        val waiting = async { loader.load(url) }
        runCurrent()
        first.cancelAndJoin()
        assertTrue(waiting.isActive)
        assertEquals(0, cancellations)
        waiting.cancelAndJoin()
        runCurrent()
        assertEquals(1, cancellations)
        assertArrayEquals(byteArrayOf(1), loader.load(url))
        assertEquals(2, attempts)
    }

    @Test fun requestConcurrencyIsBoundedAndUnobservedQueuedImagesAreNeverFetched() = runTest {
        val release = CompletableDeferred<ByteArray?>()
        var requests = 0
        var active = 0
        var peak = 0
        val loader = LibraryThumbnailLoader(fetch = {
            requests++
            active++
            peak = maxOf(peak, active)
            try { release.await() } finally { active-- }
        }, requestScope = backgroundScope)
        val visible = (1..5).map { index ->
            async { loader.load(url.replace("hqdefault", "image$index")) }
        }
        runCurrent()
        assertEquals(4, requests)
        assertEquals(4, peak)
        visible.last().cancelAndJoin()
        runCurrent()
        release.complete(byteArrayOf(1))
        visible.dropLast(1).forEach { assertArrayEquals(byteArrayOf(1), it.await()) }
        assertEquals(4, requests)
        assertEquals(0, active)
    }

    @Test fun publicHttpRequestCarriesOnlyImageHeadersAndRejectsRedirectsAndUnexpectedTypes() = runTest {
        for ((status, type) in listOf(200 to "image/jpeg", 200 to "image/webp", 200 to "text/html", 302 to "image/jpeg", 404 to "image/jpeg")) {
            var calls = 0
            val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
                .retryOnConnectionFailure(false).addInterceptor { chain ->
                    calls++
                    assertEquals(url, chain.request().url.toString())
                    assertEquals("GET", chain.request().method)
                    assertNull(chain.request().header("Authorization"))
                    assertNull(chain.request().header("X-Installation-Id"))
                    assertNull(chain.request().header("Cookie"))
                    Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                        .code(status).message("Synthetic fixture").header("Content-Type", type)
                        .header("Location", "https://evil.test/redirect.jpg")
                        .body(byteArrayOf(1, 2).toResponseBody(type.toMediaType())).build()
                }.build()
            val bytes = ThumbnailHttpFetcher(client).fetch(url)
            if (status == 200 && type.startsWith("image/")) assertArrayEquals(byteArrayOf(1, 2), bytes)
            else assertNull(bytes)
            assertEquals(1, calls)
        }
    }

    @Test fun publicHttpTransportRejectsBothDeclaredAndStreamedOversizedImages() = runTest {
        for (declaredSize in listOf(MAX_THUMBNAIL_BYTES + 1L, -1L)) {
            val client = OkHttpClient.Builder().addInterceptor { chain ->
                val body = object : ResponseBody() {
                    override fun contentType() = "image/jpeg".toMediaType()
                    override fun contentLength() = declaredSize
                    override fun source() = Buffer().write(ByteArray(MAX_THUMBNAIL_BYTES + 1))
                }
                Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                    .code(200).message("Synthetic fixture").header("Content-Type", "image/jpeg").body(body).build()
            }.build()
            assertNull(ThumbnailHttpFetcher(client).fetch(url))
        }
        val loader = LibraryThumbnailLoader(fetch = { ByteArray(MAX_THUMBNAIL_BYTES + 1) }, requestScope = backgroundScope)
        assertNull(loader.load(url))
    }
}
