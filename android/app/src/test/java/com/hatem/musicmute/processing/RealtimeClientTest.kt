package com.hatem.musicmute.processing

import com.hatem.musicmute.auth.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.test.*
import okhttp3.*
import okio.ByteString
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.Assert.*

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
        client.bindSession(null)
    }

}
