package com.hatem.musicmute.auth

import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseNetworkException
import com.google.firebase.FirebaseTooManyRequestsException
import com.google.firebase.auth.AuthCredential
import com.google.firebase.auth.EmailAuthProvider
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthException
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.auth.UserProfileChangeRequest
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class FirebaseAuthGateway(val firebase: FirebaseAuth) {
    private val mutationScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val identityMutations =
        IdentityMutationGate<IdentitySnapshot>(
            scope = mutationScope,
            discard = { identity ->
                if (firebase.currentUser?.uid == identity.uid) firebase.signOut()
            },
        )

    fun identity(): IdentitySnapshot? = firebase.currentUser?.snapshot()

    fun observe(listener: (IdentitySnapshot?) -> Unit): () -> Unit {
        val observer = FirebaseAuth.AuthStateListener { listener(it.currentUser?.snapshot()) }
        firebase.addAuthStateListener(observer)
        return { firebase.removeAuthStateListener(observer) }
    }

    suspend fun signIn(email: String, password: String): IdentitySnapshot = translated {
        identityMutations.run {
            firebase.signInWithEmailAndPassword(email, password).awaitResult()
            requireIdentity()
        }
    }

    suspend fun register(email: String, password: String): IdentitySnapshot = translated {
        identityMutations.run {
            firebase.createUserWithEmailAndPassword(email, password).awaitResult()
            requireIdentity()
        }
    }

    suspend fun signIn(credential: AuthCredential): IdentitySnapshot = translated {
        identityMutations.run {
            firebase.signInWithCredential(credential).awaitResult()
            requireIdentity()
        }
    }

    suspend fun reload(): IdentitySnapshot = translated {
        val user = requireUser()
        user.reload().awaitResult()
        checkSameUser(user.uid)
        requireIdentity()
    }

    suspend fun updateDisplayName(uid: String, fullName: String): IdentitySnapshot = translated {
        checkSameUser(uid)
        val user = requireUser()
        user.updateProfile(UserProfileChangeRequest.Builder()
            .setDisplayName(validatedFullName(fullName)).build()).awaitResult()
        checkSameUser(uid)
        requireIdentity()
    }

    suspend fun token(forceRefresh: Boolean = false): String = translated {
        val user = requireUser()
        val result = user.getIdToken(forceRefresh).awaitResult()
        checkSameUser(user.uid)
        result.token?.takeIf { it.isNotBlank() } ?: throw AuthFailure(AuthProblem.UNAUTHENTICATED)
    }

    suspend fun reauthenticate(credential: AuthCredential) = translated {
        val user = requireUser()
        val result = user.reauthenticateAndRetrieveData(credential).awaitResult()
        checkSameUser(user.uid)
        if (result.user?.uid != user.uid) throw AuthFailure(AuthProblem.ACCOUNT_MISMATCH)
    }

    suspend fun link(credential: AuthCredential) = translated {
        val user = requireUser()
        val result = user.linkWithCredential(credential).awaitResult()
        checkSameUser(user.uid)
        if (result.user?.uid != user.uid) throw AuthFailure(AuthProblem.ACCOUNT_MISMATCH)
        requireIdentity()
    }

    suspend fun unlink(provider: String) = translated {
        val user = requireUser()
        user.unlink(provider).awaitResult()
        checkSameUser(user.uid)
        requireIdentity()
    }

    fun passwordCredential(email: String, password: String) =
        EmailAuthProvider.getCredential(email, password)

    fun signOut() {
        identityMutations.invalidate()
        firebase.signOut()
    }

    private fun requireUser() =
        firebase.currentUser ?: throw AuthFailure(AuthProblem.UNAUTHENTICATED)

    private fun requireIdentity() = identity() ?: throw AuthFailure(AuthProblem.UNAUTHENTICATED)

    private fun checkSameUser(uid: String) {
        if (identity()?.uid != uid) throw CancellationException("Auth session changed")
    }

    private fun FirebaseUser.snapshot() =
        IdentitySnapshot(
            uid,
            email,
            isEmailVerified,
            providerData.map { it.providerId }.filter { it != "firebase" }.toSet(),
            displayName,
        )

    private suspend fun <T> translated(operation: suspend () -> T): T =
        try {
            operation()
        } catch (error: CancellationException) {
            throw error
        } catch (error: AuthFailure) {
            throw error
        } catch (_: FirebaseNetworkException) {
            throw AuthFailure(AuthProblem.OFFLINE)
        } catch (_: FirebaseTooManyRequestsException) {
            throw AuthFailure(AuthProblem.RATE_LIMITED, 60)
        } catch (error: FirebaseAuthException) {
            throw AuthFailure(
                when (error.errorCode) {
                    "ERROR_EMAIL_ALREADY_IN_USE" -> AuthProblem.EMAIL_IN_USE
                    "ERROR_CREDENTIAL_ALREADY_IN_USE",
                    "ERROR_ACCOUNT_EXISTS_WITH_DIFFERENT_CREDENTIAL",
                    "ERROR_PROVIDER_ALREADY_LINKED" -> AuthProblem.CREDENTIAL_IN_USE
                    "ERROR_WEAK_PASSWORD" -> AuthProblem.WEAK_PASSWORD
                    "ERROR_REQUIRES_RECENT_LOGIN" -> AuthProblem.REAUTH_REQUIRED
                    "ERROR_USER_DISABLED" -> AuthProblem.ACCOUNT_DISABLED
                    "ERROR_USER_TOKEN_EXPIRED",
                    "ERROR_INVALID_USER_TOKEN",
                    "ERROR_USER_NOT_FOUND" -> AuthProblem.UNAUTHENTICATED
                    "ERROR_USER_MISMATCH" -> AuthProblem.ACCOUNT_MISMATCH
                    "ERROR_OPERATION_NOT_ALLOWED",
                    "ERROR_INVALID_API_KEY",
                    "ERROR_APP_NOT_AUTHORIZED" -> AuthProblem.CONFIGURATION
                    "ERROR_INVALID_EMAIL" -> AuthProblem.INVALID_INPUT
                    "ERROR_INVALID_CREDENTIAL",
                    "ERROR_WRONG_PASSWORD",
                    "ERROR_INVALID_LOGIN_CREDENTIALS" -> AuthProblem.INVALID_CREDENTIALS
                    else -> AuthProblem.SERVICE_UNAVAILABLE
                }
            )
        }
}

