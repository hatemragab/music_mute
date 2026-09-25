package com.hatem.musicmute.auth

import java.io.File
import org.junit.Assert.*
import org.junit.Test
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.runCurrent

class AccountDeletionTest {
    private fun receipt(id: String = "receipt") =
        AccountDeletionReceipt(id, "accepted", "2026-09-26T00:00:00.000Z")

    @Test fun ambiguousRequestSurvivesRestartWithoutAuthorizingPurge() {
        val root = kotlin.io.path.createTempDirectory("deletion-").toFile()
        val journal = AccountDeletionJournal(File(root, "pending"))
        journal.requested("owner")
        val reopened = AccountDeletionJournal(File(root, "pending"))
        assertEquals("owner", reopened.pending()?.uid)
        assertFalse(reopened.pending()!!.accepted)
        reopened.accepted("owner", receipt())
        assertTrue(reopened.pending()!!.accepted)
        reopened.completed("foreign")
        assertNotNull(reopened.pending())
        reopened.completed("owner")
        assertNull(reopened.pending())
    }

    @Test fun differentAccountRequestDoesNotLoseAnEarlierRecoveryRecord() {
        val root = kotlin.io.path.createTempDirectory("deletion-multiple-").toFile()
        val journal = AccountDeletionJournal(File(root, "pending"))
        journal.requested("first")
        journal.requested("second")
        journal.accepted("second", receipt("second-request"))
        journal.completed("second")
        assertEquals(listOf(PendingAccountDeletion("first", false)), journal.all())
    }

    @Test fun acceptedRecoveryForAOnlySignsOutAAndPreservesCurrentB() = runTest {
        val purged = mutableListOf<String>()
        var current: String? = "B"
        recoverAccountPrivateData(listOf(PendingAccountDeletion("A", true)), { current }, { current = null }, { purged += it })
        assertEquals("B", current)
        assertEquals(listOf("A"), purged)
        current = "A"
        recoverAccountPrivateData(listOf(PendingAccountDeletion("A", true)), { current }, { current = null }, { purged += it })
        assertNull(current)
    }

