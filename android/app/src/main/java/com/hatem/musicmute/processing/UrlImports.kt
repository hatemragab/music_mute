package com.hatem.musicmute.processing

import com.hatem.musicmute.auth.AuthApiClient
import com.hatem.musicmute.auth.AuthFailure
import com.hatem.musicmute.auth.AuthHttpResponse
import com.hatem.musicmute.auth.AuthProblem
import java.net.URI
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job as CoroutineJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

@Serializable
data class UrlImportRecord(
    val ownerUid: String,
    val url: String,
    val requestId: String,
    val importId: String? = null,
    val status: String = "pending",
    val jobId: String? = null,
    val errorCode: String? = null,
    val sourceTitle: String? = null,
    val createdAtMillis: Long = 0,
    val jobObserved: Boolean = false,
    val serverStageTimings: ServerStageTimings? = null,
) {
    companion object {
        val terminalStatuses = setOf("submitted", "failed")
    }
}

@Serializable
data class UrlImportView(
    val importId: String,
    val status: String,
    val jobId: String?,
    val error: UrlImportError?,
    val createdAt: String,
    val updatedAt: String,
    val serverStageTimings: ServerStageTimings? = null,
    val sourceTitle: String? = null,
)

@Serializable data class UrlImportError(val code: String, val message: String)

class UrlImportFailure(val code: String, val retryAfterSeconds: Long? = null) : Exception(code)

interface UrlImportsApi {
    suspend fun create(url: String, requestId: String): UrlImportView
    suspend fun detail(importId: String): UrlImportView
}

class UrlImportsApiClient(
    private val auth: AuthApiClient,
    private val installationId: () -> String,
) : UrlImportsApi {
    private val json = Json { ignoreUnknownKeys = true }
    override suspend fun create(url: String, requestId: String): UrlImportView {
        require(UUID.fromString(requestId).version() == 4)
        val body = buildJsonObject { put("url", url); put("requestId", requestId) }.toString()
        return decode(authRequest("POST", "/media-imports", body, true, 202))
    }

    override suspend fun detail(importId: String): UrlImportView {
        require(importId.matches(Regex("[a-fA-F0-9]{24}")))
        return decode(authRequest("GET", "/media-imports/$importId", null, false, 200))
    }

    private suspend fun authRequest(method: String, path: String, body: String?, access: Boolean, expected: Int): String = try {
        val headers = if (access) {
            val id = installationId()
            if (runCatching { UUID.fromString(id) }.getOrNull() == null)
                throw UrlImportFailure("DEVICE_SYNC_REQUIRED")
            mapOf("X-Installation-Id" to id)
        } else emptyMap()
        auth.request(method, path, body, expectedStatus = expected, additionalHeaders = headers,
            responseFailure = ::failure)
    } catch (error: AuthFailure) {
        throw UrlImportFailure(when (error.problem) {
            AuthProblem.OFFLINE -> "OFFLINE"
            AuthProblem.UNAUTHENTICATED, AuthProblem.REAUTH_REQUIRED -> "UNAUTHENTICATED"
            AuthProblem.ACCOUNT_DISABLED -> "ACCOUNT_DISABLED"
            else -> "SERVICE_UNAVAILABLE"
        })
    }

    private fun decode(body: String): UrlImportView {
        val view = try { json.decodeFromString<UrlImportView>(body) }
        catch (_: Exception) { throw UrlImportFailure("SERVICE_UNAVAILABLE") }
        if (!view.importId.matches(Regex("[a-f0-9]{24}")) ||
            view.status !in setOf("queued", "downloading", "validating", "uploading", "submitted", "failed") ||
            view.jobId?.matches(Regex("[a-f0-9]{24}")) == false ||
            (view.status == "submitted" && view.jobId == null) ||
            view.createdAt.isBlank() || view.updatedAt.isBlank()
        ) throw UrlImportFailure("SERVICE_UNAVAILABLE")
        return view
    }

    private fun failure(response: AuthHttpResponse): Exception {
        val code = runCatching {
            json.parseToJsonElement(response.body).jsonObject["code"]?.jsonPrimitive?.content
        }.getOrNull()
        val safeCode = code?.takeIf { it in knownErrors } ?: when (response.status) {
            401 -> "UNAUTHENTICATED"
            403 -> "POLICY_DENIED"
            409 -> "IMPORT_REQUEST_CONFLICT"
            429 -> "RATE_LIMITED"
            else -> "SERVICE_UNAVAILABLE"
        }
        return UrlImportFailure(safeCode,
            response.retryAfter?.toLongOrNull()?.takeIf { it in 1..3_600 })
    }

    companion object {
        private val knownErrors = setOf(
            "IMPORT_DISABLED", "IMPORT_INVALID_URL", "IMPORT_UNSUPPORTED_PROVIDER",
            "IMPORT_SINGLE_ITEM_REQUIRED", "IMPORT_UNSUPPORTED_AUDIO_SOURCE", "IMPORT_TOO_LARGE",
            "IMPORT_TOO_LONG", "IMPORT_INVALID_AUDIO", "IMPORT_QUEUE_FULL", "IMPORT_UPSTREAM_REFUSED",
            "IMPORT_SOURCE_UNAVAILABLE", "IMPORT_DEPENDENCY_FAILED", "IMPORT_DISK_FULL",
            "IMPORT_NOT_FOUND", "IMPORT_REQUEST_CONFLICT", "PROCESSING_ALLOWANCE_EXHAUSTED",
            "PROCESSING_LIMIT_REACHED", "PROCESSING_UNAVAILABLE", "ACCOUNT_RESTRICTED",
            "ACCOUNT_DISABLED", "ACCOUNT_DELETION_PENDING", "EMAIL_VERIFICATION_REQUIRED",
            "APP_UPDATE_REQUIRED", "PROFILE_SYNC_REQUIRED", "DEVICE_SYNC_REQUIRED",
            "UPLOAD_GRANT_LIMIT_REACHED", "UPLOAD_BYTE_LIMIT_REACHED",
            "RETAINED_STORAGE_LIMIT_REACHED", "SERVICE_BANDWIDTH_LIMIT_REACHED",
        )
    }
}

