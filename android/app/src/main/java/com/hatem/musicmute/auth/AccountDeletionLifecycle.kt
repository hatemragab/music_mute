package com.hatem.musicmute.auth

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withContext

/** An acknowledged request belongs to its captured owner even after the caller leaves that session. */
internal suspend fun requestAccountDeletionDurably(
    ownerUid: String,
    requested: suspend (String) -> Boolean,
    accepted: suspend (String) -> Unit,
    rejected: suspend (String) -> Unit,
    request: suspend (String) -> AccountDeletionReceipt,
): AccountDeletionReceipt = withContext(NonCancellable) {
    val firstAttempt = requested(ownerUid)
    try {
        val receipt = try {
            withTimeout(20_000) { request(ownerUid) }
        } catch (_: TimeoutCancellationException) {
            throw AuthFailure(AuthProblem.OFFLINE)
        }
        // Once received, persist acceptance even if the caller left or the request deadline elapsed.
        accepted(ownerUid)
        receipt
    } catch (failure: AuthFailure) {
        // HTTP timeouts and server/network failures can hide a committed mutation.
        if (firstAttempt && failure.httpStatus?.let { it in 400..499 && it != 408 } == true) rejected(ownerUid)
        throw failure
    }
}

internal fun requiresPrivateAccountPurge(problem: AuthProblem?): Boolean =
    problem == AuthProblem.UNAUTHENTICATED || problem == AuthProblem.ACCOUNT_DISABLED

/** Recovery never signs out a different account or removes its private data. */
internal suspend fun recoverAccountPrivateData(
    records: List<PendingAccountDeletion>,
    currentUid: () -> String?,
    signOut: () -> Unit,
    purge: suspend (String) -> Unit,
) {
    records.filter { it.requiresPurge }.forEach { record ->
        if (currentUid() == record.uid) signOut()
        try { purge(record.uid) }
        catch (error: CancellationException) { throw error }
        catch (_: Exception) { /* Durable recovery record remains for another attempt. */ }
    }
}
