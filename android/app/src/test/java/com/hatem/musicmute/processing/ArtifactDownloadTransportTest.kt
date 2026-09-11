package com.hatem.musicmute.processing

import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.launch
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ArtifactDownloadTransportTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test fun streamsWithoutBearerAndRejectsRedirects() = runBlocking {
        val connection = FakeConnection(200, "mp3-bytes".toByteArray())
        val transport = UrlConnectionArtifactDownloader { connection }
        val file = File(temporary.root, "output.partial")
        transport.download("https://storage.invalid/output", file) { _, _ -> }
        assertEquals("mp3-bytes", file.readText())
        assertFalse(connection.instanceFollowRedirects)
        assertEquals("GET", connection.requestMethod)
        assertNull(connection.getRequestProperty("Authorization"))
        assertNull(connection.getRequestProperty("X-Installation-Id"))
        assertEquals("", connection.getRequestProperty("Cookie"))
        assertTrue(connection.disconnected)
        val redirect = UrlConnectionArtifactDownloader { FakeConnection(302, byteArrayOf()) }
        try { redirect.download("https://storage.invalid/output", file) { _, _ -> }; fail("Redirect accepted") }
        catch (error: ArtifactHttpException) { assertEquals(302, error.status) }
    }

    @Test fun unsafeUrlsNeverOpenConnection() = runBlocking {
        val transport = UrlConnectionArtifactDownloader { error("Connection must not open") }
        for (url in listOf("http://storage.invalid/a", "https://user:pass@storage.invalid/a", "file:///a", "https://storage.invalid/a#fragment")) {
            try { transport.download(url, File(temporary.root, "partial")) { _, _ -> }; fail("Unsafe URL accepted") }
            catch (error: ArtifactException) { assertEquals(ArtifactProblem.TRANSFER, error.problem) }
        }
    }

    @Test fun truncatedContentCannotSucceedAndProgressUsesActualBytes() = runBlocking {
        val progress = mutableListOf<Pair<Long, Long?>>()
        val truncated = UrlConnectionArtifactDownloader { FakeConnection(200, byteArrayOf(1, 2), expected = 8) }
        try { truncated.download("https://storage.invalid/output", File(temporary.root, "partial")) { bytes, total -> progress += bytes to total }; fail("Truncated body accepted") }
        catch (error: ArtifactException) { assertEquals(ArtifactProblem.TRANSFER, error.problem) }
        assertEquals(2L to 8L, progress.last())
    }

    @Test fun cancellationDisconnectsBlockedReadAndRemovesOwnedPartial() = runBlocking {
        val started = kotlinx.coroutines.CompletableDeferred<Unit>()
        val released = java.util.concurrent.CountDownLatch(1)
        val connection = object : HttpURLConnection(URL("https://storage.invalid/output")) {
            @Volatile var disconnected = false
            override fun connect() = Unit
            override fun usingProxy() = false
            override fun disconnect() { disconnected = true; released.countDown() }
            override fun getResponseCode() = 200
            override fun getContentLengthLong() = -1L
            override fun getInputStream(): InputStream = object : InputStream() {
                override fun read(): Int { started.complete(Unit); released.await(); return -1 }
            }
        }
        val file = File(temporary.root, "owned.partial")
        val transport = UrlConnectionArtifactDownloader { connection }
        val pending = launch { transport.download("https://storage.invalid/output", file) { _, _ -> } }
        started.await()
        pending.cancel()
        pending.join()
        assertTrue(connection.disconnected)
        assertFalse(file.exists())
    }

    private class FakeConnection(
        private val code: Int,
        private val bytes: ByteArray,
        private val expected: Long = bytes.size.toLong(),
    ) : HttpURLConnection(URL("https://storage.invalid/output")) {
        var disconnected = false
        override fun connect() = Unit
        override fun disconnect() { disconnected = true }
        override fun usingProxy() = false
        override fun getResponseCode() = code
        override fun getContentLengthLong() = expected
        override fun getInputStream(): InputStream = ByteArrayInputStream(bytes)
    }
}
