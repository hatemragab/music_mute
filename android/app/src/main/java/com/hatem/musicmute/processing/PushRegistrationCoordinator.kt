package com.hatem.musicmute.processing

import com.hatem.musicmute.auth.AuthApiClient
import com.hatem.musicmute.auth.AuthFailure
import com.hatem.musicmute.auth.AuthProblem
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job as CoroutineJob
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.*

/** Supply only after successful backend device/session synchronization (not cached offline login). */
data class PushSession(val uid: String, val epoch: Long, val installationId: String)
data class PushBinding(val installationId: String, val active: Boolean, val bindingRevision: Long)
data class ProcessingJobHint(val jobId: String, val eventId: String, val outcome: String)

fun processingJobHint(data: Map<String, String>): ProcessingJobHint? {
    if (data["type"] != "audio_job_outcome") return null
    val job = data["jobId"]?.takeIf { it.matches(Regex("[a-fA-F0-9]{24}")) } ?: return null
    val event = data["eventId"]?.takeIf { it.matches(Regex("[a-zA-Z0-9_:-]{1,128}")) } ?: return null
    val outcome = data["outcome"]?.takeIf { it == "ready" || it == "failed" } ?: return null
    return ProcessingJobHint(job.lowercase(java.util.Locale.ROOT), event, outcome)
}

interface PushRegistrationApi {
    suspend fun register(installationId: String, token: String): PushBinding
    suspend fun deactivate(installationId: String, expectedBindingRevision: Long)
}

class AuthPushRegistrationApi(private val auth: AuthApiClient) : PushRegistrationApi {
    override suspend fun register(installationId: String, token: String): PushBinding {
        validateInstallation(installationId)
        if (!validPushToken(token)) throw AuthFailure(AuthProblem.INVALID_INPUT)
        val body = auth.request("PUT", "/devices/$installationId/push",
            buildJsonObject { put("token", token) }.toString(), expectedStatus = 200)
        return try {
            val objectValue = Json.parseToJsonElement(body).jsonObject
            val id = objectValue["installationId"]?.jsonPrimitive
            val active = objectValue["active"]?.jsonPrimitive
            val revision = objectValue["bindingRevision"]?.jsonPrimitive
            val number = revision?.takeIf { !it.isString }?.longOrNull
            if (id?.isString != true || !id.content.equals(installationId, ignoreCase = true) ||
                active?.isString != false || active.booleanOrNull != true ||
                number == null || number !in 1..9_007_199_254_740_991L) throw IllegalArgumentException()
            PushBinding(id.content, true, number)
        } catch (_: IllegalArgumentException) { throw AuthFailure(AuthProblem.SERVICE_UNAVAILABLE) }
    }

    override suspend fun deactivate(installationId: String, expectedBindingRevision: Long) {
        validateInstallation(installationId)
        require(expectedBindingRevision in 1..9_007_199_254_740_991L)
        auth.request("POST", "/devices/$installationId/push-deactivations",
            buildJsonObject { put("expectedBindingRevision", expectedBindingRevision) }.toString(),
            replaySafe = false, expectedStatus = 204)
    }
}

private fun validateInstallation(value: String) {
    if (!value.matches(Regex("[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-4[a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}")))
        throw AuthFailure(AuthProblem.INVALID_INPUT)
}
private fun validPushToken(token: String): Boolean = token.length in 1..4096 && token.all { it.code in 33..126 }

