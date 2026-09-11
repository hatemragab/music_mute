package com.hatem.musicmute.auth

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AuthPushCleanupTest {
    @Test fun cleanupKeepsOldCredentialsUntilAttemptCompletes() = runTest {
        var identity: String? = "old-owner"
        val gate = CompletableDeferred<Unit>()
        val cleanup = async {
            runBeforeLocalSignOut(before = {
                assertEquals("old-owner", identity)
                gate.await()
                assertEquals("old-owner", identity)
            }, clearIdentity = { identity = null })
        }
        runCurrent()
        assertEquals("old-owner", identity)
        gate.complete(Unit)
        cleanup.await()
        assertNull(identity)
    }

    @Test fun offlineCleanupIsBoundedAndIdentityAlwaysClears() = runTest {
        var cleared = false
        runBeforeLocalSignOut(before = { CompletableDeferred<Unit>().await() }, clearIdentity = { cleared = true })
        assertTrue(cleared)
        assertEquals(2_000L, testScheduler.currentTime)
        cleared = false
        runBeforeLocalSignOut(before = { throw IllegalStateException("offline") }, clearIdentity = { cleared = true })
        assertTrue(cleared)
    }
}
