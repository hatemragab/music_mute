package com.hatem.musicmute.updates

import com.hatem.musicmute.auth.AuthConfiguration
import com.hatem.musicmute.auth.ApiWireJson
import com.hatem.musicmute.auth.AuthFailure
import com.hatem.musicmute.auth.AuthHttpResponse
import com.hatem.musicmute.auth.AuthHttpTransport
import com.hatem.musicmute.auth.AuthProblem
import com.hatem.musicmute.auth.UrlConnectionAuthTransport
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

interface UpdatePolicyApi {
    suspend fun policy(): UpdatePolicySnapshot
    suspend fun downloadGrant(releaseId: String): ReleaseDownloadGrant
}

class UpdateApiClient(
    private val configuration: AuthConfiguration,
    private val distribution: String,
    private val transport: AuthHttpTransport = UrlConnectionAuthTransport(),
) : UpdatePolicyApi {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    override suspend fun policy(): UpdatePolicySnapshot {
        val snapshot: UpdatePolicySnapshot =
            decode(request("GET", "/app-updates/policy?platform=android&distribution=$distribution"))
        validateUpdateSnapshot(snapshot)
        if (snapshot.distribution != distribution) throw UpdateFailure(UpdateProblem.INVALID_POLICY)
        return snapshot
    }

    override suspend fun downloadGrant(releaseId: String): ReleaseDownloadGrant {
        if (!releaseId.matches(Regex("^[a-f0-9]{24}$")))
            throw UpdateFailure(UpdateProblem.RELEASE_UNAVAILABLE)
        val grant: ReleaseDownloadGrant =
            decode(request("POST", "/app-updates/releases/$releaseId/download-grants", "{}"))
        validateDownloadGrant(grant)
        if (grant.releaseId != releaseId) throw UpdateFailure(UpdateProblem.INVALID_POLICY)
        return grant
    }

    private suspend fun request(method: String, path: String, body: String? = null): String {
        val response =
            try {
                transport.execute(
                    configuration.apiRoot() + path,
                    method,
                    mapOf("Cache-Control" to "no-store"),
                    body?.let(ApiWireJson::request),
                )
            } catch (_: TimeoutCancellationException) {
                throw UpdateFailure(UpdateProblem.SERVICE_UNAVAILABLE)
            } catch (error: CancellationException) {
                throw error
            } catch (error: AuthFailure) {
                throw UpdateFailure(
                    if (error.problem == AuthProblem.OFFLINE) UpdateProblem.OFFLINE
                    else UpdateProblem.SERVICE_UNAVAILABLE
                )
            } catch (_: IOException) {
                throw UpdateFailure(UpdateProblem.OFFLINE)
            }
        if (response.status !in 200..299) throw response.failure()
        return try {
            ApiWireJson.response(response.body)
        } catch (_: SerializationException) {
            throw UpdateFailure(UpdateProblem.INVALID_POLICY)
        } catch (_: IllegalArgumentException) {
            throw UpdateFailure(UpdateProblem.INVALID_POLICY)
        }
    }

    private inline fun <reified T> decode(body: String): T =
        try {
            json.decodeFromString<T>(body)
        } catch (_: SerializationException) {
            throw UpdateFailure(UpdateProblem.INVALID_POLICY)
        } catch (_: IllegalArgumentException) {
            throw UpdateFailure(UpdateProblem.INVALID_POLICY)
        }

    private fun AuthHttpResponse.failure(): UpdateFailure =
        when (status) {
            404 -> UpdateFailure(UpdateProblem.RELEASE_UNAVAILABLE)
            429 ->
                UpdateFailure(
                    UpdateProblem.RATE_LIMITED,
                    retryAfter?.toLongOrNull()?.takeIf { it in 1..86_400 } ?: 60,
                )
            in 500..599 -> UpdateFailure(UpdateProblem.SERVICE_UNAVAILABLE)
            else -> UpdateFailure(UpdateProblem.INVALID_POLICY)
        }
}