/** Tokens and conditional cleanup bindings are memory-only; failures retry on foreground/session sync. */
class PushRegistrationCoordinator(
    private val api: PushRegistrationApi,
    private val jobsApi: JobsApi,
    private val sessionProvider: () -> PushSession?,
    private val identityUid: () -> String?,
    private val tokenSource: suspend () -> String?,
    private val permitted: () -> Boolean,
    private val enabled: Boolean,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
) {
    private data class Registered(val session: PushSession, val token: String, val binding: PushBinding)
    private val lock = Any()
    private val tapLock = Mutex()
    private var generation = 0L
    private var token: String? = null
    private var tokenVersion = 0L
    private var registered: Registered? = null
    private var syncJob: CoroutineJob? = null
    private var syncAgain = false
    private var forceSync = false
    private val seenRefresh = LinkedHashSet<String>()
    private val seenTaps = LinkedHashSet<String>()
    private val mutableRefresh = MutableSharedFlow<ProcessingJobHint>(extraBufferCapacity = 1)
    private val mutableTap = MutableStateFlow<ProcessingJobHint?>(null)
    val refreshHints: SharedFlow<ProcessingJobHint> = mutableRefresh.asSharedFlow()
    val pendingTap: StateFlow<ProcessingJobHint?> = mutableTap.asStateFlow()

    fun onToken(value: String) {
        if (!enabled || !validPushToken(value)) return
        synchronized(lock) { token = value; tokenVersion++ }
        scheduleSync()
    }

    fun onSessionChanged() {
        synchronized(lock) {
            generation++
            syncJob?.cancel()
            syncJob = null
            syncAgain = false
            // Preserve the old acknowledged revision until the before-sign-out hook consumes it.
            // A hint received before initial login remains pending; explicit logout clears it below.
        }
        scheduleSync(force = true)
    }

    fun onForeground() = scheduleSync(force = true)

    private fun scheduleSync(force: Boolean = false) {
        if (!enabled) return
        synchronized(lock) {
            syncAgain = true
            forceSync = forceSync || force
            if (syncJob?.isActive == true) return
            syncJob = scope.launch(start = CoroutineStart.LAZY) {
                do {
                    val forced = synchronized(lock) { syncAgain = false; forceSync.also { forceSync = false } }
                    try { syncOnce(forced) }
                    catch (error: CancellationException) { throw error }
                    catch (_: Exception) { /* Optional push retries on foreground; no token/error logging. */ }
                } while (synchronized(lock) { syncAgain })
            }
            syncJob?.start()
        }
    }

    private suspend fun syncOnce(force: Boolean) {
        currentCoroutineContext().ensureActive()
        if (!permitted()) return
        val session = sessionProvider() ?: return
        if (session.uid != identityUid()) return
        validateInstallation(session.installationId)
        val (ticket, version) = synchronized(lock) { generation to tokenVersion }
        val candidate = synchronized(lock) { token } ?: tokenSource()?.takeIf(::validPushToken) ?: return
        synchronized(lock) {
            if (!current(session, ticket) || tokenVersion != version || !permitted()) return
            token = candidate
            if (!force && registered?.let { it.session == session && it.token == candidate } == true) return
        }
        currentCoroutineContext().ensureActive()
        val response = api.register(session.installationId, candidate)
        synchronized(lock) {
            if (!current(session, ticket)) return
            registered = Registered(session, candidate, response)
        }
    }

    /** UI can clear immediately; the SDK identity must remain old until this bounded callback ends. */
    suspend fun beforeSignOut(uid: String, installationId: String?) {
        val (pending, binding) = synchronized(lock) {
            generation++
            syncAgain = false
            mutableTap.value = null
            val oldJob = syncJob
            syncJob = null
            val old = registered?.takeIf { it.session.uid == uid && it.session.installationId == installationId }
            registered = null
            oldJob to old
        }
        pending?.cancel()
        if (!enabled || binding == null || identityUid() != uid) return
        try {
            withTimeoutOrNull(1_500) {
                pending?.cancelAndJoin()
                if (identityUid() == uid) api.deactivate(binding.binding.installationId, binding.binding.bindingRevision)
            }
        } catch (_: Exception) { /* Never persist/replay deactivation with another session's credentials. */ }
    }

    fun onMessage(data: Map<String, String>) {
        if (!enabled) return
        val hint = processingJobHint(data) ?: return
        synchronized(lock) {
            val session = sessionProvider() ?: return
            if (session.uid != identityUid() || !remember(seenRefresh, hint.eventId)) return
            mutableRefresh.tryEmit(hint)
        }
    }

    fun rememberTap(data: Map<String, String>) {
        if (!enabled) return
        val hint = processingJobHint(data) ?: return
        synchronized(lock) { if (hint.eventId !in seenTaps) mutableTap.value = hint }
    }

    /** Fetch first using current credentials; notification data never authorizes or switches accounts. */
    suspend fun resolvePendingTap(): Job? = tapLock.withLock {
        val hint = synchronized(lock) { mutableTap.value } ?: return@withLock null
        val session = sessionProvider() ?: return@withLock null
        val ticket = synchronized(lock) { generation }
        if (identityUid() != session.uid) return@withLock null
        val job = try { jobsApi.detail(hint.jobId) }
        catch (failure: JobsFailure) {
            if (failure.problem != JobsProblem.JOB_NOT_FOUND) throw failure
            synchronized(lock) {
                if (current(session, ticket) && mutableTap.value == hint) {
                    mutableTap.value = null
                    remember(seenTaps, hint.eventId)
                }
            }
            return@withLock null
        }
        synchronized(lock) {
            if (!current(session, ticket) || mutableTap.value != hint || job.id != hint.jobId) return@withLock null
            mutableTap.value = null
            remember(seenTaps, hint.eventId)
            job
        }
    }

    private fun current(session: PushSession, ticket: Long): Boolean =
        generation == ticket && sessionProvider() == session && identityUid() == session.uid

    private fun remember(values: LinkedHashSet<String>, eventId: String): Boolean {
        if (!values.add(eventId)) return false
        if (values.size > 128) values.remove(values.first())
        return true
    }
}
