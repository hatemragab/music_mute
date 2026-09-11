package com.hatem.musicmute.processing

import java.io.IOException
import java.time.Instant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PushRegistrationTest {
    private val installation = "d7ea7de6-52e9-4b96-8834-3b517941bdb0"
    private val jobId = "68c000000000000000000001"
    private val eventId = "notification:68c000000000000000000002:68c000000000000000000003:7"
    private var session: PushSession? = null
    private var identityUid: String? = "owner"
    private var allowed = true
    private val api = FakePushApi()
    private val jobs = FakeJobsApi()
    private fun data() = mapOf("type" to "audio_job_outcome", "jobId" to jobId, "eventId" to eventId, "outcome" to "ready")

    @Test fun tokenBeforeBootstrapWaitsForSyncedInstallationThenRotates() = runTest {
        val coordinator = coordinator(backgroundScope)
        coordinator.onToken("first-token")
        runCurrent()
        assertTrue(api.registered.isEmpty())
        session = PushSession("owner", 1, installation)
        coordinator.onSessionChanged()
        runCurrent()
        assertEquals(listOf("first-token"), api.registered.map { it.second })
        coordinator.onToken("second-token")
        runCurrent()
        assertEquals(listOf("first-token", "second-token"), api.registered.map { it.second })
    }

    @Test fun staleSdkTokenReadCannotOverwriteRotationCallback() = runTest {
        session = PushSession("owner", 1, installation)
        val gate = CompletableDeferred<Unit>()
        val coordinator = PushRegistrationCoordinator(api, jobs, { session }, { identityUid },
            tokenSource = { gate.await(); "stale-sdk-token" }, permitted = { allowed }, enabled = true, scope = backgroundScope)
        coordinator.onForeground()
        runCurrent()
        coordinator.onToken("rotated-token")
        gate.complete(Unit)
        runCurrent()
        assertEquals(listOf("rotated-token"), api.registered.map { it.second })
    }

    @Test fun deniedPermissionAndDisabledEmulatorNeverFetchOrRegisterToken() = runTest {
        session = PushSession("owner", 1, installation)
        var tokenReads = 0
        val coordinator = PushRegistrationCoordinator(api, jobs, { session }, { identityUid },
            tokenSource = { tokenReads++; "sdk-token" }, permitted = { allowed }, enabled = false, scope = backgroundScope)
        coordinator.onForeground()
        runCurrent()
        assertEquals(0, tokenReads)
        allowed = false
        val denied = coordinator(backgroundScope)
        denied.onToken("token")
        denied.onForeground()
        runCurrent()
        assertTrue(api.registered.isEmpty())
    }

    @Test fun foregroundRetriesFailedRegistrationAndIgnoresInvalidToken() = runTest {
        session = PushSession("owner", 1, installation)
        val coordinator = coordinator(backgroundScope)
        coordinator.onToken("invalid token\n")
        runCurrent()
        assertTrue(api.registered.isEmpty())
        api.failRegistration = true
        coordinator.onToken("valid-token")
        runCurrent()
        api.failRegistration = false
        coordinator.onForeground()
        runCurrent()
        assertEquals(2, api.registered.size)
    }

    @Test fun logoutUsesKnownRevisionAndNeverReplaysUnderNewCredentials() = runTest {
        session = PushSession("owner", 1, installation)
        val coordinator = coordinator(backgroundScope)
        coordinator.onToken("token")
        runCurrent()
        api.failDeactivation = true
        session = null
        coordinator.onSessionChanged()
        coordinator.beforeSignOut("owner", installation)
        assertEquals(listOf(installation to 7L), api.deactivated)
        identityUid = "other"
        session = PushSession("other", 2, installation)
        coordinator.onSessionChanged()
        runCurrent()
        coordinator.onForeground()
        runCurrent()
        assertEquals(1, api.deactivated.size)
    }

    @Test fun logoutWithoutKnownBindingDoesNotSendUnguardedDeactivate() = runTest {
        coordinator(backgroundScope).beforeSignOut("owner", installation)
        assertTrue(api.deactivated.isEmpty())
    }

    @Test fun boundedOfflineLogoutCancelsInFlightDeactivation() = runTest {
        session = PushSession("owner", 1, installation)
        val coordinator = coordinator(backgroundScope)
        coordinator.onToken("token")
        runCurrent()
        api.deactivateGate = CompletableDeferred()
        coordinator.beforeSignOut("owner", installation)
        assertTrue(api.cancelledDeactivation)
    }

    @Test fun coldTapDuringLoginWaitsForOwnerFetchAndDeduplicates() = runTest {
        val coordinator = coordinator(backgroundScope)
        coordinator.rememberTap(data())
        assertNull(coordinator.resolvePendingTap())
        assertEquals(0, jobs.reads)
        session = PushSession("owner", 1, installation)
        coordinator.onSessionChanged()
        assertEquals(jobId, coordinator.resolvePendingTap()?.id)
        coordinator.rememberTap(data())
        assertNull(coordinator.resolvePendingTap())
        assertEquals(1, jobs.reads)
    }

    @Test fun invalidAndForeignOwnerHintsNeverNavigate() = runTest {
        val coordinator = coordinator(backgroundScope)
        session = PushSession("owner", 1, installation)
        coordinator.rememberTap(data() + ("jobId" to "../other"))
        assertNull(coordinator.resolvePendingTap())
        coordinator.rememberTap(data() + ("outcome" to "cancelled"))
        assertNull(coordinator.resolvePendingTap())
        jobs.notFound = true
        coordinator.rememberTap(data())
        assertNull(coordinator.resolvePendingTap())
        assertNull(coordinator.pendingTap.value)
    }

    @Test fun foregroundMessageIsRefreshOnlyAndTapStillAuthenticates() = runTest {
        session = PushSession("owner", 1, installation)
        val coordinator = coordinator(backgroundScope)
        val hint = async { coordinator.refreshHints.first() }
        runCurrent()
        coordinator.onMessage(data())
        assertEquals(jobId, hint.await().jobId)
        assertEquals(0, jobs.reads)
        coordinator.rememberTap(data())
        assertEquals(jobId, coordinator.resolvePendingTap()?.id)
    }

    @Test fun accountChangeDuringOwnerFetchDiscardsResponse() = runTest {
        session = PushSession("owner", 1, installation)
        val coordinator = coordinator(backgroundScope)
        jobs.gate = CompletableDeferred()
        coordinator.rememberTap(data())
        val result = async { coordinator.resolvePendingTap() }
        runCurrent()
        identityUid = "other"
        session = PushSession("other", 2, installation)
        coordinator.onSessionChanged()
        jobs.gate!!.complete(Unit)
        assertNull(result.await())
    }

    private fun coordinator(scope: kotlinx.coroutines.CoroutineScope) = PushRegistrationCoordinator(
        api, jobs, { session }, { identityUid }, { "sdk-token" }, { allowed }, enabled = true, scope = scope)

    private class FakePushApi : PushRegistrationApi {
        val registered = mutableListOf<Pair<String, String>>()
        val deactivated = mutableListOf<Pair<String, Long>>()
        var failRegistration = false
        var failDeactivation = false
        var deactivateGate: CompletableDeferred<Unit>? = null
        var cancelledDeactivation = false
        override suspend fun register(installationId: String, token: String): PushBinding {
            registered += installationId to token
            if (failRegistration) throw IOException("offline")
            return PushBinding(installationId, true, 7)
        }
        override suspend fun deactivate(installationId: String, expectedBindingRevision: Long) {
            deactivated += installationId to expectedBindingRevision
            try { deactivateGate?.await() }
            catch (error: kotlinx.coroutines.CancellationException) { cancelledDeactivation = true; throw error }
            if (failDeactivation) throw IOException("offline")
        }
    }

    private inner class FakeJobsApi : JobsApi {
        var reads = 0
        var notFound = false
        var gate: CompletableDeferred<Unit>? = null
        override suspend fun detail(id: String): Job {
            reads++
            gate?.await()
            if (notFound) throw JobsFailure(JobsProblem.JOB_NOT_FOUND)
            return Job(id, "ready", Instant.EPOCH, Instant.EPOCH, JobInput("mp3", 1, 1.0), true, true, workerAvailable = true)
        }
        override suspend fun download(id: String, artifact: String): DownloadGrant = error("unused")
        override suspend fun create(requestId: String, input: InputDeclaration): CreateReservation = error("unused")
        override suspend fun renewUpload(id: String): UploadGrant = error("unused")
        override suspend fun confirmUpload(id: String): JobMutation = error("unused")
        override suspend fun list(cursor: String?, status: String?): JobPage = error("unused")
        override suspend fun cancel(id: String): JobMutation = error("unused")
        override suspend fun retry(id: String, requestId: String): JobMutation = error("unused")
    }
}
