package com.hatem.musicmute.diagnostics

import android.content.Context
import android.util.Log
import com.hatem.musicmute.BuildConfig
import java.net.HttpURLConnection
import java.net.URI
import java.time.Instant
import java.util.UUID
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext
import kotlinx.serialization.json.*

/** Immutable per-operation identity survives coroutine dispatch and account switches. */
class LocalLogContext(val userId: String?, val traceId: String) : AbstractCoroutineContextElement(Key) {
    companion object Key : CoroutineContext.Key<LocalLogContext>
}

object LocalLogRedaction {
    private val sensitive = Regex("password|passwd|pwd|token|authorization|cookie|secret|apikey|privatekey|ticket|credential|connectionstring|dsn|databaseurl|redisurl|accesskey|sessionid")
    private val embeddedSecret = Regex("(?i)(bearer\\s+|-----BEGIN|(?:mongodb(?:\\+srv)?|redis|rediss|postgres(?:ql)?|mysql)://|(?:password|token|secret|api[_-]?key|authorization)\\s*[:=]|eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+)")

    fun clean(value: Any?): JsonElement {
        var remaining = 512
        fun visit(item: Any?, depth: Int): JsonElement {
            if (depth > 8 || remaining-- <= 0) return buildJsonObject { put("omitted", "structure_limit") }
            val actual: Any? = when (item) {
                is JsonObject -> item.toMap()
                is JsonArray -> item.toList()
                is JsonPrimitive -> when { item is JsonNull -> null; item.isString -> item.content; else -> return item }
                else -> item
            }
            return when (actual) {
                null -> JsonNull
                is Map<*, *> -> buildJsonObject {
                    actual.entries.take(64).forEach { (key, nested) ->
                        val name = key as? String ?: "[unsupported_key]"
                        val safeName = name.take(128)
                        put(safeName, if (sensitive.containsMatchIn(name.lowercase().filter(Char::isLetterOrDigit))) JsonPrimitive("[REDACTED]") else visit(nested, depth + 1))
                    }
                    if (actual.size > 64) put("_omitted", "object_key_limit")
                }
                is Iterable<*> -> buildJsonArray {
                    val iterator = actual.iterator()
                    var count = 0
                    while (iterator.hasNext() && count++ < 32) add(visit(iterator.next(), depth + 1))
                    if (iterator.hasNext()) add(buildJsonObject { put("omitted", "array_limit") })
                }
                is Boolean -> JsonPrimitive(actual)
                is Number -> JsonPrimitive(actual)
                is String -> {
                    when {
                        actual.length > 2_048 -> buildJsonObject { put("omitted", "string_limit"); put("characters", actual.length) }
                        embeddedSecret.containsMatchIn(actual) -> JsonPrimitive("[REDACTED]")
                        actual.startsWith("{") || actual.startsWith("[") -> runCatching { visit(Json.parseToJsonElement(actual), depth + 1) }.getOrElse { JsonPrimitive("[OMITTED_INVALID_ENCODED_JSON]") }
                        else -> {
                            val encodedJson = if (actual.length >= 16) runCatching {
                                val decoded = java.util.Base64.getDecoder().decode(actual).toString(Charsets.UTF_8)
                                if (decoded.startsWith("{") || decoded.startsWith("[")) Json.parseToJsonElement(decoded) else null
                            }.getOrNull() else null
                            if (encodedJson != null) buildJsonObject { put("encoding", "base64_json"); put("value", visit(encodedJson, depth + 1)) }
                            else {
                                val uri = runCatching { URI(actual) }.getOrNull()
                                if (uri?.scheme?.lowercase() in setOf("http", "https", "ws", "wss") && uri?.host != null) {
                                    JsonPrimitive(URI(uri.scheme, null, uri.host, uri.port, uri.path, if (uri.rawQuery != null) "[REDACTED]" else null, null).toString())
                                } else if (Regex("(?i)https?://[^\\s]*[?@]").containsMatchIn(actual)) JsonPrimitive("[REDACTED_URL]")
                                else JsonPrimitive(actual)
                            }
                        }
                    }
                }
                else -> buildJsonObject { put("omitted", "unsupported_type") }
            }
        }
        return visit(value, 0)
    }
}

internal data class LocalLogRecord(val bytes: ByteArray, val important: Boolean)

/** Access is serialized by the delivery lock; warning/error records displace ordinary records. */
internal class LocalLogQueue(private val capacity: Int = 128) {
    private val records = ArrayDeque<LocalLogRecord>()
    var dropped = 0L
        private set
    val size: Int get() = records.size
    fun offer(record: LocalLogRecord): Boolean {
        if (records.size >= capacity) {
            val expendable = if (record.important) records.firstOrNull { !it.important } else null
            if (expendable != null) records.remove(expendable) else { dropped++; return false }
            dropped++
        }
        records.addLast(record)
        return true
    }
    fun take(): LocalLogRecord? = records.removeFirstOrNull()
}

/** Debug opt-in only; no credential/configuration is compiled into any APK. */
object LocalDiagnostics {
    private data class Configuration(val endpoint: String, val key: String, val payloads: Boolean, val console: Boolean)
    private val lock = Any()
    private val pending = LocalLogQueue()
    private var running = false
    private var sent = 0L
    private var failed = 0L
    private val instanceId = UUID.randomUUID().toString()
    @Volatile private var configuration: Configuration? = null
    val enabled: Boolean get() = BuildConfig.DEBUG && configuration != null

