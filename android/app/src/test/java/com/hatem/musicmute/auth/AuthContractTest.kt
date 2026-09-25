package com.hatem.musicmute.auth

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class AuthContractTest {
    @Test fun removesDeviceHistoryWithAuthenticatedEmptyDelete() = runTest {
        val id = "0e47b60a-4835-4cc3-a5b9-2d64d48f8c19"
        val api = client(AuthHttpTransport { url, method, headers, body ->
            assertTrue(url.endsWith("/users/me/devices/$id"))
            assertEquals("DELETE", method)
            assertEquals("Bearer token", headers["Authorization"])
            assertNull(body)
            AuthHttpResponse(204, "")
        })
        api.removeDeviceHistory(id)
    }

    @Test fun historyRemovalRejectsInvalidIdsBeforeSending() = runTest {
        val api = client(AuthHttpTransport { _, _, _, _ -> error("Must not send invalid IDs") })
        assertEquals(AuthProblem.INVALID_INPUT,
            (runCatching { api.removeDeviceHistory("../me") }.exceptionOrNull() as AuthFailure).problem)
    }

    private val profile =
        """{"id":"profile-1","display_name":"Listener","email":null,"email_verified":false,"providers":["apple.com"]}"""

    private fun client(
        transport: AuthHttpTransport,
        uid: () -> String? = { "user-1" },
        token: suspend (Boolean) -> String = { "token" },
    ) = AuthApiClient(AuthConfiguration("https://api.example.test", false), uid, token, transport)

    @Test fun deletionUsesEmptyBodyAndRequiresAcceptedResponse() = runTest {
        val api = client(AuthHttpTransport { url, method, headers, body ->
            assertTrue(url.endsWith("/users/me"))
            assertEquals("DELETE", method)
            assertNull(body)
            assertEquals("Bearer token", headers["Authorization"])
            AuthHttpResponse(202, """{"request_id":"receipt","status":"accepted","recover_until":"2026-09-26T00:00:00.000Z"}""")
        })
        assertEquals("receipt", api.deleteAccount().requestId)
    }

    @Test fun staleDeletionAuthenticationRemainsRecoverable() = runTest {
        val api = client(AuthHttpTransport { _, _, _, _ ->
            AuthHttpResponse(401, """{"code":"REAUTHENTICATION_REQUIRED"}""")
        })
        val failure = runCatching { api.deleteAccount() }.exceptionOrNull() as AuthFailure
        assertEquals(AuthProblem.REAUTH_REQUIRED, failure.problem)
    }

    @Test fun deletionRejectsUnexpectedSuccessAndMalformedReceipt() = runTest {
        listOf(AuthHttpResponse(200, """{"request_id":"receipt","status":"accepted"}"""),
            AuthHttpResponse(202, """{"request_id":"","status":"accepted"}"""),
            AuthHttpResponse(202, """{"request_id":"receipt","status":"completed"}""")).forEach { response ->
            val api = client(AuthHttpTransport { _, _, _, _ -> response })
            assertEquals(AuthProblem.SERVICE_UNAVAILABLE, (runCatching { api.deleteAccount() }.exceptionOrNull() as AuthFailure).problem)
        }
    }

    @Test fun deletionReceiptKeepsCapturedOwnerWhenIdentitySwitches() = runTest {
        var uid = "first"
        val api = client(AuthHttpTransport { _, _, _, _ ->
            uid = "second"
            AuthHttpResponse(202, """{"request_id":"receipt","status":"accepted","recover_until":"2026-09-26T00:00:00.000Z"}""")
        }, uid = { uid })
        assertEquals("receipt", api.deleteAccount("first").requestId)
    }

    @Test fun pendingDeletionUsesTheAuthenticatedRecoveryContract() = runTest {
        var call = 0
        val api = client(AuthHttpTransport { url, method, headers, body ->
            call++
            assertEquals("Bearer token", headers["Authorization"])
            if (call == 1) {
                assertTrue(url.endsWith("/users/me"))
                AuthHttpResponse(403, """{"code":"ACCOUNT_DELETION_PENDING"}""")
            } else {
                assertTrue(url.endsWith("/users/me/account-recovery"))
                assertEquals("POST", method)
                assertEquals("{}", body)
                AuthHttpResponse(
                    202,
                    """{"id":"recovery-1","status":"pending","reason":null,"requested_at":"2026-09-11T00:00:00.000Z","reviewed_at":null,"review_reason":null,"revision":0}""",
                )
            }
        })
        val failure = runCatching { api.me() }.exceptionOrNull() as AuthFailure
        assertEquals(AuthProblem.ACCOUNT_DELETION_PENDING, failure.problem)
        assertEquals("recovery-1", api.requestAccountRecovery(null).id)
    }

    @Test
    fun releaseRejectsUnsafeOrigins() {
        listOf(
                "",
                "http://127.0.0.1:3000",
                "https://name:password@example.test",
                "https://example.test/path",
                "https://example.test?token=x",
                "https://example.test#part",
            )
            .forEach {
                assertFalse(AuthConfiguration(it, false).isConfigured())
            }
        assertEquals(
            "https://example.test",
            AuthConfiguration("https://example.test/", false).apiRoot(),
        )
        assertTrue(AuthConfiguration("http://127.0.0.1:3000", true).isConfigured())
    }

    @Test
    fun unlinkRequiresARemainingMethodUsableOnAndroid() {
        assertFalse(canUnlink(setOf(GOOGLE_PROVIDER), GOOGLE_PROVIDER))
        assertFalse(canUnlink(setOf(GOOGLE_PROVIDER, APPLE_PROVIDER), GOOGLE_PROVIDER))
        assertTrue(canUnlink(setOf(PASSWORD_PROVIDER, GOOGLE_PROVIDER), GOOGLE_PROVIDER))
        assertTrue(canUnlink(setOf(PASSWORD_PROVIDER, GOOGLE_PROVIDER), PASSWORD_PROVIDER))
    }

    @Test
    fun unauthorizedReadRefreshesOnceAndUsesNewBearer() = runTest {
        var calls = 0
        var refreshes = 0
        val api =
            client(
                AuthHttpTransport { _, _, headers, _ ->
                    calls++
                    if (calls == 1) AuthHttpResponse(401, "{}")
                    else {
                        assertEquals("Bearer new", headers["Authorization"])
                        AuthHttpResponse(200, profile)
                    }
                },
                token = { force ->
                    if (force) {
                        refreshes++
                        "new"
                    } else "old"
                },
            )
        assertNull(api.me().email)
        assertEquals(2, calls)
        assertEquals(1, refreshes)
    }

    @Test
    fun concurrentUnauthorizedReadsShareForcedRefreshEvenIfTokenIsUnchanged() = runTest {
        var refreshes = 0
        var requests = 0
        val api =
            client(
                AuthHttpTransport { _, _, _, _ ->
                    requests++
                    if (requests <= 2) {
                        delay(1)
                        AuthHttpResponse(401, "{}")
                    } else AuthHttpResponse(200, profile)
                },
                token = { force ->
                    if (force) {
                        refreshes++
                        delay(10)
                    }
                    "same-token"
                },
            )
        awaitAll(async { api.me() }, async { api.me() })
        assertEquals(1, refreshes)
        assertEquals(4, requests)
    }

    @Test
    fun mailIsNeverReplayedAndPublicRecoveryHasNoBearer() = runTest {
        var calls = 0
        val api =
            client(
                AuthHttpTransport { _, _, headers, _ ->
                    calls++
                    assertTrue(headers.isEmpty())
                    AuthHttpResponse(401, "{}")
                },
                token = { error("Public endpoint requested token") },
            )
        try {
            api.requestPasswordReset("person@example.test")
            fail("Expected failure")
        } catch (failure: AuthFailure) {
            assertEquals(AuthProblem.UNAUTHENTICATED, failure.problem)
        }
        assertEquals(1, calls)
    }

    @Test
    fun privateMailAndLogoutDoNotRetryUnauthorizedRequests() = runTest {
        var requests = 0
        val api =
            client(
                AuthHttpTransport { _, _, _, _ ->
                    requests++
                    AuthHttpResponse(401, "{}")
                },
                token = { force ->
                    assertFalse(force)
                    "old"
                },
            )
        try {
            api.requestVerification()
            fail()
        } catch (_: AuthFailure) {}
        try {
            api.logoutAll()
            fail()
        } catch (_: AuthFailure) {}
        assertEquals(2, requests)
    }

    @Test
    fun accountSwitchDiscardsOldResponse() = runTest {
        var uid = "first"
        val api =
            client(
                AuthHttpTransport { _, _, _, _ ->
                    uid = "second"
                    AuthHttpResponse(200, profile)
                },
                uid = { uid },
            )
        try {
            api.me()
            fail("Old account response was accepted")
        } catch (_: CancellationException) {}
    }

    @Test
    fun throttlingPreservesServerCooldownAndHidesRawMessage() = runTest {
        val api =
            client(
                AuthHttpTransport { _, _, _, _ ->
                    AuthHttpResponse(429, """{"message":"private SDK diagnostic"}""", "123")
                }
            )
        try {
            api.me()
            fail()
        } catch (failure: AuthFailure) {
            assertEquals(AuthProblem.RATE_LIMITED, failure.problem)
            assertEquals(123L, failure.retryAfterSeconds)
            assertEquals("RATE_LIMITED", failure.message)
        }
    }

    @Test
    fun malformedSuccessIsAServiceFailure() = runTest {
        val api = client(AuthHttpTransport { _, _, _, _ -> AuthHttpResponse(200, "{}") })
        try {
            api.me()
            fail()
        } catch (failure: AuthFailure) {
            assertEquals(AuthProblem.SERVICE_UNAVAILABLE, failure.problem)
        }
    }

    @Test
    fun bootstrapIncludesTheDefaultAndroidPlatform() = runTest {
        var body: String? = null
        val api =
            client(
                AuthHttpTransport { _, method, _, requestBody ->
                    assertEquals("POST", method)
                    body = requestBody
                    AuthHttpResponse(200, "{}")
                }
            )

        try {
            api.bootstrap(
                InstallationReport(
                    "123e4567-e89b-42d3-a456-426614174000",
                    appVersion = "1.0",
                    buildNumber = 1,
                    metadataRevision = 1,
                    osVersion = "26.0",
                )
            )
            fail("Expected the stub response to fail decoding")
        } catch (failure: AuthFailure) {
            assertEquals(AuthProblem.SERVICE_UNAVAILABLE, failure.problem)
        }

        assertTrue(body?.contains("\"platform\":\"android\"") == true)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun abandonedIdentityMutationFinishesBeforeTheNextAttempt() = runTest {
        var currentIdentity: String? = null
        val firstResult = CompletableDeferred<String>()
        val firstStarted = CompletableDeferred<Unit>()
        val secondResult = CompletableDeferred<String>()
        val secondStarted = CompletableDeferred<Unit>()
        val gate =
            IdentityMutationGate<String>(backgroundScope) { abandoned ->
                if (currentIdentity == abandoned) currentIdentity = null
            }

        val firstAttempt = launch {
            gate.run {
                firstStarted.complete(Unit)
                firstResult.await().also { currentIdentity = it }
            }
        }
        firstStarted.await()
        gate.invalidate()
        currentIdentity = null
        firstAttempt.cancel()
        val secondAttempt = async {
            gate.run {
                secondStarted.complete(Unit)
                secondResult.await().also { currentIdentity = it }
            }
        }
        runCurrent()
        assertFalse(secondStarted.isCompleted)

        firstResult.complete("old-user")
        runCurrent()
        assertNull(currentIdentity)
        assertTrue(secondStarted.isCompleted)

        secondResult.complete("new-user")
        assertEquals("new-user", secondAttempt.await())
        assertEquals("new-user", currentIdentity)
    }
}
