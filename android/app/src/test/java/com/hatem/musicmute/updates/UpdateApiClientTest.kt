package com.hatem.musicmute.updates

import com.hatem.musicmute.auth.AuthConfiguration
import com.hatem.musicmute.auth.AuthHttpResponse
import com.hatem.musicmute.auth.AuthHttpTransport
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateApiClientTest {
    @Test
    fun policyUsesPublicPlayNoStoreContractWithoutFirebaseCredentials() = runTest {
        val api = UpdateApiClient(AuthConfiguration("https://api.example.test", false), "play",
            AuthHttpTransport { url, method, headers, body ->
                assertFalse(headers.containsKey("Authorization"))
                assertEquals("no-store", headers["Cache-Control"])
                assertTrue(url.endsWith("/app-updates/policy?platform=android&distribution=play"))
                assertEquals("GET", method)
                assertNull(body)
                AuthHttpResponse(200, POLICY)
            })
        assertEquals(2, api.policy().target?.buildNumber)
        assertNull(api.policy().target?.artifact)
    }

    @Test
    fun directDistributionFailsBeforeAnyRequest() = runTest {
        val api = UpdateApiClient(AuthConfiguration("https://api.example.test", false), "direct",
            AuthHttpTransport { _, _, _, _ -> error("Network must not be called") })
        assertEquals(UpdateProblem.INVALID_POLICY, (runCatching { api.policy() }.exceptionOrNull() as UpdateFailure).problem)
    }

    @Test
    fun unpublishedReleaseIsReportedWithoutLeakingServerMessage() = runTest {
        val api =
            UpdateApiClient(
                AuthConfiguration("https://api.example.test", false),
                "play",
                AuthHttpTransport { _, _, _, _ ->
                    AuthHttpResponse(404, """{"code":"RESOURCE_NOT_FOUND","message":"private"}""")
                },
            )
        val failure = runCatching { api.policy() }.exceptionOrNull()
        assertEquals(UpdateProblem.RELEASE_UNAVAILABLE, (failure as UpdateFailure).problem)
    }

    @Test
    fun transportTimeoutIsReportedAsServiceUnavailableRatherThanLifecycleCancellation() = runTest {
        val api =
            UpdateApiClient(
                AuthConfiguration("https://api.example.test", false),
                "play",
                AuthHttpTransport { _, _, _, _ ->
                    withTimeout(1) { awaitCancellation() }
                },
            )

        val failure = runCatching { api.policy() }.exceptionOrNull()

        assertTrue(failure is UpdateFailure)
        assertEquals(UpdateProblem.SERVICE_UNAVAILABLE, (failure as UpdateFailure).problem)
    }

    private companion object {
        val POLICY =
            """{"schema_version":1,"revision":1,"platform":"android","distribution":"play","minimum_build":2,"target":{"id":"6aa46ad418983c1bd08b5749","version_name":"0.1.1","build_number":2,"changelog_en":"test","source":"google_play","store_url":"https://play.google.com/store/apps/details?id=com.hatem.musicmute","artifact":null},"checked_at":"2026-09-12T00:00:00.000Z"}"""
    }
}
