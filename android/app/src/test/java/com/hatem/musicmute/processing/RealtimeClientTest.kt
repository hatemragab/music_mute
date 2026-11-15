package com.hatem.musicmute.processing

import com.hatem.musicmute.auth.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.test.*
import okhttp3.*
import okio.ByteString
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.Assert.*
import kotlinx.serialization.json.*

@OptIn(ExperimentalCoroutinesApi::class)
class RealtimeClientTest {
    private val dispatcher = StandardTestDispatcher()
    @Before fun main() { Dispatchers.setMain(dispatcher) }
    @After fun reset() { Dispatchers.resetMain() }

    private class Socket(private val request: Request, val listener: WebSocketListener) : WebSocket {
        val sent = mutableListOf<String>()
        var cancelled = false
        override fun request() = request
        override fun queueSize() = 0L
        override fun send(text: String): Boolean { sent.add(text); return true }
        override fun send(bytes: ByteString) = false
        override fun close(code: Int, reason: String?) = true
        override fun cancel() { cancelled = true }
        fun frame(text: String) { listener.onMessage(this, text) }
    }

    @Test fun receivesPushedSnapshotsWithoutPollingAndFencesReplacedSessions() = runTest(dispatcher) {
        var tickets = 0
        val sockets = mutableListOf<Socket>()
        val auth = AuthApiClient(AuthConfiguration("https://api.example.test", false), { "owner" }, { "fixture-token" },
            AuthHttpTransport { _, method, _, _ ->
                assertEquals("POST", method); tickets++
                AuthHttpResponse(201, """{"ticket":"${"a".repeat(43)}","path":"/realtime/socket","protocol":"musicmute.realtime.v1"}""")
            })
        val client = RealtimeClient(auth, backgroundScope, { "00000000-0000-4000-8000-000000000001" }, openSocket = { request, listener -> Socket(request, listener).also { sockets.add(it) } })
        client.bindSession(ProcessingSession("owner", 1)); client.setForeground(true)
        val received = mutableListOf<String>()
        val collector = backgroundScope.launch { client.watch("job", mapOf("id" to "fixture")).collect { received.add(it) } }
        runCurrent()
        val first = sockets.single()
        assertNull(first.request().header("Authorization"))
        assertNull(first.request().url.query)
        first.frame("""{"type":"ready","protocol_version":1,"stream_id":"one"}"""); runCurrent()
        assertTrue(first.sent.single().contains("subscribe"))
        fun snapshot(sequence: Int, status: String) = """{"type":"snapshot","protocol_version":1,"stream_id":"one","subscription_id":"s1","sequence":$sequence,"data":{"status":"$status","display_name":"Test"}}"""
        first.frame(snapshot(1, "queued")); runCurrent()
        first.frame(snapshot(2, "ready")); runCurrent()
        assertEquals(2, received.size)
        assertTrue(received.last().contains("displayName"))
        first.frame(snapshot(2, "queued")); runCurrent(); assertEquals(2, received.size)
        advanceTimeBy(30_000); first.frame("""{"type":"ping"}"""); runCurrent()
        assertEquals(1, tickets)
        collector.cancel(); runCurrent()
        client.bindSession(null)
        first.frame(snapshot(3, "queued")); runCurrent()
        assertTrue(first.cancelled); assertEquals(2, received.size)
        client.setForeground(false)
    }
    @Test fun keepsOneSocketAcrossTabsAndCollectorGapsUntilBackgroundOrLogout() = runTest(dispatcher) {
        var tickets = 0
        val sockets = mutableListOf<Socket>()
        val auth = AuthApiClient(AuthConfiguration("https://api.example.test", false), { "owner" }, { "fixture-token" },
            AuthHttpTransport { _, _, _, _ ->
                tickets++
                AuthHttpResponse(201, """{"ticket":"${"a".repeat(43)}","path":"/realtime/socket","protocol":"musicmute.realtime.v1"}""")
            })
        val client = RealtimeClient(auth, backgroundScope, { "installation" }, openSocket = { request, listener -> Socket(request, listener).also { sockets.add(it) } })
        client.bindSession(ProcessingSession("owner", 1))
        client.setForeground(true)
        runCurrent()
        val first = sockets.single()
        first.frame("""{"type":"ready","protocol_version":1,"stream_id":"one"}""")
        runCurrent()
        repeat(5) {
            val collector = backgroundScope.launch { client.watch("jobs").collect {} }
            runCurrent()
            collector.cancelAndJoin()
            runCurrent()
            advanceTimeBy(20_000)
            first.frame("""{"type":"ping"}""")
            runCurrent()
            client.setForeground(true)
            assertFalse(first.cancelled)
            assertEquals(1, tickets)
        }
        client.setForeground(false)
        runCurrent()
        assertTrue(first.cancelled)
        client.setForeground(true)
        runCurrent()
        assertEquals(2, tickets)
        client.bindSession(null)
        runCurrent()
        assertTrue(sockets.last().cancelled)
        advanceTimeBy(60_000)
        runCurrent()
        assertEquals(2, tickets)
    }