    fun initialize(context: Context) {
        if (!BuildConfig.DEBUG) return
        configuration = runCatching {
            val file = java.io.File(context.filesDir, "local-logging.json")
            if (!file.isFile || file.length() > 8_192 || file.canonicalFile.parentFile != context.filesDir.canonicalFile) return@runCatching null
            val data = Json.parseToJsonElement(file.readText()).jsonObject
            if (data["enabled"]?.jsonPrimitive?.booleanOrNull != true) return@runCatching null
            val key = data["key"]?.jsonPrimitive?.content ?: return@runCatching null
            if (!key.matches(Regex("[A-Za-z0-9_-]{32,256}"))) return@runCatching null
            val endpoint = data["endpoint"]?.jsonPrimitive?.content ?: "http://127.0.0.1:19740/ingest/android"
            if (endpoint != "http://127.0.0.1:19740/ingest/android") return@runCatching null
            Configuration(endpoint, key, data["payloads"]?.jsonPrimitive?.booleanOrNull == true, data["console"]?.jsonPrimitive?.booleanOrNull == true)
        }.getOrNull()
        if (enabled) {
            val previous = Thread.getDefaultUncaughtExceptionHandler()
            if (previous != null) Thread.setDefaultUncaughtExceptionHandler { thread, error ->
                emit("runtime.uncaught", "runtime", "fatal", mapOf("error" to LocalDiagnostics.error(error)))
                previous.uncaughtException(thread, error)
            }
        }
        emit("lifecycle.process_started", "lifecycle")
    }

    fun status(): Map<String, Long> = synchronized(lock) {
        mapOf("pending" to (pending.size + if (running) 1 else 0).toLong(), "sent" to sent, "failed" to failed, "dropped" to pending.dropped)
    }

    fun payload(value: String?): Any? {
        if (!enabled || configuration?.payloads != true) return mapOf("omitted" to "payload_capture_disabled")
        if (value == null) return null
        val bytes = value.toByteArray(Charsets.UTF_8).size
        if (bytes > 16_384) return mapOf("omitted" to "payload_byte_limit", "bytes" to bytes)
        return runCatching { LocalLogRedaction.clean(Json.parseToJsonElement(value)) }.getOrElse { mapOf("omitted" to "non_json", "characters" to value.length) }
    }

    fun error(value: Throwable): Map<String, Any> = mapOf("type" to value.javaClass.simpleName, "omitted" to "error_message_and_stack")

    fun emit(name: String, category: String, level: String = "info", data: Map<String, Any?> = emptyMap(), userId: String? = null, requestId: String? = null, traceId: String? = null) {
        if (!BuildConfig.DEBUG) return
        runCatching { emitEnabled(name, category, level, data, userId, requestId, traceId) }
    }

    private fun emitEnabled(name: String, category: String, level: String, data: Map<String, Any?>, userId: String?, requestId: String?, traceId: String?) {
        val config = configuration ?: return
        val event = linkedMapOf<String, Any?>(
            "timestamp" to Instant.now().toString(), "timestampSource" to "original", "level" to level,
            "source" to "android", "origin" to "application", "service" to "musicmute-android", "instanceId" to instanceId,
            "category" to category, "name" to name, "summary" to name, "data" to data, "collector" to status(),
        )
        for (key in listOf("operation", "phase", "result", "status", "durationMs", "jobId", "operationId", "transferId", "streamId", "subscriptionId")) {
            data[key]?.let { event[key] = it }
        }
        userId?.let { event["userId"] = it }
        requestId?.let { event["requestId"] = it }
        traceId?.let { event["traceId"] = it }
        var redacted = LocalLogRedaction.clean(event).jsonObject
        var bytes = redacted.toString().toByteArray(Charsets.UTF_8)
        if (bytes.size > 32_768) {
            event["data"] = mapOf("omitted" to "event_byte_limit")
            redacted = LocalLogRedaction.clean(event).jsonObject
            bytes = redacted.toString().toByteArray(Charsets.UTF_8)
        }
        if (bytes.size > 32_768) return
        if (config.console) Log.d("MusicMuteLocalLog", "android ${(redacted["level"] as? JsonPrimitive)?.content} ${(redacted["name"] as? JsonPrimitive)?.content} pending=${status()["pending"]}")
        val important = level in setOf("warn", "error", "fatal")
        synchronized(lock) {
            if (!pending.offer(LocalLogRecord(bytes, important))) return
            if (running) return
            running = true
            Thread({ drain(config) }, "musicmute-local-log").apply { isDaemon = true }.start()
        }
    }

    private fun drain(config: Configuration) {
        while (true) {
            val record = synchronized(lock) {
                pending.take() ?: run { running = false; return }
            }
            var connection: HttpURLConnection? = null
            val success = runCatching {
                connection = URI(config.endpoint).toURL().openConnection() as HttpURLConnection
                connection!!.run {
                    requestMethod = "POST"; instanceFollowRedirects = false; useCaches = false
                    connectTimeout = 2_000; readTimeout = 2_000; doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                    setRequestProperty("x-musicmute-log-key", config.key)
                    setFixedLengthStreamingMode(record.bytes.size)
                    outputStream.use { it.write(record.bytes) }
                    responseCode in 200..299
                }
            }.getOrDefault(false)
            connection?.disconnect()
            synchronized(lock) { if (success) sent++ else failed++ }
        }
    }
}
