package com.hatem.musicmute.processing

import com.hatem.musicmute.auth.ApiWireJson
import com.hatem.musicmute.auth.AuthApiClient
import com.hatem.musicmute.auth.AuthFailure
import com.hatem.musicmute.auth.AuthProblem
import java.util.concurrent.TimeUnit
import kotlin.random.Random
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import okhttp3.*

enum class RealtimeState { CONNECTING, LIVE, RECONNECTING, PAUSED, SIGNED_OUT }

/** One raw RFC 6455 socket per account session. All mutable state belongs to the main scope. */
class RealtimeClient(
    private val auth: AuthApiClient,
    private val scope: CoroutineScope,
    private val installationId: () -> String,
    private val http: OkHttpClient = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(10, TimeUnit.SECONDS).pingInterval(30, TimeUnit.SECONDS).build(),
    private val openSocket: (Request, WebSocketListener) -> WebSocket = http::newWebSocket,
) {
    private data class Subscription(val id: String, val resource: String, val params: Map<String, String>, val emit: (Result<String>) -> Unit, var sequence: Long = 0)
    private val subscriptions = linkedMapOf<String, Subscription>()
    private val mutableState = MutableStateFlow(RealtimeState.PAUSED)
    val state = mutableState.asStateFlow()
    private var owner: ProcessingSession? = null
    private var sessionRejected = false
    private var foreground = false
    private var generation = 0L
    private var nextId = 0L
    private var socket: WebSocket? = null
    private var connecting: kotlinx.coroutines.Job? = null
    private var watchdog: kotlinx.coroutines.Job? = null
    private var retry: kotlinx.coroutines.Job? = null
    private var attempt = 0
    private var stream = ""
    private val snapshotDeadlines = mutableMapOf<String, kotlinx.coroutines.Job>()

    fun bindSession(value: ProcessingSession?) {
        if (owner == value) return
        disconnect()
        subscriptions.values.forEach { it.emit(Result.failure(JobsFailure(JobsProblem.UNAUTHENTICATED))) }
        subscriptions.clear()
        owner = value
        sessionRejected = false
        attempt = 0
        resume()
    }

    fun setForeground(value: Boolean) {
        foreground = value
        if (!value) { disconnect(); mutableState.value = if (sessionRejected) RealtimeState.SIGNED_OUT else RealtimeState.PAUSED } else resume()
    }

    fun watch(resource: String, params: Map<String, String> = emptyMap()): Flow<String> = callbackFlow<String> {
        val id = withContext(Dispatchers.Main.immediate) {
            if (sessionRejected) throw JobsFailure(JobsProblem.UNAUTHENTICATED)
            val id = "s${++nextId}"
            if (subscriptions.size >= 128) throw JobsFailure(JobsProblem.SERVICE_UNAVAILABLE)
            val entry = Subscription(id, resource, params, { result -> result.fold({ trySend(it) }, { close(it) }) })
            subscriptions[id] = entry
            if (stream.isNotEmpty()) subscribe(entry)
            resume()
            id
        }
        // Screens may briefly have no collectors during navigation. The Activity and
        // authenticated session own the transport, not individual subscriptions.
        awaitClose { scope.launch { subscriptions.remove(id); snapshotDeadlines.remove(id)?.cancel(); send(buildJsonObject { put("type", "unsubscribe"); put("subscription_id", id) }) } }
    }.buffer(kotlinx.coroutines.channels.Channel.CONFLATED)

    fun resync() {
        if (stream.isEmpty()) { resume(); return }
        subscriptions.values.forEach { send(buildJsonObject { put("type", "resync"); put("subscription_id", it.id) }) }
    }

    private fun resume() {
        if (!foreground || owner == null || sessionRejected || socket != null || connecting?.isActive == true || retry?.isActive == true) return
        val epoch = ++generation
        val session = owner
        mutableState.value = if (attempt == 0) RealtimeState.CONNECTING else RealtimeState.RECONNECTING
        connecting = scope.launch {
            try {
                val body = auth.request("POST", "/realtime-tickets", "{}", expectedStatus = 201,
                    additionalHeaders = mapOf("X-Installation-Id" to installationId()))
                val grant = Json.parseToJsonElement(body).jsonObject
                val ticket = grant["ticket"]?.jsonPrimitive?.content ?: error("Invalid ticket")
                require(ticket.matches(Regex("[A-Za-z0-9_-]{43}")) && grant["path"]?.jsonPrimitive?.content == "/realtime/socket" && grant["protocol"]?.jsonPrimitive?.content == "musicmute.realtime.v1")
                if (epoch != generation || session != owner) return@launch
                val request = Request.Builder().url(auth.configuration.apiRoot() + "/realtime/socket")
                    .header("Sec-WebSocket-Protocol", "musicmute.realtime.v1, ticket.$ticket").build()
                socket = openSocket(request, object : WebSocketListener() {
                    override fun onMessage(webSocket: WebSocket, text: String) { scope.launch { if (epoch == generation) message(text) } }
                    override fun onMessage(webSocket: WebSocket, bytes: okio.ByteString) { scope.launch { if (epoch == generation) reconnect() } }
                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null); scope.launch { if (epoch == generation) reconnect() } }
                    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { scope.launch { if (epoch == generation) reconnect() } }
                })
                armWatchdog(10_000)
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                if (epoch != generation) return@launch
                if (error is AuthFailure && (error.httpStatus in setOf(401, 403) || error.problem in setOf(AuthProblem.UNAUTHENTICATED, AuthProblem.ACCOUNT_DISABLED, AuthProblem.REAUTH_REQUIRED))) {
                    sessionRejected = true
                    mutableState.value = RealtimeState.SIGNED_OUT
                    subscriptions.values.toList().forEach { it.emit(Result.failure(JobsFailure(JobsProblem.UNAUTHENTICATED))) }
                } else reconnect()
            } finally { if (epoch == generation) connecting = null }
        }
    }

    private fun message(text: String) {
        try {
            require(text.toByteArray().size <= 256 * 1024)
            val frame = Json.parseToJsonElement(text).jsonObject
            when (frame["type"]?.jsonPrimitive?.content) {
                "ready" -> {
                    require(frame["protocol_version"]?.jsonPrimitive?.int == 1)
                    stream = frame.getValue("stream_id").jsonPrimitive.content
                    attempt = 0
                    armWatchdog(65_000)
                    subscriptions.values.forEach(::subscribe)
                }
                "ping" -> { send(buildJsonObject { put("type", "pong") }); armWatchdog(65_000) }
                "snapshot", "subscription_error" -> {
                    if (frame["stream_id"]?.jsonPrimitive?.content != stream) return
                    val entry = subscriptions[frame["subscription_id"]?.jsonPrimitive?.content] ?: return
                    if (frame["type"]?.jsonPrimitive?.content == "subscription_error") {
                        val status = frame["status"]?.jsonPrimitive?.int ?: 503
                        if (status >= 500) { reconnect(); return }
                        entry.emit(Result.failure(JobsFailure(if (status == 404) JobsProblem.JOB_NOT_FOUND else JobsProblem.UNAUTHENTICATED)))
                        return
                    }
                    require(frame["protocol_version"]?.jsonPrimitive?.int == 1)
                    val sequence = frame.getValue("sequence").jsonPrimitive.long
                    require(sequence > 0)
                    if (sequence <= entry.sequence) return
                    if (entry.sequence != 0L && sequence != entry.sequence + 1) { entry.sequence = 0; send(buildJsonObject { put("type", "resync"); put("subscription_id", entry.id) }); return }
                    snapshotDeadlines.remove(entry.id)?.cancel()
                    entry.sequence = sequence
                    entry.emit(Result.success(ApiWireJson.response(frame.getValue("data").toString())))
                    if (subscriptions.values.all { it.sequence > 0 }) mutableState.value = RealtimeState.LIVE
                }
            }
        } catch (_: Exception) { reconnect() }
    }

    private fun subscribe(entry: Subscription) {
        entry.sequence = 0
        snapshotDeadlines.remove(entry.id)?.cancel()
        snapshotDeadlines[entry.id] = scope.launch { delay(15_000); reconnect() }
        send(buildJsonObject { put("type", "subscribe"); put("subscription_id", entry.id); put("resource", entry.resource); put("params", buildJsonObject { entry.params.forEach { (key, value) -> put(key, value) } }) })
    }
    private fun send(frame: JsonObject) { if (socket?.send(frame.toString()) == false) reconnect() }
    private fun armWatchdog(milliseconds: Long) { watchdog?.cancel(); watchdog = scope.launch { delay(milliseconds); reconnect() } }
    private fun reconnect() {
        disconnect()
        mutableState.value = RealtimeState.RECONNECTING
        retry = scope.launch { delay((1000L shl attempt++.coerceAtMost(5)).coerceAtMost(30_000) + Random.nextLong(250)); retry = null; resume() }
    }
    private fun disconnect() {
        generation++
        connecting?.cancel(); connecting = null
        watchdog?.cancel(); watchdog = null
        retry?.cancel(); retry = null
        socket?.cancel(); socket = null
        stream = ""
        snapshotDeadlines.values.forEach { it.cancel() }; snapshotDeadlines.clear()
        subscriptions.values.forEach { it.sequence = 0 }
    }
}
