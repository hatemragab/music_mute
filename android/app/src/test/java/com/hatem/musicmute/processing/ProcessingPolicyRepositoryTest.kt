package com.hatem.musicmute.processing

import java.nio.file.Files
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ProcessingPolicyRepositoryTest {
    private class Cache(var stored: ProcessingMediaPolicy? = null) : ProcessingPolicyCache {
        private var guest = stored
        private val owners = mutableMapOf<String, ProcessingMediaPolicy>()
        override suspend fun read(ownerUid: String?) = if (ownerUid == null) guest else owners[ownerUid]
        override suspend fun write(value: ProcessingMediaPolicy, ownerUid: String?) {
            stored = value
            if (ownerUid == null) guest = value else owners[ownerUid] = value
        }
    }
    private fun policy(revision: Int, visible: Boolean, country: String? = "US") =
        standardMediaPolicy().copy(revision = revision, linkImportPolicyRevision = revision,
            linkImportVisible = visible, visitorCountry = country)

    @Test fun signedOutForegroundOpensCheckPublicPolicyWithoutOpeningOwnerSocket() = runTest {
        val authentication = mutableListOf<Boolean>()
        val cache = Cache()
        val repository = ProcessingPolicyRepository(backgroundScope, cache,
            { authenticated -> authentication.add(authenticated); policy(1, true) },
            { error("Signed-out policy checkout must not subscribe to an owner socket") })
        repository.setForeground(true)
        runCurrent()
        assertEquals(listOf(false), authentication)
        assertTrue(repository.policy.value.linkImportVisible)
        repository.setForeground(false)
        repository.setForeground(true)
        runCurrent()
        assertEquals(listOf(false, false), authentication)
        assertEquals(repository.policy.value, cache.stored)
    }

    @Test fun noCacheAndFailedCheckoutStayFileOnly() = runTest {
        val snapshots = MutableSharedFlow<ProcessingMediaPolicy>()
        val repository = ProcessingPolicyRepository(backgroundScope, Cache(),
            { throw JobsFailure(JobsProblem.OFFLINE) }, { snapshots })
        assertFalse(repository.policy.value.linkImportVisible)
        repository.setForeground(true)
        repository.bindSession(ProcessingSession("owner", 1))
        runCurrent()
        assertFalse(repository.policy.value.linkImportVisible)
        assertTrue(repository.policy.value.localPreparationReady)
    }

    @Test fun offlineReopenRetainsLastGoodMatchingOwnerCache() = runTest {
        val cached = policy(8, true)
        val cache = Cache(cached)
        cache.write(cached, "owner")
        val repository = ProcessingPolicyRepository(backgroundScope, cache,
            { throw JobsFailure(JobsProblem.OFFLINE) }, { MutableSharedFlow() })
        repository.bindSession(ProcessingSession("owner", 1))
        repository.initialize()
        assertTrue(repository.policy.value.linkImportVisible)
        repository.setForeground(true)
        runCurrent()
        assertEquals(cached, repository.policy.value)
        assertEquals(cached, cache.stored)
    }

    @Test fun ownerChangesNeverReuseAnotherOwnersVisibilityOrRevision() = runTest {
        val cache = Cache(policy(3, true))
        cache.write(policy(9, false), "hidden-owner")
        cache.write(policy(4, true), "visible-owner")
        val repository = ProcessingPolicyRepository(backgroundScope, cache,
            { throw JobsFailure(JobsProblem.OFFLINE) }, { MutableSharedFlow() })
        repository.setForeground(true)
        repository.bindSession(ProcessingSession("hidden-owner", 1))
        runCurrent()
        assertFalse(repository.policy.value.linkImportVisible)
        repository.bindSession(ProcessingSession("visible-owner", 2))
        runCurrent()
        assertTrue(repository.policy.value.linkImportVisible)
        assertEquals(4, repository.policy.value.linkImportPolicyRevision)
        repository.bindSession(ProcessingSession("new-owner", 3))
        assertFalse(repository.policy.value.linkImportVisible)
        runCurrent()
        assertFalse(repository.policy.value.linkImportVisible)
        repository.bindSession(null)
        runCurrent()
        assertTrue(repository.policy.value.linkImportVisible)
        assertEquals(3, repository.policy.value.linkImportPolicyRevision)
    }

    @Test fun fileCacheKeepsGuestAndEachOwnerSeparate() = runTest {
        val directory = Files.createTempDirectory("processing-policy-owners-test").toFile()
        try {
            val cache = FileProcessingPolicyCache(java.io.File(directory, "policy.json"))
            cache.write(policy(3, true))
            cache.write(policy(9, false), "hidden/owner")
            cache.write(policy(4, true), "visible-owner")
            assertTrue(cache.read()!!.linkImportVisible)
            assertFalse(cache.read("hidden/owner")!!.linkImportVisible)
            assertEquals(4, cache.read("visible-owner")!!.linkImportPolicyRevision)
            assertNull(cache.read("new-owner"))
            assertEquals(3, directory.listFiles()!!.size)
        } finally { directory.deleteRecursively() }
    }

    @Test fun snapshotsShowAndHideWhileOpenAndOlderRevisionsCannotReshow() = runTest {
        val snapshots = MutableSharedFlow<ProcessingMediaPolicy>()
        val cache = Cache()
        val repository = ProcessingPolicyRepository(backgroundScope, cache, { policy(1, false) }, { snapshots })
        repository.bindSession(ProcessingSession("owner", 1))
        repository.setForeground(true)
        runCurrent()
        snapshots.emit(policy(2, true))
        runCurrent()
        assertTrue(repository.policy.value.linkImportVisible)
        snapshots.emit(policy(3, false))
        runCurrent()
        assertFalse(repository.policy.value.linkImportVisible)
        snapshots.emit(policy(2, true))
        runCurrent()
        assertFalse(repository.policy.value.linkImportVisible)
        assertEquals(3, cache.stored?.linkImportPolicyRevision)
    }

    @Test fun delayedHttpDoesNotOverwriteEqualRevisionSnapshotCountry() = runTest {
        val snapshots = MutableSharedFlow<ProcessingMediaPolicy>()
        val http = CompletableDeferred<ProcessingMediaPolicy>()
        val cache = Cache()
        val repository = ProcessingPolicyRepository(backgroundScope, cache, { http.await() }, { snapshots })
        repository.bindSession(ProcessingSession("owner", 1))
        repository.setForeground(true)
        runCurrent()
        snapshots.emit(policy(8, false, "EG"))
        runCurrent()
        http.complete(policy(8, true, "US"))
        runCurrent()
        assertFalse(repository.policy.value.linkImportVisible)
        assertEquals("EG", cache.stored?.visitorCountry)
        snapshots.emit(policy(8, true, "US"))
        runCurrent()
        assertTrue(repository.policy.value.linkImportVisible)
        assertEquals("US", cache.stored?.visitorCountry)
    }

    @Test fun checkoutRunsOnceOnEachForegroundAndSessionOpen() = runTest {
        var requests = 0
        val repository = ProcessingPolicyRepository(backgroundScope, Cache(),
            { requests++; policy(1, true) }, { MutableSharedFlow() })
        repository.setForeground(true)
        repository.bindSession(ProcessingSession("owner", 1))
        runCurrent()
        assertEquals(1, requests)
        repository.setForeground(true)
        runCurrent()
        assertEquals(1, requests)
        repository.setForeground(false)
        repository.setForeground(true)
        runCurrent()
        assertEquals(2, requests)
        repository.bindSession(ProcessingSession("other-owner", 2))
        runCurrent()
        assertEquals(3, requests)
    }

    @Test fun lateCheckoutFromReplacedSessionCannotChangePolicyOrCache() = runTest {
        val staleHttp = CompletableDeferred<ProcessingMediaPolicy>()
        var requests = 0
        val cache = Cache()
        val repository = ProcessingPolicyRepository(backgroundScope, cache,
            { if (++requests == 1) withContext(NonCancellable) { staleHttp.await() } else policy(4, false) },
            { MutableSharedFlow() })
        repository.bindSession(ProcessingSession("owner", 1))
        repository.setForeground(true)
        runCurrent()
        repository.bindSession(ProcessingSession("other-owner", 2))
        runCurrent()
        staleHttp.complete(policy(10, true))
        runCurrent()
        assertFalse(repository.policy.value.linkImportVisible)
        assertEquals(4, cache.stored?.revision)
    }

    @Test fun fileCacheRoundTripsNativePolicyAndCorruptionDefaultsHidden() = runTest {
        val directory = Files.createTempDirectory("processing-policy-test").toFile()
        try {
            val file = java.io.File(directory, "policy.json")
            val cache = FileProcessingPolicyCache(file)
            assertNull(cache.read())
            val visible = policy(4, true)
            cache.write(visible)
            assertEquals(visible, FileProcessingPolicyCache(file).read())
            file.writeText("invalid")
            assertNull(cache.read())
            cache.write(policy(5, false))
            assertFalse(cache.read()!!.linkImportVisible)
        } finally {
            directory.deleteRecursively()
        }
    }
}
