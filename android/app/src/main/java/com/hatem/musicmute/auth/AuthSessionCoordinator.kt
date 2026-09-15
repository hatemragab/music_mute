package com.hatem.musicmute.auth

import android.os.SystemClock
import com.google.firebase.auth.AuthCredential
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withTimeoutOrNull

enum class AuthPhase {
    RESTORING,
    SIGNED_OUT,
    BOOTSTRAP_REQUIRED,
    RECOVERY_REQUIRED,
    AUTHENTICATED,
}

enum class AuthNotice {
    VERIFICATION_SENT,
    ALREADY_VERIFIED,
    PASSWORD_RESET_SENT,
    METHOD_LINKED,
    METHOD_UNLINKED,
    PROFILE_UPDATED,
    DELETION_ACCEPTED,
}

data class AuthUiState(
    val phase: AuthPhase = AuthPhase.RESTORING,
    val identity: IdentitySnapshot? = null,
    val profile: AccountProfile? = null,
    val policy: AppPolicy? = null,
    val access: ProcessingAccess? = null,
    val installationId: String? = null,
    val currentDevice: RegisteredDevice? = null,
    val busy: Boolean = false,
    val offline: Boolean = false,
    val profileSyncPending: Boolean = false,
    val failure: AuthFailure? = null,
    val notice: AuthNotice? = null,
    val verificationCooldownUntil: Long = 0,
    val resetCooldownUntil: Long = 0,
    val resetEmail: String? = null,
    val devices: List<RegisteredDevice> = emptyList(),
    val devicesLoaded: Boolean = false,
    val deletionUnconfirmed: Boolean = false,
    val accountRecovery: AccountRecoveryStatus? = null,
    val nextDeviceCursor: String? = null,
    val pendingProfileName: PendingProfileName? = null,
)

