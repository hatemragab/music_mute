package com.hatem.musicmute.processing

import com.hatem.musicmute.auth.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class AuthPushRegistrationApiTest {
    private val installation = "d7ea7de6-52e9-4b96-8834-3b517941bdb0"

    @Test fun registerAndConditionalDeactivationUseExactAuthenticatedContract() = runTest {
        val calls = mutableListOf<String>()
        val api = AuthPushRegistrationApi(client(AuthHttpTransport { url, method, headers, body ->
            assertEquals("Bearer old-credential", headers["Authorization"])
            calls += method
            val payload = Json.parseToJsonElement(body!!).jsonObject
            if (method == "PUT") {
                assertEquals("https://api.invalid/api/v1/devices/$installation/push", url)
                assertEquals(setOf("token"), payload.keys)
                assertEquals("private-token", payload["token"]!!.jsonPrimitive.content)
                AuthHttpResponse(200, """{"installationId":"$installation","active":true,"bindingRevision":7}""")
            } else {
                assertEquals("https://api.invalid/api/v1/devices/$installation/push/deactivate", url)
                assertEquals(setOf("expectedBindingRevision"), payload.keys)
                assertEquals(7L, payload["expectedBindingRevision"]!!.jsonPrimitive.long)
                AuthHttpResponse(204, "")
            }
        }))
        assertEquals(7L, api.register(installation, "private-token").bindingRevision)
        api.deactivate(installation, 7)
        assertEquals(listOf("PUT", "POST"), calls)
    }

    @Test fun deactivationDoesNotRefreshOrReplayOnUnauthorized() = runTest {
        var requests = 0
        var refreshes = 0
        val api = AuthPushRegistrationApi(client(AuthHttpTransport { _, _, _, _ ->
            requests++
            AuthHttpResponse(401, "{}")
        }, token = { force -> if (force) refreshes++; "old-credential" }))
        try { api.deactivate(installation, 7); fail("Expected unauthorized") }
        catch (_: AuthFailure) { }
        assertEquals(1, requests)
        assertEquals(0, refreshes)
    }

    @Test fun invalidBindingResponseCannotAuthorizeCleanup() = runTest {
        for (revision in listOf("0", "-1", "1.5", "null", "\"7\"", "9007199254740992")) {
            val api = AuthPushRegistrationApi(client(AuthHttpTransport { _, _, _, _ ->
                AuthHttpResponse(200, """{"installationId":"$installation","active":true,"bindingRevision":$revision}""")
            }))
            try { api.register(installation, "token"); fail("Unsafe revision accepted") }
            catch (error: AuthFailure) { assertEquals(AuthProblem.SERVICE_UNAVAILABLE, error.problem) }
        }
    }

    private fun client(transport: AuthHttpTransport, token: suspend (Boolean) -> String = { "old-credential" }) =
        AuthApiClient(AuthConfiguration("https://api.invalid", false), { "owner" }, token, transport)
}
