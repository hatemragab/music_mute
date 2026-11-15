package com.hatem.musicmute.auth

import com.hatem.musicmute.diagnostics.LocalDiagnostics
import com.hatem.musicmute.diagnostics.LocalLogContext
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

data class AuthHttpResponse(val status: Int, val body: String, val retryAfter: String? = null, val requestId: String? = null)

fun interface AuthHttpTransport {
    suspend fun execute(
        url: String,
        method: String,
        headers: Map<String, String>,
        body: String?,
    ): AuthHttpResponse
}

/** Bounded, cancellable transport. Redirects are never followed with a Firebase bearer. */
class UrlConnectionAuthTransport : AuthHttpTransport {
    override suspend fun execute(
        url: String,
        method: String,
        headers: Map<String, String>,
        body: String?,
    ): AuthHttpResponse =
        withTimeout(15_000) {
            suspendCancellableCoroutine { continuation ->
                val connection = AtomicReference<HttpURLConnection?>()
                val future = executor.submit {
                    try {
                        val client = URI(url).toURL().openConnection() as HttpURLConnection
                        connection.set(client)
                        if (!continuation.isActive) {
                            client.disconnect()
                            return@submit
                        }
                        client.requestMethod = method
                        client.instanceFollowRedirects = false
                        client.connectTimeout = 15_000
                        client.readTimeout = 15_000
                        client.useCaches = false
                        headers.forEach { (key, value) -> client.setRequestProperty(key, value) }
                        client.setRequestProperty("Accept", "application/json")
                        if (body != null) {
                            client.doOutput = true
                            client.setRequestProperty("Content-Type", "application/json")
                            val bytes = body.toByteArray(Charsets.UTF_8)
                            client.setFixedLengthStreamingMode(bytes.size)
                            client.outputStream.use { it.write(bytes) }
                        }
                        val status = client.responseCode
                        if (client.contentLengthLong > 1_048_576)
                            throw AuthFailure(AuthProblem.SERVICE_UNAVAILABLE)
                        val input =
                            if (status in 200..299) client.inputStream else client.errorStream
                        val bytes = ByteArrayOutputStream()
                        input?.use { stream ->
                            val buffer = ByteArray(8192)
                            while (true) {
                                val length = stream.read(buffer)
                                if (length < 0) break
                                if (bytes.size() + length > 1_048_576)
                                    throw AuthFailure(AuthProblem.SERVICE_UNAVAILABLE)
                                bytes.write(buffer, 0, length)
                            }
                        }
                        if (continuation.isActive)
                            continuation.resume(
                                AuthHttpResponse(
                                    status,
                                    bytes.toString(Charsets.UTF_8.name()),
                                    client.getHeaderField("Retry-After"),
                                    client.getHeaderField("X-Request-Id"),
                                )
                            )
                    } catch (error: Exception) {
                        if (continuation.isActive) continuation.resumeWithException(error)
                    } finally {
                        connection.get()?.disconnect()
                    }
                }
                continuation.invokeOnCancellation {
                    connection.get()?.disconnect()
                    future.cancel(true)
                }
            }
        }

    companion object {
        private val executor =
            Executors.newFixedThreadPool(3) { task ->
                Thread(task, "auth-http").apply { isDaemon = true }
            }
    }
}