    @Test fun tracksTwentyImportsAlongsidePolicyUsageAndHistoryOnOneSocket() = runTest(dispatcher) {
        val sockets = mutableListOf<Socket>()
        val auth = AuthApiClient(AuthConfiguration("https://api.example.test", false), { "owner" }, { "fixture-token" },
            AuthHttpTransport { _, _, _, _ -> AuthHttpResponse(201, """{"ticket":"${"a".repeat(43)}","path":"/realtime/socket","protocol":"musicmute.realtime.v1"}""") })
        val client = RealtimeClient(auth, backgroundScope, { "installation" }, openSocket = { request, listener -> Socket(request, listener).also { sockets.add(it) } })
        client.bindSession(ProcessingSession("owner", 1)); client.setForeground(true)
        val collectors = (0 until 20).map { index ->
            backgroundScope.launch { client.watch("import", mapOf("id" to "import$index")).collect {} }
        } + listOf("policy", "usage", "jobs").map { resource ->
            backgroundScope.launch { client.watch(resource).collect {} }
        }
        runCurrent()
        sockets.single().frame("""{"type":"ready","protocol_version":1,"stream_id":"imports"}""")
        runCurrent()
        assertEquals(23, sockets.single().sent.count { it.contains("subscribe") })
        collectors.forEach { it.cancel() }
        runCurrent()
        client.bindSession(null)
    }

    @Test fun forbiddenTicketStopsReconnect() = runTest(dispatcher) {
        var tickets = 0
        val auth = AuthApiClient(AuthConfiguration("https://api.example.test", false), { "owner" }, { "fixture-token" },
            AuthHttpTransport { _, _, _, _ -> tickets++; AuthHttpResponse(403, """{"code":"ACCOUNT_DELETION_PENDING"}""") })
        val client = RealtimeClient(auth, backgroundScope, { "00000000-0000-4000-8000-000000000001" }, openSocket = { _, _ -> error("Forbidden session cannot open a socket") })
        client.bindSession(ProcessingSession("owner", 1)); client.setForeground(true)
        backgroundScope.launch { runCatching { client.watch("jobs").collect {} } }
        runCurrent(); advanceTimeBy(60_000); runCurrent()
        assertEquals(RealtimeState.SIGNED_OUT, client.state.value)
        assertEquals(1, tickets)
        client.setForeground(false)
        client.setForeground(true)
        backgroundScope.launch { runCatching { client.watch("jobs").collect {} } }
        runCurrent()
        assertEquals(RealtimeState.SIGNED_OUT, client.state.value)
        assertEquals(1, tickets)
        client.bindSession(null)
    }

    @Test fun nativePolicyUpdatesShareImportSocketWithoutInterruptingExistingWork() = runTest(dispatcher) {
        var tickets = 0
        val sockets = mutableListOf<Socket>()
        val auth = AuthApiClient(AuthConfiguration("https://api.example.test", false), { "owner" }, { "fixture-token" },
            AuthHttpTransport { _, _, _, _ ->
                tickets++
                AuthHttpResponse(201, """{"ticket":"${"a".repeat(43)}","path":"/realtime/socket","protocol":"musicmute.realtime.v1"}""")
            })
        val client = RealtimeClient(auth, backgroundScope, { "installation" },
            openSocket = { request, listener -> Socket(request, listener).also { sockets.add(it) } })
        val cache = object : ProcessingPolicyCache {
            var value: ProcessingMediaPolicy? = null
            override suspend fun read(ownerUid: String?) = value
            override suspend fun write(value: ProcessingMediaPolicy, ownerUid: String?) { this.value = value }
        }
        val policy = ProcessingPolicyRepository(backgroundScope, cache,
            { ProcessingMediaPolicy.parse(ApiWireJson.response(processingPolicyFixture)) },
            { client.watch("policy", mapOf("schema_version" to "2")).map { ProcessingMediaPolicy.parse(it) } })
        val owner = ProcessingSession("owner", 1)
        client.bindSession(owner)
        client.setForeground(true)
        policy.bindSession(owner)
        policy.setForeground(true)
        val imports = mutableListOf<String>()
        backgroundScope.launch { client.watch("import", mapOf("id" to "in-flight")).collect { imports.add(it) } }
        runCurrent()
        val socket = sockets.single()
        socket.frame("""{"type":"ready","protocol_version":1,"stream_id":"native-policy"}""")
        runCurrent()
        fun subscription(resource: String) = socket.sent.map { Json.parseToJsonElement(it).jsonObject }
            .single { it["resource"]?.jsonPrimitive?.content == resource }.getValue("subscription_id").jsonPrimitive.content
        fun snapshot(resource: String, sequence: Int, data: String) =
            """{"type":"snapshot","protocol_version":1,"stream_id":"native-policy","subscription_id":"${subscription(resource)}","sequence":$sequence,"data":$data}"""
        fun visibility(visible: Boolean) = processingPolicyFixture.replace("\"revision\":1",
            "\"revision\":1,\"link_import_visible\":$visible,\"link_import_policy_revision\":1")
        socket.frame(snapshot("import", 1, """{"status":"acquiring"}"""))
        socket.frame(snapshot("policy", 1, visibility(true)))
        runCurrent()
        assertTrue(policy.policy.value.linkImportVisible)
        socket.frame(snapshot("policy", 2, visibility(false)))
        socket.frame(snapshot("import", 2, """{"status":"submitted"}"""))
        runCurrent()
        assertFalse(policy.policy.value.linkImportVisible)
        assertEquals(2, imports.size)
        assertTrue(imports.last().contains("submitted"))
        assertFalse(socket.cancelled)
        assertEquals(1, tickets)
        assertEquals(1, sockets.size)
    }

}