/** Owns auth state only. A generation prevents callbacks from resurrecting a logged-out account. */
class AuthSessionCoordinator(
    private val identity: FirebaseAuthGateway,
    private val api: AuthApiClient,
    private val installations: InstallationStore,
    private val google: GoogleCredentialProvider,
    private val sessionInvalidated: (String) -> Unit = {},
    private val deletionRejected: suspend (String) -> Unit = {},
    private val deletionRequested: suspend (String) -> Boolean = { false },
    private val afterSignOut: suspend () -> Unit = {},
    private val hasUnconfirmedDeletion: () -> Boolean = { false },
    private val deletionAccepted: suspend (String) -> Unit = {},
    private val beforeSignOut: suspend (uid: String, installationId: String?) -> Unit = { _, _ -> },
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mutableState = MutableStateFlow(AuthUiState())
    val state: StateFlow<AuthUiState> = mutableState.asStateFlow()
    private val actionLock = Mutex()
    private var generation = 0L
    private var trackedUid: String? = identity.identity()?.uid
    private var activeAction: Job? = null
    private var cleanup: Deferred<Unit>? = null
    private var signingOut = false
    private var lastForegroundCheck = 0L
    private var deletionReauthenticated: Pair<Long, Long>? = null
    private var lastReported: InstallationReport? = null

    init {
        identity.observe { current ->
            val ui = mutableState.value
            if (current == null && trackedUid != null) signOut(AuthFailure(AuthProblem.UNAUTHENTICATED))
            else if (current != null && !ui.busy && !signingOut && ui.phase == AuthPhase.SIGNED_OUT)
                identity.signOut()
            else if (current != null && trackedUid != null && current.uid != trackedUid) signOut()
        }
        scope.launch { restore() }
    }

    fun configured() = api.configuration.isConfigured()

    fun dismissMessage() {
        mutableState.value = mutableState.value.copy(failure = null, notice = null)
    }

    suspend fun restore() = action { ticket ->
        mutableState.value = mutableState.value.copy(deletionUnconfirmed = hasUnconfirmedDeletion())
        val user = identity.identity()
        if (user == null) {
            trackedUid = null
            mutableState.value = AuthUiState(phase = AuthPhase.SIGNED_OUT, busy = true, deletionUnconfirmed = hasUnconfirmedDeletion())
            return@action
        }
        trackedUid = user.uid
        mutableState.value = mutableState.value.copy(pendingProfileName = installations.pendingProfileName(user.uid))
        val cached = installations.bootstrap()?.takeIf { it.uid == user.uid }
        try {
            bootstrap(ticket)
        } catch (failure: AuthFailure) {
            checkTicket(ticket)
            if (
                cached != null &&
                    identity.identity()?.uid == cached.uid &&
                    failure.problem == AuthProblem.OFFLINE
            ) {
                mutableState.value =
                    mutableState.value.copy(
                        phase = AuthPhase.AUTHENTICATED,
                        identity = user,
                        profile = cached.profile,
                        installationId = installations.report().installationId,
                        offline = true,
                        failure = null,
                    )
            } else throw failure
        }
    }

    suspend fun signInEmail(email: String, password: String, register: Boolean = false, fullName: String? = null) =
        action { ticket ->
            api.configuration.apiRoot()
            val address = email.trim()
            if (!validAuthEmail(address) || password.isEmpty())
                throw AuthFailure(AuthProblem.INVALID_INPUT)
            val name = if (register) validatedFullName(fullName.orEmpty()) else null
            val signedIn =
                if (register) identity.register(address, password)
                else identity.signIn(address, password)
            checkTicket(ticket)
            trackedUid = signedIn.uid
            checkTicket(ticket)
            if (name != null) {
                val request = PendingProfileName(signedIn.uid, name)
                mutableState.value = mutableState.value.copy(pendingProfileName = request)
                applyProfileName(ticket, request)
            }
            bootstrap(ticket)
        }

    suspend fun retryProfileName() = action { ticket ->
        val pending = mutableState.value.pendingProfileName ?: return@action
        if (identity.identity()?.uid != pending.uid) throw AuthFailure(AuthProblem.ACCOUNT_MISMATCH)
        if (applyProfileName(ticket, pending)) syncProfile(ticket)
    }

    private suspend fun applyProfileName(ticket: Long, request: PendingProfileName): Boolean {
        val complete = completeProfileNameUpdate(request,
            persist = { checkTicket(ticket); installations.savePendingProfileName(it); checkTicket(ticket) },
            apply = { identity.updateDisplayName(it.uid, it.fullName); checkTicket(ticket) },
            clear = { checkTicket(ticket); installations.clearPendingProfileName(it); checkTicket(ticket) },
        )
        checkTicket(ticket)
        mutableState.value = mutableState.value.copy(
            identity = identity.identity(),
            pendingProfileName = if (complete) null else request,
        )
        return complete
    }

    suspend fun signInSocial(credential: suspend () -> AuthCredential) = action { ticket ->
        api.configuration.apiRoot()
        val selected = credential()
        checkTicket(ticket)
        val signedIn = identity.signIn(selected)
        checkTicket(ticket)
        trackedUid = signedIn.uid
        checkTicket(ticket)
        bootstrap(ticket)
    }

    suspend fun retryBootstrap() = action { bootstrap(it) }

    suspend fun requestAccountRecovery(reason: String?) = action { ticket ->
        if (mutableState.value.phase != AuthPhase.RECOVERY_REQUIRED) return@action
        val request = api.requestAccountRecovery(reason)
        checkTicket(ticket)
        mutableState.value =
            mutableState.value.copy(
                accountRecovery = mutableState.value.accountRecovery?.copy(request = request),
                failure = null,
            )
    }

    suspend fun refreshAccountRecovery() = action { ticket ->
        if (mutableState.value.phase != AuthPhase.RECOVERY_REQUIRED) return@action
        val recovery = api.accountRecovery()
        checkTicket(ticket)
        if (recovery.accountStatus == "active" || recovery.request?.status == "approved") {
            bootstrap(ticket)
        } else {
            mutableState.value =
                mutableState.value.copy(accountRecovery = recovery, failure = null, offline = false)
        }
    }

    suspend fun foreground() {
        val now = SystemClock.elapsedRealtime()
        if (
            mutableState.value.phase != AuthPhase.AUTHENTICATED ||
                now - lastForegroundCheck < 60_000 ||
                mutableState.value.busy
        )
            return
        lastForegroundCheck = now
        action { ticket ->
            val fresh = identity.reload()
            checkTicket(ticket)
            var profile = safeProfile(ticket)
            if (
                fresh.emailVerified != profile.emailVerified ||
                    fresh.providers != profile.providers.toSet() ||
                    mutableState.value.profileSyncPending
            ) {
                val sync = api.profileSync()
                checkTicket(ticket)
                profile = sync.user
                mutableState.value =
                    mutableState.value.copy(policy = sync.policy, profileSyncPending = false)
            }
            val report = installations.report()
            if (lastReported != report) {
                lastReported = reportInstallation(ticket, report)
            }
            installations.saveBootstrap(fresh.uid, profile)
            checkTicket(ticket)
            mutableState.value =
                mutableState.value.copy(
                    identity = fresh,
                    profile = profile,
                    access = null,
                    offline = false,
                )
        }
    }

    suspend fun refreshAccount() = action { ticket ->
        identity.reload()
        identity.token(true)
        checkTicket(ticket)
        syncProfile(ticket)
        bootstrap(ticket)
        mutableState.value = mutableState.value.copy(notice = AuthNotice.PROFILE_UPDATED)
    }

    suspend fun requestVerification() = action { ticket ->
        if (SystemClock.elapsedRealtime() < mutableState.value.verificationCooldownUntil)
            throw AuthFailure(AuthProblem.RATE_LIMITED)
        try {
            val result = api.requestVerification()
            checkTicket(ticket)
            if (result.status == "already_verified") {
                identity.reload()
                identity.token(true)
                syncProfile(ticket)
                mutableState.value = mutableState.value.copy(notice = AuthNotice.ALREADY_VERIFIED)
            } else if (result.status == "accepted") {
                mutableState.value =
                    mutableState.value.copy(
                        verificationCooldownUntil = SystemClock.elapsedRealtime() + 60_000,
                        notice = AuthNotice.VERIFICATION_SENT,
                    )
            } else throw AuthFailure(AuthProblem.SERVICE_UNAVAILABLE)
        } catch (failure: AuthFailure) {
            checkTicket(ticket)
            if (failure.problem == AuthProblem.RATE_LIMITED)
                mutableState.value =
                    mutableState.value.copy(
                        verificationCooldownUntil =
                            SystemClock.elapsedRealtime() + (failure.retryAfterSeconds ?: 60) * 1000
                    )
            throw failure
        }
    }

    suspend fun requestPasswordReset(email: String) = action { ticket ->
        val address = email.trim()
        if (!validAuthEmail(address)) throw AuthFailure(AuthProblem.INVALID_INPUT)
        if (
            mutableState.value.resetEmail == address &&
                SystemClock.elapsedRealtime() < mutableState.value.resetCooldownUntil
        )
            throw AuthFailure(AuthProblem.RATE_LIMITED)
        try {
            val result = api.requestPasswordReset(address)
            checkTicket(ticket)
            if (result.status != "accepted") throw AuthFailure(AuthProblem.SERVICE_UNAVAILABLE)
            mutableState.value =
                mutableState.value.copy(
                    resetEmail = address,
                    resetCooldownUntil = SystemClock.elapsedRealtime() + 60_000,
                    notice = AuthNotice.PASSWORD_RESET_SENT,
                )
        } catch (failure: AuthFailure) {
            checkTicket(ticket)
            if (failure.problem == AuthProblem.RATE_LIMITED)
                mutableState.value =
                    mutableState.value.copy(
                        resetEmail = address,
                        resetCooldownUntil =
                            SystemClock.elapsedRealtime() +
                                (failure.retryAfterSeconds ?: 60) * 1000,
                    )
            throw failure
        }
    }

    suspend fun linkPassword(password: String, social: suspend () -> AuthCredential) =
        action { ticket ->
            val before = identity.reload()
            checkTicket(ticket)
            val email =
                before.email?.takeIf(::validAuthEmail)
                    ?: throw AuthFailure(AuthProblem.EMAIL_UNAVAILABLE)
            if (PASSWORD_PROVIDER in before.providers)
                throw AuthFailure(AuthProblem.CREDENTIAL_IN_USE)
            if (password.isEmpty()) throw AuthFailure(AuthProblem.INVALID_INPUT)
            reauthenticate(ticket, before, null, social)
            identity.link(identity.passwordCredential(email, password))
            checkTicket(ticket)
            mutableState.value =
                mutableState.value.copy(
                    identity = identity.identity(),
                    profileSyncPending = true,
                    notice = AuthNotice.METHOD_LINKED,
                )
            finishMutation(ticket)
        }

    suspend fun linkGoogle(password: String, social: suspend () -> AuthCredential) =
        action { ticket ->
            val before = identity.reload()
            checkTicket(ticket)
            if (GOOGLE_PROVIDER in before.providers)
                throw AuthFailure(AuthProblem.CREDENTIAL_IN_USE)
            reauthenticate(ticket, before, password, social)
            val credential = social()
            checkTicket(ticket)
            identity.link(credential)
            checkTicket(ticket)
            mutableState.value =
                mutableState.value.copy(
                    identity = identity.identity(),
                    profileSyncPending = true,
                    notice = AuthNotice.METHOD_LINKED,
                )
            finishMutation(ticket)
        }

    suspend fun unlink(provider: String, password: String, social: suspend () -> AuthCredential) =
        action { ticket ->
            val before = identity.reload()
            checkTicket(ticket)
            if (
                provider !in setOf(PASSWORD_PROVIDER, GOOGLE_PROVIDER) ||
                    !canUnlink(before.providers, provider)
            )
                throw AuthFailure(AuthProblem.LAST_METHOD)
            reauthenticate(
                ticket,
                before.copy(providers = before.providers - provider),
                password,
                social,
            )
            val current = identity.reload()
            checkTicket(ticket)
            if (!canUnlink(current.providers, provider)) throw AuthFailure(AuthProblem.LAST_METHOD)
            identity.unlink(provider)
            checkTicket(ticket)
            mutableState.value =
                mutableState.value.copy(
                    identity = identity.identity(),
                    profileSyncPending = true,
                    notice = AuthNotice.METHOD_UNLINKED,
                )
            finishMutation(ticket)
        }

    suspend fun loadDevices(more: Boolean = false) = action { ticket ->
        val cursor = if (more) mutableState.value.nextDeviceCursor ?: return@action else null
        val page = safeDevices(ticket, cursor)
        checkTicket(ticket)
        val current = mutableState.value.currentDevice
        val items = if (more) mutableState.value.devices + page.items else page.items + listOfNotNull(current)
        mutableState.value =
            mutableState.value.copy(
                devices = items.distinctBy { it.installationId },
                devicesLoaded = true,
                nextDeviceCursor = page.nextCursor?.takeIf { it != cursor },
                offline = false,
            )
    }

    suspend fun removeDeviceHistory(installationId: String) = action { ticket ->
        if (installationId == mutableState.value.installationId)
            throw AuthFailure(AuthProblem.INVALID_INPUT)
        api.removeDeviceHistory(installationId)
        checkTicket(ticket)
        mutableState.value = mutableState.value.copy(
            devices = mutableState.value.devices.filterNot { it.installationId == installationId },
        )
    }

    suspend fun prepareAccountDeletion(password: String, social: suspend () -> AuthCredential, onReady: () -> Unit) = action { ticket ->
        deletionReauthenticated = null
        val user = identity.reload()
        checkTicket(ticket)
        reauthenticate(ticket, user, password, social)
        identity.token(true)
        checkTicket(ticket)
        deletionReauthenticated = ticket to SystemClock.elapsedRealtime()
        onReady()
    }

    suspend fun deleteAccount() = action { ticket ->
        val proof = deletionReauthenticated
        if (proof == null || proof.first != ticket || SystemClock.elapsedRealtime() - proof.second > 300_000)
            throw AuthFailure(AuthProblem.REAUTH_REQUIRED)
        val uid = identity.identity()?.uid ?: throw AuthFailure(AuthProblem.UNAUTHENTICATED)
        try {
            requestAccountDeletionDurably(uid, deletionRequested, deletionAccepted, deletionRejected) { owner ->
                if (generation == ticket) mutableState.value = mutableState.value.copy(deletionUnconfirmed = true)
                api.deleteAccount(owner)
            }
        } finally {
            if (generation == ticket) mutableState.value = mutableState.value.copy(deletionUnconfirmed = hasUnconfirmedDeletion())
        }
        // The receipt is already durable. Only this exact UI session may transition to signed out.
        if (generation == ticket && identity.identity()?.uid == uid) signOut(deletion = true, expectedUid = uid)
    }

    fun signOut(failure: AuthFailure? = null, deletion: Boolean = false, expectedUid: String? = null) {
        if (expectedUid != null && identity.identity()?.uid != expectedUid) return
        if (signingOut) return
        signingOut = true
        val oldUid = mutableState.value.identity?.uid ?: trackedUid ?: identity.identity()?.uid
        val oldInstallation = mutableState.value.installationId ?: lastReported?.installationId
        if (oldUid != null && requiresPrivateAccountPurge(failure?.problem)) {
            try { sessionInvalidated(oldUid) } catch (_: Exception) { /* The application also attempts immediate owner cleanup. */ }
        }
        generation++
        deletionReauthenticated = null
        activeAction?.cancel()
        trackedUid = null
        lastReported = null
        // Cloud UI disappears immediately. New auth actions already await cleanup below.
        mutableState.value = AuthUiState(phase = AuthPhase.SIGNED_OUT, failure = failure, notice = if (deletion) AuthNotice.DELETION_ACCEPTED else null, deletionUnconfirmed = hasUnconfirmedDeletion())
        cleanup = scope.async(start = CoroutineStart.LAZY) {
            try {
                runBeforeLocalSignOut(
                    before = { if (oldUid != null) beforeSignOut(oldUid, oldInstallation) },
                    clearIdentity = {
                        if (identity.identity()?.uid == oldUid) identity.signOut()
                    },
                )
            } finally { signingOut = false }
            try { afterSignOut() } catch (_: Exception) { /* Durable receipt retries local cleanup on next launch. */ }
            try {
                installations.clearBootstrap()
            } catch (_: AuthFailure) {
                /* No SDK identity can use a stale record after sign-out. */
            }
            google.clearSession()
        }
        cleanup?.start()
    }

    suspend fun logoutAll() = action { ticket ->
        try {
            api.logoutAll()
            checkTicket(ticket)
            signOut()
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            checkTicket(ticket)
            signOut(AuthFailure(AuthProblem.GLOBAL_LOGOUT_UNCONFIRMED))
        }
    }

    private suspend fun bootstrap(ticket: Long) {
        val user = identity.identity() ?: throw AuthFailure(AuthProblem.UNAUTHENTICATED)
        trackedUid = user.uid
        val phase =
            if (
                mutableState.value.phase == AuthPhase.AUTHENTICATED &&
                    mutableState.value.identity?.uid == user.uid
            )
                AuthPhase.AUTHENTICATED
            else AuthPhase.BOOTSTRAP_REQUIRED
        mutableState.value = mutableState.value.copy(phase = phase, identity = user)
        var report = installations.report()
        checkTicket(ticket)
        val response =
            try {
                api.bootstrap(report)
            } catch (failure: AuthFailure) {
                if (failure.problem == AuthProblem.ACCOUNT_DELETION_PENDING) {
                    showAccountRecovery(ticket)
                    return
                }
                if (failure.problem != AuthProblem.DEVICE_CONFLICT) throw failure
                report = reconcileInstallation(ticket, report, failure)
                api.bootstrap(report)
            }
        checkTicket(ticket)
        installations.saveBootstrap(user.uid, response.user)
        checkTicket(ticket)
        lastReported = report
        lastForegroundCheck = SystemClock.elapsedRealtime()
        mutableState.value =
            mutableState.value.copy(
                phase = AuthPhase.AUTHENTICATED,
                identity = identity.identity(),
                profile = response.user,
                policy = response.policy,
                access = response.access,
                currentDevice = response.device,
                installationId = report.installationId,
                failure = null,
                notice = null,
                offline = false,
                profileSyncPending = false,
                accountRecovery = null,
            )
    }

    private suspend fun showAccountRecovery(ticket: Long) {
        val recovery = api.accountRecovery()
        checkTicket(ticket)
        mutableState.value =
            mutableState.value.copy(
                phase = AuthPhase.RECOVERY_REQUIRED,
                identity = identity.identity(),
                profile = null,
                policy = null,
                access = null,
                accountRecovery = recovery,
                failure = null,
                offline = false,
                profileSyncPending = false,
            )
    }

    private suspend fun safeProfile(ticket: Long): AccountProfile =
        try {
            api.me()
        } catch (failure: AuthFailure) {
            if (failure.problem != AuthProblem.PROFILE_SYNC_REQUIRED) throw failure
            bootstrap(ticket)
            mutableState.value.profile ?: throw AuthFailure(AuthProblem.SERVICE_UNAVAILABLE)
        }

    private suspend fun safeDevices(ticket: Long, cursor: String?): DevicePage =
        try {
            api.devices(cursor)
        } catch (failure: AuthFailure) {
            if (failure.problem != AuthProblem.PROFILE_SYNC_REQUIRED) throw failure
            bootstrap(ticket)
            checkTicket(ticket)
            api.devices(cursor)
        }

    private suspend fun reportInstallation(
        ticket: Long,
        report: InstallationReport,
    ): InstallationReport =
        try {
            api.reportInstallation(report)
            checkTicket(ticket)
            report
        } catch (failure: AuthFailure) {
            if (failure.problem != AuthProblem.DEVICE_CONFLICT) throw failure
            val reconciled = reconcileInstallation(ticket, report, failure)
            api.reportInstallation(reconciled)
            checkTicket(ticket)
            reconciled
        }

    private suspend fun reconcileInstallation(
        ticket: Long,
        report: InstallationReport,
        conflict: AuthFailure,
    ): InstallationReport {
        var cursor: String? = null
        var found: RegisteredDevice? = null
        for (pageIndex in 0 until 10) {
            val page = api.devices(cursor)
            checkTicket(ticket)
            found = page.items.firstOrNull { it.installationId == report.installationId }
            if (found != null || page.nextCursor == null || cursor == page.nextCursor) break
            cursor = page.nextCursor
        }
        val reconciled = installations.reconcile(found ?: throw conflict)
        checkTicket(ticket)
        return reconciled
    }

    private suspend fun reauthenticate(
        ticket: Long,
        user: IdentitySnapshot,
        password: String?,
        social: suspend () -> AuthCredential,
    ) {
        val credential =
            if (PASSWORD_PROVIDER in user.providers && !password.isNullOrEmpty()) {
                identity.passwordCredential(
                    user.email ?: throw AuthFailure(AuthProblem.EMAIL_UNAVAILABLE),
                    password,
                )
            } else if (GOOGLE_PROVIDER in user.providers) social()
            else throw AuthFailure(AuthProblem.REAUTH_REQUIRED)
        checkTicket(ticket)
        identity.reauthenticate(credential)
        checkTicket(ticket)
        if (identity.identity()?.uid != user.uid) throw AuthFailure(AuthProblem.ACCOUNT_MISMATCH)
    }

    private suspend fun finishMutation(ticket: Long) {
        identity.reload()
        identity.token(true)
        checkTicket(ticket)
        syncProfile(ticket)
    }

    private suspend fun syncProfile(ticket: Long) {
        val synced =
            try {
                api.profileSync()
            } catch (failure: AuthFailure) {
                if (failure.problem != AuthProblem.PROFILE_SYNC_REQUIRED) throw failure
                bootstrap(ticket)
                api.profileSync()
            }
        checkTicket(ticket)
        val user = identity.identity() ?: throw AuthFailure(AuthProblem.UNAUTHENTICATED)
        installations.saveBootstrap(user.uid, synced.user)
        checkTicket(ticket)
        mutableState.value =
            mutableState.value.copy(
                identity = user,
                profile = synced.user,
                policy = synced.policy,
                access = null,
                offline = false,
                profileSyncPending = false,
            )
    }

    private suspend fun action(operation: suspend (Long) -> Unit) {
        if (!actionLock.tryLock()) return
        val ticket = generation
        activeAction = currentCoroutineContext()[Job]
        try {
            cleanup?.await()
            checkTicket(ticket)
            mutableState.value = mutableState.value.copy(busy = true, failure = null, notice = null)
            operation(ticket)
        } catch (error: CancellationException) {
            throw error
        } catch (failure: AuthFailure) {
            if (ticket == generation) {
                if (
                    failure.problem in
                        setOf(AuthProblem.UNAUTHENTICATED, AuthProblem.ACCOUNT_DISABLED)
                )
                    signOut(failure)
                else if (failure.problem != AuthProblem.CANCELLED)
                    mutableState.value =
                        mutableState.value.copy(
                            failure = failure,
                            offline =
                                mutableState.value.offline ||
                                    failure.problem == AuthProblem.OFFLINE,
                        )
            }
        } catch (_: Exception) {
            if (ticket == generation)
                mutableState.value =
                    mutableState.value.copy(failure = AuthFailure(AuthProblem.SERVICE_UNAVAILABLE))
        } finally {
            if (ticket == generation) {
                val current = mutableState.value
                mutableState.value =
                    current.copy(
                        busy = false,
                        phase =
                            if (current.phase == AuthPhase.RESTORING) AuthPhase.BOOTSTRAP_REQUIRED
                            else current.phase,
                    )
            }
            activeAction = null
            actionLock.unlock()
        }
    }

    private suspend fun checkTicket(ticket: Long) {
        currentCoroutineContext().ensureActive()
        if (generation != ticket) throw CancellationException("Auth session changed")
        val expectedUid = trackedUid
        if (expectedUid != null && identity.identity()?.uid != expectedUid) {
            signOut()
            throw CancellationException("Auth session changed")
        }
    }
}

/** Retain old credentials only for bounded, conditional push cleanup; never delay signed-out UI. */
internal suspend fun runBeforeLocalSignOut(before: suspend () -> Unit, clearIdentity: () -> Unit) {
    try {
        withTimeoutOrNull(2_000) { before() }
    } catch (error: CancellationException) {
        throw error
    } catch (_: Exception) {
        // Offline push cleanup cannot prevent local logout.
    } finally {
        clearIdentity()
    }
}
