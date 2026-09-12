package com.hatem.musicmute.updates

import com.hatem.musicmute.auth.AuthConfiguration
import com.hatem.musicmute.auth.AuthHttpResponse
import com.hatem.musicmute.auth.AuthHttpTransport
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateApiClientTest {
    @Test
    fun policyAndGrantUsePublicNoStoreContractsWithoutFirebaseCredentials() = runTest {
        var call = 0
        val api =
            UpdateApiClient(
                AuthConfiguration("https://api.example.test", false),
                "direct",
                AuthHttpTransport { url, method, headers, body ->
                    call++
                    assertFalse(headers.containsKey("Authorization"))
                    assertEquals("no-store", headers["Cache-Control"])
                    if (call == 1) {
                        assertTrue(url.endsWith("/app-updates/policy?platform=android&distribution=direct"))
                        assertEquals("GET", method)
                        assertNull(body)
                        AuthHttpResponse(200, POLICY)
                    } else {
                        assertTrue(url.endsWith("/app-updates/releases/6aa46ad418983c1bd08b5749/download"))
                        assertEquals("POST", method)
                        assertEquals("{}", body)
                        AuthHttpResponse(200, GRANT)
                    }
                },
            )

        assertEquals(2, api.policy().target?.buildNumber)
        assertEquals(80_000_000L, api.downloadGrant("6aa46ad418983c1bd08b5749").bytes)
    }

    @Test
    fun unpublishedReleaseIsReportedWithoutLeakingServerMessage() = runTest {
        val api =
            UpdateApiClient(
                AuthConfiguration("https://api.example.test", false),
                "direct",
                AuthHttpTransport { _, _, _, _ ->
                    AuthHttpResponse(404, """{"code":"RESOURCE_NOT_FOUND","message":"private"}""")
                },
            )
        val failure = runCatching { api.downloadGrant("6aa46ad418983c1bd08b5749") }.exceptionOrNull()
        assertEquals(UpdateProblem.RELEASE_UNAVAILABLE, (failure as UpdateFailure).problem)
    }

    private companion object {
        val POLICY =
            """{"schemaVersion":1,"revision":1,"platform":"android","distribution":"direct","minimumBuild":2,"target":{"id":"6aa46ad418983c1bd08b5749","versionName":"0.1.1","buildNumber":2,"changelogEn":"test","source":"direct_apk","storeUrl":null,"artifact":{"bytes":80000000,"sha256Hex":"${"a".repeat(64)}","signerSha256Hex":"${"b".repeat(64)}"}},"checkedAt":"2026-09-12T00:00:00.000Z"}"""
        val GRANT =
            """{"releaseId":"6aa46ad418983c1bd08b5749","url":"https://signed.example.test/release.apk?token=redacted","expiresAt":"2026-09-12T00:15:00.000Z","bytes":80000000,"sha256Hex":"${"a".repeat(64)}","signerSha256Hex":"${"b".repeat(64)}"}"""
    }
}
