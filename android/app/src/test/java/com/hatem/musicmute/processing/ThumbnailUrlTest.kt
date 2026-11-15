package com.hatem.musicmute.processing

import com.hatem.musicmute.auth.ApiWireJson
import java.time.Instant
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class ThumbnailUrlTest {
    private val url = "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg?sqp=Ab_-123%3D%3D&rs=signature"

    @Test fun preservesOnlyOriginalBoundedPublicYouTubeThumbnailUrls() {
        assertEquals(url, validatedThumbnailUrl(url))
        assertEquals("https://i.ytimg.com/vi_webp/jNQXAC9IVRw/maxresdefault.webp",
            validatedThumbnailUrl("https://i.ytimg.com/vi_webp/jNQXAC9IVRw/maxresdefault.webp"))
        for (invalid in listOf(null, "", " $url", url.replace("https:", "http:"),
            url.replace("i.ytimg.com", "i.ytimg.com.evil.test"),
            url.replace("i.ytimg.com", "user@i.ytimg.com"),
            url.replace("i.ytimg.com", "i.ytimg.com:443"),
            url.replace("jNQXAC9IVRw", "short"), url.replace("hqdefault.jpg", "../hqdefault.jpg"),
            url.replace("hqdefault.jpg", "hqdefault.png"), "$url#fragment", "$url&token=secret",
            "$url&rs=again", "$url&", url.replace("signature", ""),
            url.replace("signature", "a".repeat(1025)), url.replace("signature", "bad%2Fvalue"),
            url.replace("hqdefault.jpg", "%68qdefault.jpg"), url + "\n", "https://i.ytimg.com\\@evil.test/vi/jNQXAC9IVRw/a.jpg")) {
            assertNull(invalid, validatedThumbnailUrl(invalid))
        }
    }

    @Test fun cachedAndRealtimeJobsAcceptAbsentNullAndMalformedArtworkWithoutLosingTheJob() {
        val job = Job("id", "ready", Instant.EPOCH, Instant.EPOCH, JobInput("mp3", 32, 19.0), false, true)
        val encoded = Json.encodeToString(Job.serializer(), job)
        assertNull(Json.decodeFromString(Job.serializer(), encoded).thumbnailUrl)
        for (optional in listOf("null", "42", "false", "{}", "[]", "\"https://evil.test/image.jpg\"")) {
            assertNull(Json.decodeFromString(Job.serializer(), encoded.dropLast(1) + ",\"thumbnailUrl\":$optional}").thumbnailUrl)
        }
        val cached = job.copy(thumbnailUrl = url)
        assertEquals(url, Json.decodeFromString(Job.serializer(), Json.encodeToString(Job.serializer(), cached)).thumbnailUrl)
        val wire = ApiWireJson.request(Json.encodeToString(Job.serializer(), cached))
        assertTrue(wire.contains("\"thumbnail_url\""))
        assertEquals(url, Json.decodeFromString(Job.serializer(), ApiWireJson.response(wire)).thumbnailUrl)
        val invalid = job.copy(thumbnailUrl = "https://evil.test/image.jpg")
        assertNull(Json.decodeFromString(Job.serializer(), Json.encodeToString(Job.serializer(), invalid)).thumbnailUrl)
    }
}