/** Extract exactly one shared link. Manual entry must contain only the link. */
object UrlImportSource {
    private val link = Regex("https?://[^\\s<>]+", RegexOption.IGNORE_CASE)
    fun sharedText(text: String?): String? {
        val matches = link.findAll(text.orEmpty()).map { it.value.trimEnd('.', ',', ')') }.toList()
        return matches.singleOrNull()
    }

    fun canonical(raw: String): String {
        val value = raw.trim()
        if (value.length !in 1..2048 || value.any { it.isWhitespace() || it.isISOControl() || it == '\\' })
            throw UrlImportFailure("IMPORT_INVALID_URL")
        val uri = try { URI(value) } catch (_: Exception) { throw UrlImportFailure("IMPORT_INVALID_URL") }
        if (uri.scheme?.lowercase() !in setOf("http", "https") || uri.host == null ||
            uri.rawUserInfo != null || uri.port != -1 || uri.rawFragment != null)
            throw UrlImportFailure("IMPORT_INVALID_URL")
        val host = uri.host.lowercase().removePrefix("www.")
        val path = uri.rawPath.orEmpty().trimEnd('/')
        return when {
            host in setOf("soundcloud.com", "m.soundcloud.com") -> {
                if (uri.rawQuery.orEmpty().split('&').any { it.startsWith("in=") } ||
                    !Regex("/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+").matches(path) ||
                    path.split('/').contains("sets")) throw UrlImportFailure("IMPORT_SINGLE_ITEM_REQUIRED")
                "https://soundcloud.com$path"
            }
            host == "on.soundcloud.com" -> {
                if (!Regex("/[A-Za-z0-9]+").matches(path)) throw UrlImportFailure("IMPORT_SINGLE_ITEM_REQUIRED")
                "https://on.soundcloud.com$path"
            }
            host == "tumblr.com" || Regex("[a-z0-9-]+\\.tumblr\\.com").matches(host) -> {
                val match = if (host == "tumblr.com")
                    Regex("/(?:blog/view/)?([A-Za-z0-9-]{1,32})/(\\d{1,20})(?:/[^/]+)?").matchEntire(path)
                else Regex("/post/(\\d{1,20})(?:/[^/]+)?").matchEntire(path)
                if (match == null) throw UrlImportFailure("IMPORT_SINGLE_ITEM_REQUIRED")
                val blog = if (host == "tumblr.com") match.groupValues[1] else host.substringBefore('.')
                val post = if (host == "tumblr.com") match.groupValues[2] else match.groupValues[1]
                "https://www.tumblr.com/$blog/$post"
            }
            else -> {
                // The server determines extractor support and enforces audio-only downloads.
                // Keep provider query parameters intact (they may identify the media).
                if (!host.contains('.') || host.startsWith('[') ||
                    host.matches(Regex("[0-9.]+")) ||
                    Regex("(?:^|\\.)(?:local|localhost|internal)$").containsMatchIn(host))
                    throw UrlImportFailure("IMPORT_INVALID_URL")
                value
            }
        }
    }
}