class AuthApiClient(
    val configuration: AuthConfiguration,
    private val currentUid: () -> String?,
    private val token: suspend (Boolean) -> String,
    private val transport: AuthHttpTransport = UrlConnectionAuthTransport(),
) {
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
    }
    private val refreshLock = Mutex()
    private var refreshVersion = 0L

    suspend fun bootstrap(report: InstallationReport): SessionResponse =
        decode(request("POST", "/auth/sessions", json.encodeToString(report)))

    suspend fun profileSync(): ProfileSyncResponse =
        decode(request("POST", "/auth/profile-synchronizations", "{}"))

    suspend fun me(): AccountProfile = decode(request("GET", "/users/me"))

    suspend fun devices(before: String? = null): DevicePage {
        if (before != null && !before.matches(Regex("[a-fA-F0-9]{24}")))
            throw AuthFailure(AuthProblem.INVALID_INPUT)
        return decode(
            request("GET", "/users/me/devices?limit=50" + (before?.let { "&before=$it" } ?: ""))
        )
    }

    suspend fun removeDeviceHistory(installationId: String) {
        if (!installationId.matches(Regex("[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-4[a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}")))
            throw AuthFailure(AuthProblem.INVALID_INPUT)
        request("DELETE", "/users/me/devices/$installationId", expectedStatus = 204)
    }

    suspend fun reportInstallation(report: InstallationReport): RegisteredDevice {
        val fields =
            json.parseToJsonElement(json.encodeToString(report)).jsonObject.filterKeys {
                it != "installationId"
            }
        return decode(
            request(
                "PUT",
                "/users/me/devices/${report.installationId}",
                JsonObject(fields).toString(),
            )
        )
    }

    suspend fun policy(): AppPolicy = decode(request("GET", "/app-policy", authenticated = false))

    suspend fun requestVerification(): MailOutcome =
        decode(request("POST", "/auth/verification-emails", "{}", replaySafe = false))

    suspend fun requestPasswordReset(email: String): MailOutcome =
        decode(
            request(
                "POST",
                "/auth/password-reset-requests",
                buildJsonObject { put("email", email) }.toString(),
                authenticated = false,
                replaySafe = false,
            )
        )

    suspend fun deleteAccount(ownerUid: String = currentUid() ?: throw AuthFailure(AuthProblem.UNAUTHENTICATED)): AccountDeletionReceipt {
        val receipt: AccountDeletionReceipt = decode(request("DELETE", "/users/me", replaySafe = false, expectedStatus = 202, expectedOwnerUid = ownerUid, retainResponseForOwner = true))
        if (receipt.status != "accepted" || receipt.requestId.isBlank() || receipt.recoverUntil.isNullOrBlank())
            throw AuthFailure(AuthProblem.SERVICE_UNAVAILABLE)
        return receipt
    }

    suspend fun accountRecovery(): AccountRecoveryStatus =
        decode(request("GET", "/users/me/account-recovery"))

    suspend fun requestAccountRecovery(reason: String?): AccountRecoveryRequest =
        decode(
            request(
                "POST",
                "/users/me/account-recovery",
                buildJsonObject {
                    reason?.trim()?.takeIf { it.isNotEmpty() }?.let { put("reason", it) }
                }.toString(),
                replaySafe = false,
                expectedStatus = 202,
            )
        )

    suspend fun logoutAll() {
        request("POST", "/auth/session-revocations", "{}", replaySafe = false, expectedStatus = 204)
    }

    internal suspend fun request(
        method: String,
        path: String,
        body: String? = null,
        authenticated: Boolean = true,
        replaySafe: Boolean = true,
        expectedStatus: Int? = null,
        expectedOwnerUid: String? = null,
        retainResponseForOwner: Boolean = false,
        additionalHeaders: Map<String, String> = emptyMap(),
        responseFailure: (AuthHttpResponse) -> Exception = ::failure,
    ): String {
        val url = configuration.apiRoot() + path
        val uid =
            if (authenticated) expectedOwnerUid ?: currentUid() ?: throw AuthFailure(AuthProblem.UNAUTHENTICATED)
            else null
        fun checkIdentity() {
            if (authenticated && uid != currentUid())
                throw CancellationException("Auth session changed")
        }
        val traceId = java.util.UUID.randomUUID().toString()
        suspend fun observedExecute(headers: Map<String, String>, wireBody: String?): AuthHttpResponse {
            if (!LocalDiagnostics.enabled) return transport.execute(url, method, headers, wireBody)
            val requestId = java.util.UUID.randomUUID().toString()
            val start = System.nanoTime()
            var observed: AuthHttpResponse? = null
            var result = "failed"
            var error: Map<String, Any> = emptyMap()
            try {
                return withContext(LocalLogContext(uid, traceId)) {
                    transport.execute(url, method, headers + ("X-Request-Id" to requestId), wireBody)
                }.also {
                    observed = it
                    result = if (it.status in 200..299) "completed" else "http_error"
                }
            } catch (failure: Exception) {
                result = if (failure is CancellationException) "aborted" else "failed"
                error = LocalDiagnostics.error(failure)
                throw failure
            } finally {
                val serverRequestId = observed?.requestId?.takeIf { runCatching { java.util.UUID.fromString(it).toString() == it.lowercase() }.getOrDefault(false) }
                LocalDiagnostics.emit("http.completed", "http", if (result == "completed") "info" else "warn", mapOf(
                    "operation" to "http.request", "method" to method, "url" to url,
                    "status" to observed?.status, "result" to result, "durationMs" to (System.nanoTime() - start) / 1_000_000.0,
                    "headers" to headers, "path" to URI(url).path,
                    "query" to runCatching { URI(url).rawQuery?.split('&', limit = 65)?.take(64)?.associate { pair ->
                        val parts = pair.split('=', limit = 2)
                        java.net.URLDecoder.decode(parts[0], "UTF-8") to java.net.URLDecoder.decode(parts.getOrElse(1) { "" }, "UTF-8")
                    } ?: emptyMap() }.getOrElse { mapOf("omitted" to "invalid_query_encoding") }, "request" to LocalDiagnostics.payload(wireBody), "response" to LocalDiagnostics.payload(observed?.body), "error" to error,
                ), userId = uid, requestId = serverRequestId ?: requestId, traceId = traceId)
            }
        }
        return try {
            checkIdentity()
            val wireBody = body?.let(ApiWireJson::request)
            val initialRefreshVersion = refreshVersion
            var bearer = if (authenticated) token(false) else null
            checkIdentity()
            var response =
                observedExecute(
                    additionalHeaders + (bearer?.let { mapOf("Authorization" to "Bearer $it") } ?: emptyMap()),
                    wireBody,
                )
            if (!retainResponseForOwner) checkIdentity()
            if (response.status == 401 && authenticated && replaySafe) {
                bearer = refreshLock.withLock {
                    checkIdentity()
                    if (refreshVersion != initialRefreshVersion) token(false)
                    else token(true).also { refreshVersion++ }
                }
                checkIdentity()
                response =
                    observedExecute(additionalHeaders + mapOf("Authorization" to "Bearer $bearer"), wireBody)
                checkIdentity()
            }
            if (response.status !in 200..299) throw responseFailure(response)
            if (expectedStatus != null && response.status != expectedStatus)
                throw AuthFailure(AuthProblem.SERVICE_UNAVAILABLE)
            try {
                ApiWireJson.response(response.body)
            } catch (_: SerializationException) {
                throw AuthFailure(AuthProblem.SERVICE_UNAVAILABLE)
            } catch (_: IllegalArgumentException) {
                throw AuthFailure(AuthProblem.SERVICE_UNAVAILABLE)
            }
        } catch (_: TimeoutCancellationException) {
            throw AuthFailure(AuthProblem.OFFLINE)
        } catch (error: CancellationException) {
            throw error
        } catch (error: AuthFailure) {
            throw error
        } catch (_: IOException) {
            throw AuthFailure(AuthProblem.OFFLINE)
        }
    }

    private inline fun <reified T> decode(body: String): T =
        try {
            json.decodeFromString<T>(body)
        } catch (_: SerializationException) {
            throw AuthFailure(AuthProblem.SERVICE_UNAVAILABLE)
        } catch (_: IllegalArgumentException) {
            throw AuthFailure(AuthProblem.SERVICE_UNAVAILABLE)
        }

    private fun failure(response: AuthHttpResponse): AuthFailure {
        val code = runCatching {
            json.parseToJsonElement(response.body).jsonObject["code"]?.jsonPrimitive?.content
        }
            .getOrNull()
        val problem =
            when {
                code == "REAUTHENTICATION_REQUIRED" -> AuthProblem.REAUTH_REQUIRED
                response.status == 401 -> AuthProblem.UNAUTHENTICATED
                code == "ACCOUNT_DISABLED" -> AuthProblem.ACCOUNT_DISABLED
                code == "ACCOUNT_DELETION_PENDING" -> AuthProblem.ACCOUNT_DELETION_PENDING
                code == "ACCOUNT_RECOVERY_EXPIRED" -> AuthProblem.ACCOUNT_RECOVERY_EXPIRED
                response.status == 429 -> AuthProblem.RATE_LIMITED
                code == "PROFILE_SYNC_REQUIRED" -> AuthProblem.PROFILE_SYNC_REQUIRED
                code == "DEVICE_REPORT_CONFLICT" -> AuthProblem.DEVICE_CONFLICT
                response.status == 400 -> AuthProblem.INVALID_INPUT
                else -> AuthProblem.SERVICE_UNAVAILABLE
            }
        return AuthFailure(
            problem,
            if (problem == AuthProblem.RATE_LIMITED)
                response.retryAfter?.toLongOrNull()?.takeIf { it in 1..86_400 } ?: 60
            else null,
            httpStatus = response.status,
        )
    }
}
