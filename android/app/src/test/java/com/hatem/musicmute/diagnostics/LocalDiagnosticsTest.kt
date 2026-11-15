package com.hatem.musicmute.diagnostics

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class LocalDiagnosticsTest {
    @Test fun nestedCredentialsAndSignedUrlsAreRedacted() {
        val value = LocalLogRedaction.clean(mapOf(
            "items" to listOf(mapOf("Authorization" to "Bearer canary", "api_key" to "canary", "password" to "canary")),
            "url" to "https://user:canary@example.invalid/audio?signature=canary#canary",
            "connection" to "mongodb+srv://user:canary@example.invalid/database", "safe" to "ready",
        )).toString()
        assertFalse(value.contains("canary"))
        assertTrue(value.contains("ready"))
        assertTrue(value.contains("REDACTED"))
    }

    @Test fun encodedJsonIsRedactedBeforeDelivery() {
        val encoded = java.util.Base64.getEncoder().encodeToString("{\"refresh_token\":\"canary\",\"ok\":true}".toByteArray())
        val value = LocalLogRedaction.clean(mapOf("encoded" to encoded, "string" to "{\"secret\":\"canary\"}")).toString()
        assertFalse(value.contains("canary"))
        assertTrue(value.contains("base64_json"))
        assertTrue(value.contains("REDACTED"))
    }

    @Test fun snapshotsBoundStringsArraysDepthAndWork() {
        val value = LocalLogRedaction.clean(mapOf("large" to "x".repeat(3_000), "array" to List(100) { "ok" })).toString()
        assertTrue(value.contains("string_limit"))
        assertTrue(value.contains("array_limit"))
        assertTrue(value.length < 4_096)
        var nested: Any = "leaf"
        repeat(40) { nested = mapOf("nested" to nested) }
        assertTrue(LocalLogRedaction.clean(nested).toString().contains("structure_limit"))
    }

    @Test fun errorDetailsAndUnsupportedObjectsAreOmitted() {
        val value = LocalLogRedaction.clean(mapOf("error" to LocalDiagnostics.error(IllegalStateException("Bearer canary")), "unknown" to Any())).toString()
        assertFalse(value.contains("canary"))
        assertTrue(value.contains("unsupported_type"))
    }

    @Test fun captureRequiresPrivateDebugConfiguration() {
        assertFalse(LocalDiagnostics.enabled)
        assertEquals("payload_capture_disabled", (LocalDiagnostics.payload("{\"password\":\"canary\"}") as Map<*, *>)["omitted"])
        assertEquals(0L, LocalDiagnostics.status()["pending"])
    }

    @Test fun queuePressurePreservesWarningsAndStaysBounded() {
        val queue = LocalLogQueue(2)
        assertTrue(queue.offer(LocalLogRecord("info".toByteArray(), false)))
        assertTrue(queue.offer(LocalLogRecord("warn".toByteArray(), true)))
        assertFalse(queue.offer(LocalLogRecord("ignored".toByteArray(), false)))
        assertTrue(queue.offer(LocalLogRecord("error".toByteArray(), true)))
        assertEquals(2, queue.size)
        assertEquals(2L, queue.dropped)
        assertTrue(queue.take()!!.important)
        assertTrue(queue.take()!!.important)
        assertNull(queue.take())
    }

    @Test fun identityIsImmutableAcrossDispatcherAwaitAndChildWork() = runBlocking {
        val context = LocalLogContext("account-before-await", "operation-1")
        withContext(context) {
            yield()
            val inherited = async(Dispatchers.Default) { currentCoroutineContext()[LocalLogContext] }.await()
            assertEquals("account-before-await", inherited?.userId)
            assertEquals("operation-1", inherited?.traceId)
        }
        assertNull(currentCoroutineContext()[LocalLogContext])
    }
}