/** Server admission and state survive Activity recreation and process restart. */
class UrlImportCoordinator(
    private val store: ProcessingStore,
    private val api: UrlImportsApi,
    private val scope: CoroutineScope,
    private val session: () -> ProcessingSession?,
) {
    private val mutableRecords = MutableStateFlow<List<UrlImportRecord>>(emptyList())
    val records = mutableRecords.asStateFlow()
    private var owner: ProcessingSession? = null
    private var observeTask: CoroutineJob? = null
    private val tasks = mutableMapOf<String, CoroutineJob>()

    fun bindSession(value: ProcessingSession?) {
        if (owner == value) return
        observeTask?.cancel()
        tasks.values.forEach { it.cancel() }
        tasks.clear()
        owner = value
        mutableRecords.value = emptyList()
        if (value == null) return
        observeTask = scope.launch {
            store.urlImports(value.uid).collect { records ->
                if (owner != value || session() != value) return@collect
                mutableRecords.value = records
                records.filter { it.status !in UrlImportRecord.terminalStatuses && it.status != "attention" }
                    .forEach { record ->
                        if (tasks[record.requestId]?.isActive != true) {
                            val task = scope.launch(start = kotlinx.coroutines.CoroutineStart.LAZY) {
                                run(value, record.requestId)
                            }
                            tasks[record.requestId] = task
                            task.invokeOnCompletion {
                                if (tasks[record.requestId] === task) tasks.remove(record.requestId)
                            }
                            task.start()
                        }
                    }
            }
        }
    }

    suspend fun submit(text: String) {
        val ticket = owner?.takeIf { it == session() } ?: throw UrlImportFailure("UNAUTHENTICATED")
        val url = UrlImportSource.canonical(text)
        val record = store.addUrlImport(ticket.uid,
            UrlImportRecord(ticket.uid, url, UUID.randomUUID().toString(), createdAtMillis = System.currentTimeMillis()))
        if (record.status == "attention") retry(record)
    }

    suspend fun observeJobs(jobIds: Set<String>) {
        val ticket = owner?.takeIf { it == session() } ?: return
        records.value.filter { !it.jobObserved && it.jobId in jobIds }.forEach { record ->
            store.updateUrlImport(ticket.uid, record.requestId) { it.copy(jobObserved = true) }
        }
    }

    suspend fun retry(record: UrlImportRecord) {
        val ticket = owner?.takeIf { it == session() && it.uid == record.ownerUid }
            ?: throw UrlImportFailure("UNAUTHENTICATED")
        tasks.remove(record.requestId)?.cancel()
        store.updateUrlImport(ticket.uid, record.requestId) { current ->
            if (current.status == "attention" && current.errorCode == "IMPORT_REQUEST_CONFLICT")
                current.copy(status = "failed")
            else if (current.status == "attention")
                current.copy(status = if (current.importId == null) "pending" else "queued", errorCode = null)
            else current
        }
        if (record.status == "failed" || record.errorCode == "IMPORT_REQUEST_CONFLICT") submit(record.url)
    }

    private suspend fun run(ticket: ProcessingSession, requestId: String) {
        while (owner == ticket && session() == ticket) {
            val record = store.urlImports(ticket.uid).first()
                .firstOrNull { it.requestId == requestId } ?: return
            if (record.status in UrlImportRecord.terminalStatuses || record.status == "attention") return
            try {
                val view = if (record.importId == null) api.create(record.url, record.requestId)
                    else api.detail(record.importId)
                if (owner != ticket || session() != ticket) return
                store.updateUrlImport(ticket.uid, requestId) {
                    it.copy(importId = view.importId, status = view.status, jobId = view.jobId,
                        errorCode = view.error?.code, sourceTitle = view.sourceTitle ?: it.sourceTitle,
                        serverStageTimings = view.serverStageTimings)
                }
                if (view.status == "submitted") {
                    return
                }
                if (view.status == "failed") return
                delay(3_000)
            } catch (error: CancellationException) {
                throw error
            } catch (error: UrlImportFailure) {
                if (owner != ticket || session() != ticket) return
                if (error.code == "IMPORT_NOT_FOUND" && record.importId != null) {
                    store.updateUrlImport(ticket.uid, requestId) {
                        it.copy(status = "failed", errorCode = "IMPORT_NOT_FOUND")
                    }
                    return
                }
                if (error.code in setOf("OFFLINE", "SERVICE_UNAVAILABLE", "IMPORT_QUEUE_FULL",
                        "IMPORT_DEPENDENCY_FAILED", "IMPORT_DISK_FULL", "RATE_LIMITED")) {
                    store.updateUrlImport(ticket.uid, requestId) { it.copy(errorCode = error.code) }
                    delay((error.retryAfterSeconds?.times(1_000) ?: 15_000).coerceAtLeast(15_000))
                } else {
                    store.updateUrlImport(ticket.uid, requestId) { it.copy(status = "attention", errorCode = error.code) }
                    return
                }
            } catch (_: Exception) {
                if (owner != ticket || session() != ticket) return
                store.updateUrlImport(ticket.uid, requestId) { it.copy(errorCode = "SERVICE_UNAVAILABLE") }
                delay(15_000)
            }
        }
    }
}
