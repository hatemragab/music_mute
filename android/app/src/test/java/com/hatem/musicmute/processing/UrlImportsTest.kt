package com.hatem.musicmute.processing

import com.hatem.musicmute.auth.AuthApiClient
import com.hatem.musicmute.auth.AuthConfiguration
import com.hatem.musicmute.auth.AuthHttpResponse
import com.hatem.musicmute.auth.AuthHttpTransport
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
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
            "https://www.facebook.com/share/v/19duj8sfLg/",
            "https://www.facebook.com/watch/?v=123456789",
            "https://benprunty.bandcamp.com/track/lanius-battle",
            "https://www.mixcloud.com/dholbach/cryptkeeper/",
        )) assertEquals(url, UrlImportSource.canonical(url))
    }

    @Test fun canonicalizesYouTubeAliasesToOneSourceBeforeSubmission() {
        for (url in listOf(
            "https://youtu.be/UXqq0ZvbOnk",
            "https://www.youtube.com/watch?v=UXqq0ZvbOnk",
            "https://www.youtube.com/shorts/UXqq0ZvbOnk",
        )) assertEquals("https://www.youtube.com/watch?v=UXqq0ZvbOnk", UrlImportSource.canonical(url))
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

    @Test fun authenticatedWireRequestContainsUrlStableIdAndTrimChoice() = runTest {
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
                    assertEquals(setOf("url", "request_id", "trim_enabled"), fields.keys)
                    assertEquals("false", fields["trim_enabled"]?.jsonPrimitive?.content)
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

    @Test fun realtimeSnapshotsRetainMeasuredImportDurationsThroughSubmission() = runTest {
        val store = ProcessingStore(kotlin.io.path.createTempDirectory("url-import-timings-").toFile(), backgroundScope)
        val ticket = ProcessingSession("owner", 1)
        val uploading = ServerStageTimings(2_300, false, listOf(
            ServerStageMeasurement("source-download", 1_800, true),
            ServerStageMeasurement("input-upload", 500, false),
        ))
        val submitted = uploading.copy(totalMs = 2_800, totalComplete = true)
        val finish = CompletableDeferred<Unit>()
        val api = object : UrlImportsApi {
            override suspend fun create(url: String, requestId: String) =
                UrlImportView(importId, "queued", null, null, "time", "time")
            override suspend fun detail(importId: String): UrlImportView = error("snapshots own progress")
            override fun updates(importId: String) = flow {
                emit(UrlImportView(importId, "uploading", null, null, "time", "time", uploading))
                finish.await()
                emit(UrlImportView(importId, "submitted", jobId, null, "time", "time", submitted))
            }
        }
        val coordinator = UrlImportCoordinator(store, api, backgroundScope, { ticket })
        coordinator.bindSession(ticket)
        coordinator.submit(source)
        runCurrent()
        assertEquals(uploading, coordinator.records.value.single().serverStageTimings)
        assertEquals(2_300L, audioTaskPresentations(emptyList(), emptyList(), 0,
            coordinator.records.value).single().totalElapsedMs)
        finish.complete(Unit)
        runCurrent()
        assertEquals(submitted, store.urlImports("owner").first().single().serverStageTimings)
    }

    @Test fun terminalRetryRequiresExplicitActionAndPreservesSavedSourceAndTrimWithOneNewIdentity() = runTest {
        val store = ProcessingStore(kotlin.io.path.createTempDirectory("url-import-retry-").toFile(), backgroundScope)
        val original = store.addUrlImport("owner", UrlImportRecord("owner", source,
            UUID.randomUUID().toString(), sourceTitle = "Saved title", trimEnabled = false))
        store.updateUrlImport("owner", original.requestId) {
            it.copy(status = "failed", errorCode = "IMPORT_DEPENDENCY_FAILED", importId = importId)
        }
        val ticket = ProcessingSession("owner", 1)
        val requests = mutableListOf<Triple<String, String, Boolean>>()
        val api = object : UrlImportsApi {
            override suspend fun create(url: String, requestId: String): UrlImportView = error("trim must be explicit")
            override suspend fun create(url: String, requestId: String, trimEnabled: Boolean): UrlImportView {
                requests += Triple(url, requestId, trimEnabled)
                return UrlImportView(importId, "queued", null, null, "time", "time")
            }
            override suspend fun detail(importId: String): UrlImportView = error("snapshots own progress")
            override fun updates(importId: String) = flow {
                emit(UrlImportView(importId, "submitted", jobId, null, "time", "time"))
            }
        }
        val coordinator = UrlImportCoordinator(store, api, backgroundScope, { ticket })
        coordinator.bindSession(ticket)
        runCurrent()
        advanceTimeBy(30_000)
        runCurrent()
        assertTrue(requests.isEmpty())
        val saved = coordinator.records.value.single()
        // The stored settings, rather than an old or altered UI snapshot, own the retry.
        val stale = saved.copy(url = "https://soundcloud.com/other/track", trimEnabled = true)
        backgroundScope.launch { coordinator.retry(stale) }
        backgroundScope.launch { coordinator.retry(stale) }
        runCurrent()
        assertEquals(1, requests.size)
        assertEquals(source, requests.single().first)
        assertNotEquals(saved.requestId, requests.single().second)
        assertEquals(4, UUID.fromString(requests.single().second).version())
        assertFalse(requests.single().third)
        assertEquals("submitted", coordinator.records.value.single().status)
        assertEquals("Saved title", coordinator.records.value.single().sourceTitle)
        assertTrue(coordinator.retrying.value.isEmpty())
        coordinator.retry(saved)
        runCurrent()
        assertEquals(1, requests.size)
    }

    @Test fun uncertainAdmissionRetryReusesIdentityAndExistingImportUsesOnlySnapshots() = runTest {
        for (existingImport in listOf(null, importId)) {
            val store = ProcessingStore(kotlin.io.path.createTempDirectory("url-import-attention-").toFile(), backgroundScope)
            val original = store.addUrlImport("owner", UrlImportRecord("owner", source,
                UUID.randomUUID().toString(), trimEnabled = false))
            store.updateUrlImport("owner", original.requestId) {
                it.copy(status = "attention", errorCode = "SERVICE_UNAVAILABLE", importId = existingImport)
            }
            val requests = mutableListOf<String>()
            val watched = mutableListOf<String>()
            val api = object : UrlImportsApi {
                override suspend fun create(url: String, requestId: String): UrlImportView {
                    requests += requestId
                    return UrlImportView(importId, "queued", null, null, "time", "time")
                }
                override suspend fun detail(importId: String): UrlImportView = error("snapshots own progress")
                override fun updates(importId: String) = flow {
                    watched += importId
                    emit(UrlImportView(importId, "submitted", jobId, null, "time", "time"))
                }
            }
            val ticket = ProcessingSession("owner", 1)
            val coordinator = UrlImportCoordinator(store, api, backgroundScope, { ticket })
            coordinator.bindSession(ticket)
            runCurrent()
            val saved = coordinator.records.value.single()
            coordinator.retry(saved)
            coordinator.retry(saved)
            runCurrent()
            assertEquals(if (existingImport == null) listOf(saved.requestId) else emptyList<String>(), requests)
            assertEquals(listOf(importId), watched)
            assertEquals(saved.requestId, coordinator.records.value.single().requestId)
            assertFalse(coordinator.records.value.single().trimEnabled)
            assertEquals("submitted", coordinator.records.value.single().status)
            coordinator.bindSession(null)
        }
    }

    @Test fun terminalInputFailureCannotRetryEvenWhenCallerClaimsTransientError() = runTest {
        val store = ProcessingStore(kotlin.io.path.createTempDirectory("url-import-invalid-retry-").toFile(), backgroundScope)
        val original = store.addUrlImport("owner", UrlImportRecord("owner", source, UUID.randomUUID().toString()))
        store.updateUrlImport("owner", original.requestId) {
            it.copy(status = "failed", errorCode = "IMPORT_INVALID_AUDIO")
        }
        val ticket = ProcessingSession("owner", 1)
        val api = object : UrlImportsApi {
            override suspend fun create(url: String, requestId: String): UrlImportView = error("must not retry")
            override suspend fun detail(importId: String): UrlImportView = error("must not read")
        }
        val coordinator = UrlImportCoordinator(store, api, backgroundScope, { ticket })
        coordinator.bindSession(ticket)
        runCurrent()
        val saved = coordinator.records.value.single()
        coordinator.retry(saved.copy(errorCode = "IMPORT_DEPENDENCY_FAILED"))
        runCurrent()
        assertEquals(saved, coordinator.records.value.single())
        assertTrue(coordinator.retrying.value.isEmpty())
    }

    @Test fun explicitFormResubmissionRecoversPolicyBlockedAdmissionWithoutChangingIdentityOrTrim() = runTest {
        val store = ProcessingStore(kotlin.io.path.createTempDirectory("url-import-policy-resume-").toFile(), backgroundScope)
        val original = store.addUrlImport("owner", UrlImportRecord("owner", source,
            UUID.randomUUID().toString(), trimEnabled = false))
        store.updateUrlImport("owner", original.requestId) {
            it.copy(status = "attention", errorCode = "EMAIL_VERIFICATION_REQUIRED")
        }
        val requests = mutableListOf<Pair<String, Boolean>>()
        val api = object : UrlImportsApi {
            override suspend fun create(url: String, requestId: String): UrlImportView = error("trim must be explicit")
            override suspend fun create(url: String, requestId: String, trimEnabled: Boolean): UrlImportView {
                requests += requestId to trimEnabled
                return UrlImportView(importId, "submitted", jobId, null, "time", "time")
            }
            override suspend fun detail(importId: String): UrlImportView = error("must not read")
        }
        val ticket = ProcessingSession("owner", 1)
        val coordinator = UrlImportCoordinator(store, api, backgroundScope, { ticket })
        coordinator.bindSession(ticket)
        runCurrent()
        assertFalse(coordinator.records.value.single().retryable)
        coordinator.submit(source, trimEnabled = true)
        runCurrent()
        assertEquals(listOf(original.requestId to false), requests)
        assertEquals("submitted", coordinator.records.value.single().status)
    }

    @Test fun rejectedNewAttemptKeepsSafeErrorAndDoesNotAutomaticallyCreateAnotherAttempt() = runTest {
        val store = ProcessingStore(kotlin.io.path.createTempDirectory("url-import-retry-rejection-").toFile(), backgroundScope)
        val original = store.addUrlImport("owner", UrlImportRecord("owner", source, UUID.randomUUID().toString()))
        store.updateUrlImport("owner", original.requestId) {
            it.copy(status = "failed", errorCode = "IMPORT_DEPENDENCY_FAILED")
        }
        var calls = 0
        val api = object : UrlImportsApi {
            override suspend fun create(url: String, requestId: String): UrlImportView {
                calls++
                throw UrlImportFailure("ACCOUNT_DISABLED")
            }
            override suspend fun detail(importId: String): UrlImportView = error("must not read")
        }
        val ticket = ProcessingSession("owner", 1)
        val coordinator = UrlImportCoordinator(store, api, backgroundScope, { ticket })
        coordinator.bindSession(ticket)
        runCurrent()
        coordinator.retry(coordinator.records.value.single())
        runCurrent()
        advanceTimeBy(30_000)
        runCurrent()
        assertEquals(1, calls)
        val rejected = coordinator.records.value.single()
        assertEquals("attention", rejected.status)
        assertEquals("ACCOUNT_DISABLED", rejected.errorCode)
        assertFalse(rejected.retryable)
        assertTrue(rejected.removable)
        coordinator.retry(rejected)
        runCurrent()
        assertEquals(1, calls)
    }

    @Test fun retryRejectsOtherOwnerAndIgnoresLateReplyFromPreviousSessionEpoch() = runTest {
        val store = ProcessingStore(kotlin.io.path.createTempDirectory("url-import-session-retry-").toFile(), backgroundScope)
        val original = store.addUrlImport("owner", UrlImportRecord("owner", source, UUID.randomUUID().toString()))
        store.updateUrlImport("owner", original.requestId) {
            it.copy(status = "failed", errorCode = "IMPORT_DEPENDENCY_FAILED")
        }
        val reply = CompletableDeferred<UrlImportView>()
        var calls = 0
        val api = object : UrlImportsApi {
            override suspend fun create(url: String, requestId: String): UrlImportView {
                calls++
                return withContext(NonCancellable) { reply.await() }
            }
            override suspend fun detail(importId: String): UrlImportView = error("must not read")
        }
        var ticket: ProcessingSession? = ProcessingSession("owner", 1)
        val coordinator = UrlImportCoordinator(store, api, backgroundScope, { ticket })
        coordinator.bindSession(ticket)
        runCurrent()
        val saved = coordinator.records.value.single()
        assertEquals("UNAUTHENTICATED", (runCatching {
            coordinator.retry(saved.copy(ownerUid = "other"))
        }.exceptionOrNull() as UrlImportFailure).code)
        assertEquals(0, calls)
        coordinator.retry(saved)
        runCurrent()
        assertEquals(1, calls)
        ticket = ProcessingSession("owner", 2)
        coordinator.bindSession(null)
        reply.complete(UrlImportView(importId, "submitted", jobId, null, "time", "time"))
        runCurrent()
        assertTrue(coordinator.records.value.isEmpty())
        assertTrue(coordinator.retrying.value.isEmpty())
        assertEquals("pending", store.urlImports("owner").first().single().status)
        assertNull(store.urlImports("owner").first().single().jobId)
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

    @Test fun removalIsDurableAndCannotRemoveActiveOrAnotherOwnersImport() = runTest {
        val root = kotlin.io.path.createTempDirectory("url-import-remove-").toFile()
        val storeJob = SupervisorJob()
        val store = ProcessingStore(root, CoroutineScope(storeJob + Dispatchers.IO))
        val failed = UrlImportRecord("owner", source, UUID.randomUUID().toString())
        store.addUrlImport("owner", failed)
        store.updateUrlImport("owner", failed.requestId) { it.copy(status = "attention", errorCode = "PROCESSING_LIMIT_REACHED") }
        val active = failed.copy(url = "$source-other", requestId = UUID.randomUUID().toString())
        store.addUrlImport("owner", active)
        val ticket = ProcessingSession("owner", 1)
        val api = object : UrlImportsApi {
            override suspend fun create(url: String, requestId: String): UrlImportView = error("unexpected submission")
            override suspend fun detail(importId: String): UrlImportView = error("unexpected read")
        }
        val coordinator = UrlImportCoordinator(store, api, backgroundScope, { ticket })
        coordinator.bindSession(ticket)
        val saved = store.urlImports("owner").first().first { it.requestId == failed.requestId }
        assertTrue(audioTaskPresentations(emptyList(), emptyList(), 0, listOf(saved)).single().canDelete)
        assertTrue(runCatching { coordinator.remove(saved.copy(ownerUid = "other")) }.isFailure)
        coordinator.remove(active)
        coordinator.remove(saved)
        coordinator.bindSession(null)
        storeJob.cancelAndJoin()
        val restored = ProcessingStore(root, backgroundScope)
        assertEquals(listOf(active.requestId), restored.urlImports("owner").first().map { it.requestId })
    }

    @Test fun failuresExpireWithoutDroppingActiveOrSubmittedRecovery() = runTest {
        val store = ProcessingStore(kotlin.io.path.createTempDirectory("url-import-expire-").toFile(), backgroundScope)
        val start = System.currentTimeMillis()
        val failed = UrlImportRecord("owner", source, UUID.randomUUID().toString())
        store.addUrlImport("owner", failed)
        store.updateUrlImport("owner", failed.requestId) { it.copy(status = "failed", failedAtMillis = start) }
        val active = failed.copy(url = "$source-active", requestId = UUID.randomUUID().toString())
        store.addUrlImport("owner", active)
        val submitted = failed.copy(url = "$source-submitted", requestId = UUID.randomUUID().toString())
        store.addUrlImport("owner", submitted)
        store.updateUrlImport("owner", submitted.requestId) { it.copy(status = "submitted", jobId = jobId) }
        store.pruneFailedUrlImports("owner", start + UrlImportRecord.FAILURE_RETENTION_MILLIS - 1)
        assertEquals(3, store.urlImports("owner").first().size)
        store.pruneFailedUrlImports("owner", start + UrlImportRecord.FAILURE_RETENTION_MILLIS)
        assertEquals(setOf(active.requestId, submitted.requestId), store.urlImports("owner").first().map { it.requestId }.toSet())
    }

    @Test fun legacyFailuresGetOneRetentionWindowAndAreActuallyRemovedFromStorage() = runTest {
        val root = kotlin.io.path.createTempDirectory("url-import-legacy-").toFile()
        val file = java.io.File(processingOwnerDirectory(root, "owner"), "processing.json")
        file.parentFile!!.mkdirs()
        val request = UUID.randomUUID().toString()
        file.writeText("""{"urlImports":[{"ownerUid":"owner","url":"$source","requestId":"$request","status":"failed"}]}""")
        val store = ProcessingStore(root, backgroundScope)
        store.pruneFailedUrlImports("owner", 1000)
        assertEquals(1000, store.urlImports("owner").first().single().failedAtMillis)
        store.pruneFailedUrlImports("owner", 2000)
        assertEquals(1000, store.urlImports("owner").first().single().failedAtMillis)
        store.pruneFailedUrlImports("owner", 1000 + UrlImportRecord.FAILURE_RETENTION_MILLIS)
        assertTrue(store.urlImports("owner").first().isEmpty())
        assertFalse(file.readText().contains(request))
    }
}
