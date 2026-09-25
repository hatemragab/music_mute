package com.hatem.musicmute.processing

import com.hatem.musicmute.auth.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import java.time.Instant
import org.junit.Assert.*
import org.junit.Test

class JobsApiClientTest {
    @Test fun rateLimitStopsOtherJobRoutesBeforeTransport() = runTest {
        var calls = 0
        val api = client(AuthHttpTransport { _, _, _, _ ->
            calls++
            if (calls == 1) AuthHttpResponse(429, "{}", "60") else AuthHttpResponse(200, mutation)
        }, nowNanos = { testScheduler.currentTime * 1_000_000 })
        runCatching { api.list() }
        val error = runCatching { api.cancel(id) }.exceptionOrNull() as JobsFailure
        runCatching { api.detail(id) }
        assertEquals(JobsProblem.RATE_LIMITED, error.problem)
        assertEquals(1, calls)
        testScheduler.advanceTimeBy(60_000)
        assertEquals("queued", api.cancel(id).status)
        assertEquals(2, calls)
    }

    private val id = "68c000000000000000000001"
    private val requestId = "c21a2eaa-7e73-4f08-89da-6ac35baa83e1"
    private val input = InputDeclaration("mp3", "audio/mpeg", 42, 1.5, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
    private val grant = """{"url":"https://storage.example/file","expires_at":"2026-09-09T12:15:00.000Z"}"""
    private val upload get() = grant.dropLast(1) + """, "method":"PUT","headers":{"Content-Type":"audio/mpeg","x-amz-checksum-sha256":"${input.sha256}","If-None-Match":"*"}}"""
    private val mutation get() = """{"id":"$id","status":"queued"}"""
    private fun job(status: String) = """{"id":"$id","status":"$status","created_at":"2026-09-09T12:00:00Z","updated_at":"2026-09-09T12:01:00Z","input":{"extension":"mp3","bytes":42,"duration_seconds":1.5},"can_download_input":true,"can_download_output":false}"""
    private fun client(
        transport: AuthHttpTransport,
        token: suspend (Boolean) -> String = { "token" },
        onUpdateRequired: () -> Unit = {},
        nowNanos: () -> Long = System::nanoTime,
    ) =
        JobsApiClient(
            AuthApiClient(AuthConfiguration("https://api.example.test", false), { "uid" }, token, transport),
            { requestId },
            onUpdateRequired,
            nowNanos,
        )

    @Test fun expandedMetadataIsAdditiveAndQueueFailureIsNotGenericRetry() = runTest {
        var sent: JsonObject? = null
        val api = client(AuthHttpTransport { _, _, _, body ->
            sent = body?.let { Json.parseToJsonElement(it).jsonObject }
            AuthHttpResponse(409, """{"code":"PROCESSING_QUEUE_FULL","message":"private diagnostic"}""")
        })
        val error = runCatching { api.createWithMetadata(requestId, input,
            CreateJobMetadata(policyVersion = 2, preparationProfileId = "audio-cap-aac-lc-160-v1", source = "video_file")) }.exceptionOrNull() as JobsFailure
        assertEquals(2, sent?.get("policy_version")?.jsonPrimitive?.int)
        assertEquals("video_file", sent?.get("source")?.jsonPrimitive?.content)
        assertEquals(JobsProblem.PROCESSING_QUEUE_FULL, error.problem)
        assertFalse(error.message.orEmpty().contains("private"))
    }

    @Test fun usageResponseIsPrivateTypedAndKeepsMonthlyCounters() = runTest {
        val api = client(AuthHttpTransport { url, _, headers, _ ->
            assertTrue(url.endsWith("/processing-usage"))
            assertEquals("Bearer token", headers["Authorization"])
            AuthHttpResponse(200, """{"schema_version":2,"plan":"standard","policy_revision":1,"override_revision":null,
              "effective_policy_source":"global","override_expires_at":null,"period":{"key":"2026-09","start":"2026-09-01T00:00:00Z",
              "end":"2026-10-01T00:00:00Z","next_reset_at":"2026-10-01T00:00:00Z"},"processing":{"limit_seconds":7200,
              "used_seconds":600,"reserved_seconds":300,"released_seconds":100,"remaining_seconds":6300},
              "uploads":{"daily_grant_limit":30,"daily_grants":1,"daily_remaining_grants":29,"daily_reset_at":"2026-09-14T00:00:00Z","monthly_grant_limit":200,"monthly_grants":10,"monthly_remaining_grants":190,"monthly_byte_limit":1000000000,"confirmed_bytes":50000000,"monthly_remaining_bytes":950000000,"monthly_reset_at":"2026-10-01T00:00:00Z"},
              "storage":{"limit_bytes":1000000000,"retained_bytes":100000000,"remaining_bytes":900000000},
              "effective_limits":{"max_duration_seconds":1200,"max_prepared_audio_bytes":50000000,"max_client_input_attempts":5,"signed_url_ttl_seconds":600},
              "downloads":{"monthly_grant_limit":150,"monthly_grants":5,"monthly_remaining_grants":145,"monthly_byte_limit":10000000000,"estimated_bytes":250000000,"monthly_remaining_bytes":9750000000,"monthly_reset_at":"2026-10-01T00:00:00Z"},"usage_revision":3,
              "waiting_jobs":0,"max_waiting_jobs":3,"processing_jobs":1,"max_processing_jobs":1,"availability":{"status":"available","reason":null},"checked_at":"2026-09-13T12:00:00Z"}""")
        })
        val usage = api.processingUsage()!!
        assertEquals(600.0, usage.processing.usedSeconds, 0.0)
        assertEquals(300.0, usage.processing.reservedSeconds, 0.0)
        assertEquals("2026-10-01T00:00:00Z", usage.period.nextResetAt)
    }

    @Test fun allRoutesPreserveBodiesAndInstallationHeaders() = runTest {
        val requests = mutableListOf<List<Any?>>()
        val replies = ArrayDeque(listOf("""{"id":"$id","status":"awaiting_upload","upload":$upload}""", upload, mutation, """{"items":[],"next_cursor":null}""", job("queued").dropLast(1) + ",\"worker_available\":false}", mutation, mutation, grant))
        val api = client(AuthHttpTransport { url, method, headers, body ->
            requests += listOf(url, method, headers, body)
            AuthHttpResponse(200, replies.removeFirst())
        })
        assertEquals("*", api.create(requestId, input).upload!!.headers["If-None-Match"])
        api.renewUpload(id, requestId); api.confirmUpload(id); api.list("a+/=? &", "queued")
        assertEquals(false, api.detail(id).workerAvailable)
        api.cancel(id); api.retry(id, requestId); api.download(id, "output", requestId)
        assertEquals(listOf("POST", "POST", "POST", "GET", "GET", "POST", "POST", "POST"), requests.map { it[1] })
        assertEquals(listOf("/jobs", "/jobs/$id/upload-grants", "/jobs/$id/upload-completions", "/jobs?limit=20&cursor=a%2B%2F%3D%3F%20%26&status=queued", "/jobs/$id", "/jobs/$id/cancellations", "/jobs/$id/retry-attempts", "/jobs/$id/download-grants"), requests.map { (it[0] as String).removePrefix("https://api.example.test") })
        requests.forEachIndexed { index, r ->
            val headers = r[2] as Map<*, *>
            assertEquals("Bearer token", headers["Authorization"])
            assertEquals(if (index in listOf(0, 1, 2, 6)) requestId else null, headers["X-Installation-Id"])
        }
        listOf(2,5).forEach { assertEquals("{}", requests[it][3]) }
        assertEquals(Json.parseToJsonElement("""{"request_id":"$requestId","input":{"extension":"mp3","content_type":"audio/mpeg","bytes":42,"duration_seconds":1.5,"sha256":"${input.sha256}"}}"""), Json.parseToJsonElement(requests[0][3] as String))
        assertEquals("""{"request_id":"$requestId"}""", requests[1][3])
        assertEquals("""{"request_id":"$requestId"}""", requests[6][3])
        assertEquals("""{"artifact":"output","request_id":"$requestId"}""", requests[7][3])
    }

    @Test fun statusesAndAbsentDatesAreSafeAndMalformedDataFails() = runTest {
        for (status in JobStatus.entries.map { it.wireValue } + "future_state") {
            val result = client(AuthHttpTransport { _,_,_,_ -> AuthHttpResponse(200, job(status)) }).detail(id)
            assertNull(result.queuedAt)
            assertNull(result.finishedAt)
            assertEquals(status == "future_state", result.knownStatus == null)
            assertNull(result.workerAvailable)
        }
        for (body in listOf(
            "{}",
            job("ready").replace("\"status\":\"ready\",", ""),
            job("ready").replace("2026-09-09T12:00:00Z", "bad"),
            job("ready").replace("\"bytes\":42", "\"bytes\":\"42\""),
        )) {
            val error = runCatching { client(AuthHttpTransport { _,_,_,_ -> AuthHttpResponse(200, body) }).detail(id) }.exceptionOrNull()
            assertTrue(error is JobsFailure)
        }
    }

    @Test fun readyJobWithoutWorkerAvailabilityCanResolveArtifact() = runTest {
        val requests = mutableListOf<String>()
        val api = client(AuthHttpTransport { url, _, _, _ ->
            requests += url.removePrefix("https://api.example.test")
            AuthHttpResponse(200, when {
                url.endsWith("/download-grants") -> grant
                else -> job("ready").replace("\"can_download_output\":false", "\"can_download_output\":true")
            })
        })

        val readyJob = api.detail(id)
        assertEquals("ready", readyJob.status)
        assertNull(readyJob.workerAvailable)
        assertTrue(readyJob.canDownloadOutput)

        api.download(id, "output", requestId)
        assertEquals(listOf("/jobs/$id", "/jobs/$id/download-grants"), requests)
    }

    @Test fun refreshOnceKeepsExactIntentAndHeaders() = runTest {
        var calls = 0; var refreshes = 0
        val bodies = mutableListOf<String?>()
        val api = client(AuthHttpTransport { _,_,headers,body ->
            calls++; bodies += body
            assertEquals(requestId, headers["X-Installation-Id"])
            if (calls == 2) assertEquals("Bearer refreshed", headers["Authorization"])
            AuthHttpResponse(401, "{}")
        }, { force -> if (force) { refreshes++; "refreshed" } else "old" })
        assertEquals(JobsProblem.UNAUTHENTICATED, (runCatching { api.retry(id, requestId) }.exceptionOrNull() as JobsFailure).problem)
        assertEquals(2, calls); assertEquals(1, refreshes); assertEquals(bodies[0], bodies[1])
    }

    @Test fun failuresAreTypedAndNeverExposeDiagnostics() = runTest {
        val cases = listOf(403 to JobsProblem.POLICY_DENIED, 404 to JobsProblem.JOB_NOT_FOUND, 409 to JobsProblem.JOB_STATE_CONFLICT, 429 to JobsProblem.RATE_LIMITED, 503 to JobsProblem.SERVICE_UNAVAILABLE, 302 to JobsProblem.SERVICE_UNAVAILABLE)
        for ((status, expected) in cases) {
            val failure = runCatching { client(AuthHttpTransport { _,_,_,_ -> AuthHttpResponse(status, """{"message":"secret diagnostics"}""", "123") }).detail(id) }.exceptionOrNull() as JobsFailure
            assertEquals(expected, failure.problem)
            assertFalse(failure.message!!.contains("secret"))
            assertEquals(if (status == 429) 123L else null, failure.retryAfterSeconds)
        }
        for (code in listOf("NEW_INPUT_REQUIRED", "IDEMPOTENCY_CONFLICT", "UPLOAD_NOT_READY")) {
            val failure = runCatching { client(AuthHttpTransport { _,_,_,_ -> AuthHttpResponse(409, """{"code":"$code"}""") }).detail(id) }.exceptionOrNull() as JobsFailure
            assertEquals(code, failure.problem.name)
        }
        for ((status, code) in listOf(
            409 to "UPLOAD_GRANT_LIMIT_REACHED",
            409 to "DOWNLOAD_GRANT_LIMIT_REACHED",
            409 to "DOWNLOAD_BYTE_LIMIT_REACHED",
            409 to "RETAINED_STORAGE_LIMIT_REACHED",
            503 to "SERVICE_BANDWIDTH_LIMIT_REACHED",
        )) {
            val failure = runCatching { client(AuthHttpTransport { _,_,_,_ -> AuthHttpResponse(status, """{"code":"$code"}""") }).detail(id) }.exceptionOrNull() as JobsFailure
            assertEquals(code, failure.problem.name)
            assertNull(failure.retryAfterSeconds)
        }
    }
    @Test fun rejectsWrongScalarTypesAndUnsafeGrants() = runTest {
        val valid = job("queued").dropLast(1) + ",\"worker_available\":true}"
        for (body in listOf(valid.replace("\"bytes\":42", "\"bytes\":\"42\""), valid.replace("\"worker_available\":true", "\"worker_available\":\"true\""))) {
            assertTrue(runCatching { client(AuthHttpTransport { _,_,_,_ -> AuthHttpResponse(200, body) }).detail(id) }.exceptionOrNull() is JobsFailure)
        }
        for (url in listOf("http://storage.example/file", "https://user:password@storage.example/file", "https://storage.example/file#secret")) {
            assertTrue(runCatching { client(AuthHttpTransport { _,_,_,_ -> AuthHttpResponse(200, grant.replace("https://storage.example/file", url)) }).download(id, "output") }.exceptionOrNull() is JobsFailure)
        }
    }

    @Test fun policyConflictsKeepTheirExactCodes() = runTest {
        for (code in listOf("PROFILE_SYNC_REQUIRED", "DEVICE_SYNC_REQUIRED", "DEVICE_REPORT_CONFLICT")) {
            val error = runCatching { client(AuthHttpTransport { _,_,_,_ -> AuthHttpResponse(409, """{"code":"$code"}""") }).detail(id) }.exceptionOrNull() as JobsFailure
            assertEquals(code, error.problem.name)
        }
    }

    @Test fun onlyTypedAppUpdateRejectionsActivateTheUpdateGateCallback() = runTest {
        var updateRequired = 0
        val updateClient = client(
            AuthHttpTransport { _, _, _, _ ->
                AuthHttpResponse(403, """{"code":"APP_UPDATE_REQUIRED"}""")
            },
            onUpdateRequired = { updateRequired++ },
        )
        val updateFailure = runCatching { updateClient.create(requestId, input) }.exceptionOrNull() as JobsFailure
        assertEquals(JobsProblem.APP_UPDATE_REQUIRED, updateFailure.problem)
        assertEquals(1, updateRequired)

        val unrelatedClient = client(
            AuthHttpTransport { _, _, _, _ ->
                AuthHttpResponse(403, """{"code":"EMAIL_VERIFICATION_REQUIRED"}""")
            },
            onUpdateRequired = { updateRequired++ },
        )
        val unrelated = runCatching { unrelatedClient.create(requestId, input) }.exceptionOrNull() as JobsFailure
        assertEquals(JobsProblem.EMAIL_VERIFICATION_REQUIRED, unrelated.problem)
        assertEquals(1, updateRequired)
    }

    @Test fun audioExperienceMetadataMutationsAndDiagnosticsUseExactContract() = runTest {
        val requests = mutableListOf<List<Any?>>()
        val projection = """{"id":"$id","request_id":"$requestId","source_title":"Interview","display_name":"My interview","source_kind":"url","status":"ready","server_time":"2026-09-10T12:01:10.000Z","created_at":"2026-09-10T12:00:10.000Z","updated_at":"2026-09-10T12:01:10.000Z","queued_at":"2026-09-10T12:00:20.000Z","finished_at":"2026-09-10T12:01:10.000Z","input":{"extension":"mp3","bytes":42,"duration_seconds":1.5},"timing":{"processing_elapsed_ms":20000,"processing_elapsed_approximate":false,"total_elapsed_ms":70000,"total_elapsed_approximate":true},"stages":{"validating_at":"2026-09-10T12:00:40.000Z","processing_started_at":"2026-09-10T12:00:45.000Z","processing_finished_at":"2026-09-10T12:01:05.000Z","uploading_result_at":"2026-09-10T12:01:05.000Z"},"can_download_input":true,"can_download_output":true,"worker_available":true}"""
        val replies = ArrayDeque(listOf(
            """{"id":"$id","request_id":"$requestId","status":"awaiting_upload","upload":$upload}""",
            projection,
            "",
            """{"event_id":"bba62714-ab09-4c79-9453-ccae688c092c"}""",
        ))
        val api = client(AuthHttpTransport { url, method, headers, body ->
            requests += listOf(url.removePrefix("https://api.example.test"), method, headers, body)
            AuthHttpResponse(if (method == "DELETE") 204 else if (url.endsWith("client-errors")) 201 else 200, replies.removeFirst())
        })
        val metadata = CreateJobMetadata(
            "Interview",
            SourceKind.URL,
            Instant.parse("2026-09-10T12:00:00.123456789Z"),
            sourceUrl = "https://www.youtube.com/watch?v=jNQXAC9IVRw",
        )
        val created = api.createWithMetadata(requestId, input, metadata)
        assertEquals(requestId, created.requestId)
        val renamed = api.rename(id, "My interview")
        assertEquals("My interview", renamed.displayName)
        assertEquals(20_000L, renamed.timing?.processingElapsedMs)
        assertEquals(Instant.parse("2026-09-10T12:00:45Z"), renamed.stages?.processingStartedAt)
        api.delete(id)
        val accepted = api.reportClientError(ClientErrorReport(
            "bba62714-ab09-4c79-9453-ccae688c092c", requestId, id,
            ClientErrorStage.DOWNLOADING_SOURCE, ClientErrorCode.NETWORK, true,
            "android", "0.1.0", "15", Instant.parse("2026-09-10T12:00:00.123456789Z"), 503,
        ))
        assertEquals("bba62714-ab09-4c79-9453-ccae688c092c", accepted.eventId)
        assertEquals(listOf("POST", "PATCH", "DELETE", "POST"), requests.map { it[1] })
        assertEquals(listOf("/jobs", "/jobs/$id", "/jobs/$id", "/client-errors"), requests.map { it[0] })
        assertEquals(Json.parseToJsonElement("""{"request_id":"$requestId","source_title":"Interview","source_kind":"url","source_url":"https://www.youtube.com/watch?v=jNQXAC9IVRw","client_started_at":"2026-09-10T12:00:00.123Z","input":{"extension":"mp3","content_type":"audio/mpeg","bytes":42,"duration_seconds":1.5,"sha256":"${input.sha256}"}}"""), Json.parseToJsonElement(requests[0][3] as String))
        assertEquals("""{"display_name":"My interview"}""", requests[1][3])
        assertNull((requests[2][2] as Map<*, *>)["X-Installation-Id"])
        val diagnostic = Json.parseToJsonElement(requests[3][3] as String).jsonObject
        assertEquals("DOWNLOADING_SOURCE", diagnostic["stage"]!!.jsonPrimitive.content)
        assertEquals("2026-09-10T12:00:00.123Z", diagnostic["occurred_at"]!!.jsonPrimitive.content)
        assertNull(diagnostic["owner_uid"])
    }

}
