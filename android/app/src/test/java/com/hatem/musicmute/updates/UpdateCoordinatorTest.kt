package com.hatem.musicmute.updates

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateCoordinatorTest {
    private fun target(id: String = "6aa46ad418983c1bd08b5749", build: Int = 2) =
        ReleaseTarget(
            id = id,
            versionName = "0.1.1",
            buildNumber = build,
            changelogEn = "test",
            source = "google_play",
            storeUrl = "https://play.google.com/store/apps/details?id=com.hatem.musicmute",
        )

    private fun policy(revision: Long = 1, minimum: Int? = 2, target: ReleaseTarget? = target()) =
        UpdatePolicySnapshot(1, revision, "android", "play", minimum, target, "2026-09-12T00:00:00.000Z")

    private class MemoryStore(initial: StoredUpdateState = StoredUpdateState()) : UpdateStateStore {
        var value = initial
        override suspend fun load() = value
        override suspend fun save(value: StoredUpdateState) { this.value = value }
    }

    private class FakeApi(var response: Result<UpdatePolicySnapshot>) : UpdatePolicyApi {
        var calls = 0
        override suspend fun policy(): UpdatePolicySnapshot {
            calls++
            return response.getOrThrow()
        }
    }

    private fun TestScope.coordinator(
        api: FakeApi,
        store: MemoryStore,
        now: () -> Long,
        online: () -> Boolean = { true },
    ) = UpdateCoordinator(this, api, store, installedBuild = { 1 }, distribution = "play", now = now, online = online)

    @Test
    fun knownRequiredSnapshotRestoresBeforeAFailedRefreshAndStaysBlocking() = runTest {
        val store = MemoryStore(StoredUpdateState(snapshot = policy()))
        val api = FakeApi(Result.failure(UpdateFailure(UpdateProblem.OFFLINE)))
        val coordinator = coordinator(api, store, now = { 1_000 })

        coordinator.initialize()

        assertFalse(coordinator.state.value.restoring)
        assertEquals(UpdateDecision.REQUIRED, coordinator.state.value.decision)
        assertEquals(UpdateProblem.OFFLINE, coordinator.state.value.failure)
    }

    @Test
    fun actualInstalledBuildAfterRestartClearsRequiredAdmissionToOptional() = runTest {
        val snapshot = policy(minimum = 12, target = target(build = 15))
        val store = MemoryStore(StoredUpdateState(snapshot = snapshot))
        val before = UpdateCoordinator(this, FakeApi(Result.success(snapshot)), store,
            installedBuild = { 10 }, distribution = "play", now = { 1_000 })
        before.initialize()
        assertTrue(UpdateAdmission(before.state).isBlocked())
        // The same policy and retained cache become optional only with the actual new installed build.
        val after = UpdateCoordinator(this, FakeApi(Result.success(snapshot)), store,
            installedBuild = { 14 }, distribution = "play", now = { 2_000 })
        after.initialize()
        assertEquals(UpdateDecision.OPTIONAL, after.state.value.decision)
        assertFalse(UpdateAdmission(after.state).isBlocked())
    }

    @Test
    fun firstOfflineLaunchDoesNotInventARequiredUpdate() = runTest {
        val coordinator = coordinator(FakeApi(Result.failure(UpdateFailure(UpdateProblem.OFFLINE))), MemoryStore(), { 1_000 })
        coordinator.initialize()
        assertEquals(UpdateDecision.NONE, coordinator.state.value.decision)
    }

    @Test
    fun optionalLaterDefersSameReleaseForExactlyTwentyFourHoursButNeverRequired() = runTest {
        var now = 10_000L
        val api = FakeApi(Result.success(policy(minimum = null)))
        val store = MemoryStore()
        val coordinator = coordinator(api, store, { now })
        coordinator.initialize()
        assertEquals(UpdateDecision.OPTIONAL, coordinator.state.value.decision)

        coordinator.deferOptional()
        assertEquals(UpdateDecision.NONE, coordinator.state.value.decision)
        api.response =
            Result.success(
                policy(
                    revision = 2,
                    minimum = null,
                    target = target(id = "6aa46ad418983c1bd08b574a", build = 3),
                )
            )
        coordinator.check(UpdateTrigger.RETRY)
        assertEquals(UpdateDecision.NONE, coordinator.state.value.decision)
        now += UpdateCoordinator.OPTIONAL_DEFERRAL_MS - 1
        coordinator.check(UpdateTrigger.RETRY)
        assertEquals(UpdateDecision.NONE, coordinator.state.value.decision)
        now++
        coordinator.check(UpdateTrigger.RETRY)
        assertEquals(UpdateDecision.OPTIONAL, coordinator.state.value.decision)

        api.response = Result.success(policy(revision = 3, minimum = 2))
        coordinator.deferOptional()
        coordinator.check(UpdateTrigger.RETRY)
        assertEquals(UpdateDecision.REQUIRED, coordinator.state.value.decision)
    }

    @Test
    fun lowerRevisionAndFailedRequestsCannotReplaceLastValidAuthority() = runTest {
        val api = FakeApi(Result.success(policy(revision = 5)))
        val store = MemoryStore()
        val coordinator = coordinator(api, store, { 1_000 })
        coordinator.initialize()
        api.response = Result.success(policy(revision = 4, minimum = null))
        coordinator.check(UpdateTrigger.RETRY)
        assertEquals(5L, coordinator.state.value.snapshot?.revision)
        assertEquals(UpdateDecision.REQUIRED, coordinator.state.value.decision)
    }

    @Test
    fun foregroundChecksUseTheExactFifteenMinuteBoundary() = runTest {
        var now = 10_000L
        val api = FakeApi(Result.success(policy(minimum = null)))
        val coordinator = coordinator(api, MemoryStore(), { now })
        coordinator.initialize()
        val initialCalls = api.calls

        now += UpdateCoordinator.CHECK_INTERVAL_MS - 1
        coordinator.check(UpdateTrigger.FOREGROUND)
        assertEquals(initialCalls, api.calls)

        now++
        coordinator.check(UpdateTrigger.FOREGROUND)
        assertEquals(initialCalls + 1, api.calls)
    }

    @Test
    fun rateLimitAndFailureBackoffUseExactBoundariesAndClockRollbackChecksImmediately() = runTest {
        var now = 10_000L
        val api =
            FakeApi(
                Result.failure(
                    UpdateFailure(UpdateProblem.RATE_LIMITED, retryAfterSeconds = 60)
                )
            )
        val coordinator = coordinator(api, MemoryStore(), { now })
        coordinator.initialize()
        assertEquals(1, api.calls)

        now += 59_999
        coordinator.check(UpdateTrigger.RETRY)
        assertEquals(1, api.calls)

        now++
        coordinator.check(UpdateTrigger.RETRY)
        assertEquals(2, api.calls)

        api.response = Result.failure(UpdateFailure(UpdateProblem.OFFLINE))
        now += 119_999
        coordinator.check(UpdateTrigger.FOREGROUND)
        assertEquals(2, api.calls)
        now++
        coordinator.check(UpdateTrigger.FOREGROUND)
        assertEquals(3, api.calls)

        now = 1
        coordinator.check(UpdateTrigger.FOREGROUND)
        assertEquals(4, api.calls)
    }

    @Test
    fun processingRejectionIsPersistedBeforeRefreshAndSurvivesOfflineFailure() = runTest {
        val store = MemoryStore()
        val api = FakeApi(Result.failure(UpdateFailure(UpdateProblem.OFFLINE)))
        val coordinator = coordinator(api, store, { 1_000 })
        coordinator.initialize()

        coordinator.processingRejected()

        assertTrue(store.value.provisionalRequired)
        assertEquals(UpdateDecision.REQUIRED, coordinator.state.value.decision)
        assertEquals(UpdateProblem.OFFLINE, coordinator.state.value.failure)
        assertEquals(null, coordinator.state.value.snapshot)

        val restored = coordinator(FakeApi(Result.failure(UpdateFailure(UpdateProblem.OFFLINE))), store, { 2_000 })
        restored.initialize()
        assertEquals(UpdateDecision.REQUIRED, restored.state.value.decision)
    }

    @Test
    fun aNewValidPolicyClearsAProvisionalProcessingBlock() = runTest {
        val store = MemoryStore(StoredUpdateState(provisionalRequired = true))
        val api = FakeApi(Result.success(policy(minimum = null, target = null)))
        val coordinator = coordinator(api, store, { 1_000 })

        coordinator.initialize()

        assertFalse(store.value.provisionalRequired)
        assertEquals(UpdateDecision.NONE, coordinator.state.value.decision)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun concurrentTriggersCoalesceIntoOnePolicyRequest() = runTest {
        val api = FakeApi(Result.success(policy()))
        val coordinator = coordinator(api, MemoryStore(), { 1_000 })
        coordinator.initialize()
        val before = api.calls
        repeat(5) { coordinator.requestCheck(UpdateTrigger.RECONNECT) }
        advanceUntilIdle()
        assertTrue(api.calls - before <= 1)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun cancellingAForegroundRefreshAlwaysClearsCheckingState() = runTest {
        val entered = CompletableDeferred<Unit>()
        val api =
            object : UpdatePolicyApi {
                var block = false

                override suspend fun policy(): UpdatePolicySnapshot {
                    if (block) {
                        entered.complete(Unit)
                        awaitCancellation()
                    }
                    return policy(minimum = null)
                }

            }
        var now = 1_000L
        val coordinator =
            UpdateCoordinator(
                this,
                api,
                MemoryStore(),
                installedBuild = { 1 },
                distribution = "play",
                now = { now },
            )
        coordinator.initialize()
        now += UpdateCoordinator.CHECK_INTERVAL_MS
        api.block = true

        coordinator.setForeground(true)
        entered.await()
        assertTrue(coordinator.state.value.checking)

        coordinator.setForeground(false)
        runCurrent()

        assertFalse(coordinator.state.value.checking)
    }
}