/** Keeps non-cancellable SDK identity mutations ordered and discards abandoned successes. */
internal class IdentityMutationGate<T>(
    private val scope: CoroutineScope,
    private val discard: (T) -> Unit,
) {
    private val lock = Mutex()
    private val epochLock = Any()
    private var epoch = 0L

    fun invalidate() {
        synchronized(epochLock) { epoch++ }
    }

    suspend fun run(operation: suspend () -> T): T {
        val requestEpoch = synchronized(epochLock) { epoch }
        val abandoned = AtomicBoolean(false)
        return suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation { abandoned.set(true) }
            scope.launch {
                try {
                    val value = lock.withLock {
                        if (abandoned.get() || synchronized(epochLock) { epoch != requestEpoch }) {
                            throw CancellationException("Auth attempt abandoned")
                        }
                        val result = operation()
                        if (abandoned.get() || synchronized(epochLock) { epoch != requestEpoch }) {
                            discard(result)
                            throw CancellationException("Auth attempt abandoned")
                        }
                        result
                    }
                    if (continuation.isActive) {
                        continuation.resume(value) { _, cancelledValue, _ ->
                            discard(cancelledValue)
                        }
                    } else {
                        discard(value)
                    }
                } catch (error: Throwable) {
                    if (continuation.isActive) continuation.resumeWithException(error)
                }
            }
        }
    }
}

private suspend fun <T> Task<T>.awaitResult(): T = suspendCancellableCoroutine { continuation ->
    addOnSuccessListener { if (continuation.isActive) continuation.resume(it) }
    addOnFailureListener { if (continuation.isActive) continuation.resumeWithException(it) }
    addOnCanceledListener { continuation.cancel() }
}
