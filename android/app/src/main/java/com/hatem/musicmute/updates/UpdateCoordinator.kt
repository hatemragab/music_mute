package com.hatem.musicmute.updates

import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class UpdateCoordinator(
    private val scope: CoroutineScope,
    private val api: UpdatePolicyApi,
    private val store: UpdateStateStore,
    private val installedBuild: () -> Int,
    private val distribution: String,
    private val now: () -> Long = System::currentTimeMillis,
    private val online: () -> Boolean = { true },
) {
    private val mutableState = MutableStateFlow(UpdateUiState())
    val state: StateFlow<UpdateUiState> = mutableState.asStateFlow()
    private val actionLock = Mutex()
    private val requestQueued = AtomicBoolean(false)
    private var persisted = StoredUpdateState()
    private var initialized = false
    private var foregroundJob: Job? = null

    suspend fun initialize() = actionLock.withLock {
        if (initialized) return@withLock
        persisted = runCatching { store.load() }.getOrDefault(StoredUpdateState())
        val cached = persisted.snapshot?.takeIf {
            runCatching { validateUpdateSnapshot(it); it.distribution == distribution }.getOrDefault(false)
        }
        if (cached == null && persisted.snapshot != null)
            persisted = StoredUpdateState(provisionalRequired = persisted.provisionalRequired)
        else persisted = persisted.copy(snapshot = cached)
        publish(restoring = false)
        initialized = true
        if (online() && retryWindowElapsed()) refreshLocked()
        else if (online())
            mutableState.value = mutableState.value.copy(failure = UpdateProblem.RATE_LIMITED)
        else mutableState.value = mutableState.value.copy(failure = UpdateProblem.OFFLINE)
    }

    suspend fun check(trigger: UpdateTrigger) = actionLock.withLock {
        if (!initialized) return@withLock
        if (!online()) {
            mutableState.value = mutableState.value.copy(checking = false, failure = UpdateProblem.OFFLINE)
            return@withLock
        }
        if (!retryWindowElapsed()) return@withLock
        if (trigger in setOf(UpdateTrigger.FOREGROUND, UpdateTrigger.INTERVAL) && !due())
            return@withLock
        refreshLocked()
    }

    suspend fun processingRejected() = actionLock.withLock {
        if (!initialized) return@withLock
        persisted = persisted.copy(provisionalRequired = true)
        store.save(persisted)
        publish()
        if (online()) refreshLocked()
        else mutableState.value = mutableState.value.copy(failure = UpdateProblem.OFFLINE)
    }

    fun reportProcessingRejected() {
        scope.launch { processingRejected() }
    }

    fun requestCheck(trigger: UpdateTrigger) {
        if (!requestQueued.compareAndSet(false, true)) return
        scope.launch {
            try { check(trigger) } finally { requestQueued.set(false) }
        }
    }

    suspend fun deferOptional() = actionLock.withLock {
        if (mutableState.value.decision != UpdateDecision.OPTIONAL) return@withLock
        val id = persisted.snapshot?.target?.id ?: return@withLock
        val timestamp = now()
        persisted =
            persisted.copy(
                optionalReleaseId = id,
                optionalDeferredAtEpochMs = timestamp,
                optionalDeferredUntilEpochMs = timestamp + OPTIONAL_DEFERRAL_MS,
            )
        store.save(persisted)
        publish()
    }

    fun setForeground(active: Boolean) {
        foregroundJob?.cancel()
        foregroundJob = null
        if (!active) return
        foregroundJob =
            scope.launch {
                check(UpdateTrigger.FOREGROUND)
                while (true) {
                    delay(nextDelay())
                    check(UpdateTrigger.INTERVAL)
                }
            }
    }

    private suspend fun refreshLocked() {
        val timestamp = now()
        persisted = persisted.copy(lastAttemptEpochMs = timestamp)
        store.save(persisted)
        mutableState.value = mutableState.value.copy(checking = true, failure = null)
        try {
            val incoming = api.policy()
            validateUpdateSnapshot(incoming)
            if (incoming.distribution != distribution) throw UpdateFailure(UpdateProblem.INVALID_POLICY)
            if ((persisted.snapshot?.revision ?: -1) <= incoming.revision) {
                persisted =
                    persisted.copy(
                        snapshot = incoming,
                        lastSuccessEpochMs = timestamp,
                        failureCount = 0,
                        retryNotBeforeEpochMs = 0,
                        provisionalRequired = false,
                    )
            } else {
                persisted =
                    persisted.copy(
                        lastSuccessEpochMs = timestamp,
                        failureCount = 0,
                        retryNotBeforeEpochMs = 0,
                    )
            }
            store.save(persisted)
            publish()
        } catch (error: CancellationException) {
            throw error
        } catch (error: UpdateFailure) {
            persisted =
                persisted.copy(
                    failureCount = (persisted.failureCount + 1).coerceAtMost(3),
                    retryNotBeforeEpochMs =
                        error.retryAfterSeconds?.let { timestamp + it * 1_000L } ?: 0,
                )
            store.save(persisted)
            publish(failure = error.problem)
        } catch (_: Exception) {
            persisted =
                persisted.copy(
                    failureCount = (persisted.failureCount + 1).coerceAtMost(3),
                    retryNotBeforeEpochMs = 0,
                )
            store.save(persisted)
            publish(failure = UpdateProblem.SERVICE_UNAVAILABLE)
        }
    }

    private fun publish(
        restoring: Boolean = mutableState.value.restoring,
        failure: UpdateProblem? = null,
    ) {
        val cachedSnapshot = persisted.snapshot
        var decision =
            cachedSnapshot?.let { decideUpdate(installedBuild(), it) } ?: UpdateDecision.NONE
        val snapshot =
            if (persisted.provisionalRequired && decision != UpdateDecision.REQUIRED) null
            else cachedSnapshot
        if (persisted.provisionalRequired) decision = UpdateDecision.REQUIRED
        if (decision == UpdateDecision.OPTIONAL && deferred())
            decision = UpdateDecision.NONE
        mutableState.value =
            UpdateUiState(
                restoring = restoring,
                decision = decision,
                snapshot = snapshot,
                checking = false,
                failure = failure,
            )
    }

    private fun deferred(): Boolean {
        val timestamp = now()
        return timestamp >= persisted.optionalDeferredAtEpochMs &&
            timestamp < persisted.optionalDeferredUntilEpochMs
    }

    private fun retryWindowElapsed(): Boolean {
        val timestamp = now()
        return timestamp < persisted.lastAttemptEpochMs ||
            timestamp >= persisted.retryNotBeforeEpochMs
    }

    private fun due(): Boolean {
        val timestamp = now()
        if (timestamp < persisted.lastAttemptEpochMs) return true
        return timestamp >= nextDueAt()
    }

    private fun nextDueAt(): Long {
        val retryDelay =
            when (persisted.failureCount) {
                1 -> 30_000L
                2 -> 120_000L
                else -> CHECK_INTERVAL_MS
            }
        return maxOf(
            persisted.lastAttemptEpochMs + retryDelay,
            persisted.retryNotBeforeEpochMs,
        )
    }

    private fun nextDelay(): Long = (nextDueAt() - now()).coerceAtLeast(1_000L)

    companion object {
        const val CHECK_INTERVAL_MS = 900_000L
        const val OPTIONAL_DEFERRAL_MS = 86_400_000L
    }
}
