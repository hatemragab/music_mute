package com.hatem.musicmute.processing

import com.hatem.musicmute.auth.AuthApiClient
import com.hatem.musicmute.auth.AuthConfiguration
import com.hatem.musicmute.auth.AuthHttpResponse
import com.hatem.musicmute.auth.AuthHttpTransport
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class UrlImportsTest {
    private val importId = "68c000000000000000000001"
    private val jobId = "68c000000000000000000002"
    private val installed = "c21a2eaa-7e73-4f08-89da-6ac35baa83e1"
    private val source = "https://soundcloud.com/artist/track"

    private fun view(status: String, job: String? = null) =
        """{"import_id":"$importId","status":"$status","job_id":${job?.let { "\"$it\"" } ?: "null"},"error":null,"created_at":"2026-09-25T12:00:00Z","updated_at":"2026-09-25T12:01:00Z"}"""

    @Test fun shareTextRequiresOneLinkAndCanonicalizesTracking() {
        assertEquals("https://soundcloud.com/Artist/Track", UrlImportSource.canonical(
            " https://www.soundcloud.com/Artist/Track?utm_source=share "))
        assertEquals("https://www.tumblr.com/blog/123", UrlImportSource.canonical(
            "https://blog.tumblr.com/post/123/name?source=share"))
        assertEquals(source, UrlImportSource.sharedText("Listen here: $source"))
        assertNull(UrlImportSource.sharedText("$source https://www.tumblr.com/blog/123"))
        assertNull(UrlImportSource.sharedText("nothing to share"))
        for (bad in listOf("https://soundcloud.com/artist/sets/album",
            "https://soundcloud.com/artist/track?in=artist/sets/album",
            "https://soundcloud.com/artist/track#fragment")) {
            assertTrue(runCatching { UrlImportSource.canonical(bad) }.exceptionOrNull() is UrlImportFailure)
        }
    }

    @Test fun acceptsPublicProviderLinksWithoutDroppingMediaParameters() {
        for (url in listOf(
            "https://youtu.be/UXqq0ZvbOnk",
            "https://www.youtube.com/watch?v=UXqq0ZvbOnk",
            "https://www.youtube.com/shorts/UXqq0ZvbOnk",
            "https://www.facebook.com/share/v/19duj8sfLg/",
            "https://www.facebook.com/watch/?v=123456789",
            "https://www.instagram.com/reel/Example/?igsh=share",
            "https://www.tiktok.com/@creator/video/123456789",
            "https://vimeo.com/123456789",
        )) assertEquals(url, UrlImportSource.canonical(url))
    }

    @Test fun rejectsUnsafeUrlsBeforeSubmission() {
        for (url in listOf("file:///tmp/audio", "https://user:password@example.com/audio",
            "https://127.0.0.1/audio", "http://[::1]/audio", "http://localhost/audio",
            "https://service.internal/audio", "https://service.local/audio",
            "https://example.com:8080/audio", "https://example.com/audio#fragment",
            "https://example.com/a b")) {
            val error = runCatching { UrlImportSource.canonical(url) }.exceptionOrNull()
            assertTrue("Must reject $url", error is UrlImportFailure)
        }
    }

    @Test fun authenticatedWireRequestContainsOnlyUrlAndStableId() = runTest {
        val requestId = UUID.randomUUID().toString()
        var calls = 0
        val api = UrlImportsApiClient(AuthApiClient(
            AuthConfiguration("https://api.example.test", false), { "owner" }, { "token" },
            AuthHttpTransport { url, method, headers, body ->
                calls++
                assertEquals(if (calls == 1) "POST" else "GET", method)
                assertEquals("Bearer token", headers["Authorization"])
                if (calls == 1) {
                    assertTrue(url.endsWith("/media-imports"))
                    assertEquals(installed, headers["X-Installation-Id"])
                    val fields = Json.parseToJsonElement(body!!).jsonObject
                    assertEquals(setOf("url", "request_id"), fields.keys)
                    assertEquals(source, fields["url"]?.jsonPrimitive?.content)
                    assertEquals(requestId, fields["request_id"]?.jsonPrimitive?.content)
                } else {
                    assertTrue(url.endsWith("/media-imports/$importId"))
                    assertNull(headers["X-Installation-Id"])
                    assertNull(body)
                }
                AuthHttpResponse(if (calls == 1) 202 else 200,
                    if (calls == 1) view("queued") else view("submitted", jobId))
            }), { installed })
        assertEquals("queued", api.create(source, requestId).status)
        assertEquals(jobId, api.detail(importId).jobId)
    }

    @Test fun serverErrorCodesAreSanitized() = runTest {
        val api = UrlImportsApiClient(AuthApiClient(
            AuthConfiguration("https://api.example.test", false), { "owner" }, { "token" },
            AuthHttpTransport { _, _, _, _ -> AuthHttpResponse(422,
                """{"code":"IMPORT_SINGLE_ITEM_REQUIRED","message":"private upstream URL"}""") }),
            { installed })
        val error = runCatching { api.create(source, UUID.randomUUID().toString()) }
            .exceptionOrNull() as UrlImportFailure
        assertEquals("IMPORT_SINGLE_ITEM_REQUIRED", error.code)
        assertFalse(error.message.orEmpty().contains("private"))
    }

    @Test fun duplicateSubmissionAndUncertainReplyReuseDurableRequestId() = runTest {
        val store = ProcessingStore(kotlin.io.path.createTempDirectory("url-import-").toFile(), backgroundScope)
        val ticket = ProcessingSession("owner", 1)
        val requests = mutableListOf<String>()
        val api = object : UrlImportsApi {
            override suspend fun create(url: String, requestId: String): UrlImportView {
                requests += requestId
                if (requests.size == 1) throw UrlImportFailure("OFFLINE")
                return UrlImportView(importId, "queued", null, null, "time", "time")
            }
            override suspend fun detail(importId: String) =
                UrlImportView(importId, "submitted", jobId, null, "time", "time")
        }
        val coordinator = UrlImportCoordinator(store, api, backgroundScope, { ticket })
        coordinator.bindSession(ticket)
        coordinator.submit(source)
        coordinator.submit("https://www.soundcloud.com/artist/track?utm_source=copy")
        runCurrent()
        assertEquals(1, store.urlImports("owner").first().size)
        val saved = store.urlImports("owner").first().single()
        assertEquals("OFFLINE", saved.errorCode)
        advanceTimeBy(15_000)
        runCurrent()
        assertEquals(listOf(saved.requestId, saved.requestId), requests)
        advanceTimeBy(3_000)
        runCurrent()
        assertEquals(jobId, store.urlImports("owner").first().single().jobId)
        assertEquals("submitted", coordinator.records.value.single().status)
    }

    @Test fun restoredPendingImportUsesSavedIdentityAndDoesNotCrossAccounts() = runTest {
        val root = kotlin.io.path.createTempDirectory("url-import-restore-").toFile()
        val firstScope = SupervisorJob()
        val first = ProcessingStore(root, CoroutineScope(firstScope + Dispatchers.IO))
        val requestId = UUID.randomUUID().toString()
        first.addUrlImport("owner", UrlImportRecord("owner", source, requestId))
        firstScope.cancelAndJoin()
        val store = ProcessingStore(root, backgroundScope)
        assertTrue(store.urlImports("other").first().isEmpty())
        var observedId: String? = null
        val api = object : UrlImportsApi {
            override suspend fun create(url: String, requestId: String): UrlImportView {
                observedId = requestId
                return UrlImportView(importId, "submitted", jobId, null, "time", "time")
            }
            override suspend fun detail(importId: String): UrlImportView = error("unexpected poll")
        }
        val ticket = ProcessingSession("owner", 2)
        UrlImportCoordinator(store, api, backgroundScope, { ticket }).bindSession(ticket)
        runCurrent()
        assertEquals(requestId, observedId)
        assertEquals("submitted", store.urlImports("owner").first().single().status)
    }

    @Test fun boundedHistoryNeverDropsUnfinishedImportIdentities() = runTest {
        val store = ProcessingStore(kotlin.io.path.createTempDirectory("url-import-many-").toFile(), backgroundScope)
        repeat(25) { index ->
            store.addUrlImport("owner", UrlImportRecord("owner",
                "https://soundcloud.com/artist/track$index", UUID.randomUUID().toString()))
        }
        val pending = store.urlImports("owner").first()
        assertEquals(25, pending.size)
        assertEquals(25, pending.map { it.requestId }.distinct().size)
    }
}