    @Test fun invalidationRequiresDurablePrivatePurgeButNetworkErrorsDoNot() {
        assertTrue(requiresPrivateAccountPurge(AuthProblem.UNAUTHENTICATED))
        assertTrue(requiresPrivateAccountPurge(AuthProblem.ACCOUNT_DISABLED))
        assertFalse(requiresPrivateAccountPurge(AuthProblem.OFFLINE))
        assertFalse(requiresPrivateAccountPurge(AuthProblem.SERVICE_UNAVAILABLE))
        assertFalse(requiresPrivateAccountPurge(AuthProblem.REAUTH_REQUIRED))
        val root = kotlin.io.path.createTempDirectory("invalidated-").toFile()
        val journal = AccountDeletionJournal(File(root, "pending"))
        journal.invalidated("A")
        val record = AccountDeletionJournal(File(root, "pending")).pending()!!
        assertTrue(record.requiresPurge)
        assertFalse(record.accepted)
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test fun capturedOwnerReceiptPersistsEvenIfCallerCancelsAndIdentityChanges() = runTest {
        val root = kotlin.io.path.createTempDirectory("deletion-race-").toFile()
        val journal = AccountDeletionJournal(File(root, "pending"))
        val response = CompletableDeferred<Unit>()
        var identity = "A"
        val api = AuthApiClient(AuthConfiguration("https://api.example.test", false), { identity }, { "token-A" },
            AuthHttpTransport { _, method, headers, body ->
                assertEquals("DELETE", method)
                assertEquals("Bearer token-A", headers["Authorization"])
                assertNull(body)
                response.await()
                AuthHttpResponse(202, """{"request_id":"receipt-A","status":"accepted","recover_until":"2026-09-26T00:00:00.000Z"}""")
            })
        val action = launch {
            requestAccountDeletionDurably("A", journal::requested, journal::accepted, journal::rejected, api::deleteAccount)
        }
        runCurrent()
        action.cancel()
        identity = "B"
        response.complete(Unit)
        action.join()
        assertEquals("B", identity)
        assertEquals(
            PendingAccountDeletion(
                "A",
                true,
                requestId = "receipt-A",
                recoverUntil = "2026-09-26T00:00:00.000Z",
            ),
            journal.pending(),
        )
    }

    @Test fun definitiveRejectionClearsOnlyThatRequestAndPermitsRetry() = runTest {
        val root = kotlin.io.path.createTempDirectory("deletion-rejected-").toFile()
        val journal = AccountDeletionJournal(File(root, "pending"))
        journal.requested("B")
        for (status in listOf(400, 429)) {
            runCatching {
                requestAccountDeletionDurably("A", journal::requested, journal::accepted, journal::rejected) {
                    throw AuthFailure(AuthProblem.RATE_LIMITED, httpStatus = status)
                }
            }
            assertEquals(listOf(PendingAccountDeletion("B", false)), journal.all())
        }
        runCatching {
            requestAccountDeletionDurably("A", journal::requested, journal::accepted, journal::rejected) {
                throw AuthFailure(AuthProblem.OFFLINE)
            }
        }
        assertTrue(journal.all().any { it.uid == "A" && !it.accepted })
    }

    @Test fun laterRateLimitCannotDisproveAnEarlierUnconfirmedRequest() = runTest {
        val root = kotlin.io.path.createTempDirectory("deletion-uncertain-retry-").toFile()
        val journal = AccountDeletionJournal(File(root, "pending"))
        runCatching {
            requestAccountDeletionDurably("A", journal::requested, journal::accepted, journal::rejected) {
                throw AuthFailure(AuthProblem.OFFLINE)
            }
        }
        runCatching {
            requestAccountDeletionDurably("A", journal::requested, journal::accepted, journal::rejected) {
                throw AuthFailure(AuthProblem.RATE_LIMITED, httpStatus = 429)
            }
        }
        assertEquals(PendingAccountDeletion("A", false), journal.pending())
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test fun tokenAcquisitionIsBoundedButAcceptancePersistenceSurvivesTheDeadline() = runTest {
        val root = kotlin.io.path.createTempDirectory("deletion-deadline-").toFile()
        val journal = AccountDeletionJournal(File(root, "pending"))
        val never = CompletableDeferred<String>()
        val api = AuthApiClient(AuthConfiguration("https://api.example.test", false), { "A" }, { never.await() },
            AuthHttpTransport { _, _, _, _ -> error("No token was obtained") })
        val started = testScheduler.currentTime
        val failure = runCatching {
            requestAccountDeletionDurably("A", journal::requested, journal::accepted, journal::rejected, api::deleteAccount)
        }.exceptionOrNull() as AuthFailure
        assertEquals(AuthProblem.OFFLINE, failure.problem)
        assertEquals(20_000L, testScheduler.currentTime - started)
        assertEquals(PendingAccountDeletion("A", false), journal.pending())
        requestAccountDeletionDurably("A", journal::requested, { uid, accepted ->
            kotlinx.coroutines.delay(21_000)
            journal.accepted(uid, accepted)
        }, journal::rejected) {
            AccountDeletionReceipt("accepted", "accepted", "2026-09-26T00:00:00.000Z")
        }
        assertTrue(journal.pending()!!.accepted)
    }

    @Test fun purgeKeepsForeignAccountAndUserExport() {
        val root = kotlin.io.path.createTempDirectory("deletion-files-").toFile()
        val owned = com.hatem.musicmute.processing.processingOwnerDirectory(root, "owner").apply { mkdirs() }
        val foreign = com.hatem.musicmute.processing.processingOwnerDirectory(root, "foreign").apply { mkdirs() }
        File(owned, "input.mp3").writeText("audio")
        val foreignFile = File(foreign, "input.mp3").apply { writeText("other") }
        val exported = File(root.parentFile, root.name + "-export.mp3").apply { writeText("export") }
        purgePrivateOwnerDirectory(root, "owner")
        assertFalse(owned.exists())
        assertEquals("other", foreignFile.readText())
        assertEquals("export", exported.readText())
    }
}
