package com.hatem.musicmute.auth

import kotlinx.serialization.Serializable

const val PASSWORD_PROVIDER = "password"
const val GOOGLE_PROVIDER = "google.com"
const val APPLE_PROVIDER = "apple.com"
const val MAX_METADATA_REVISION = 9_007_199_254_740_991L

data class IdentitySnapshot(
    val uid: String,
    val email: String?,
    val emailVerified: Boolean,
    val providers: Set<String>,
    val displayName: String? = null,
)

@Serializable
data class AccountProfile(
    val id: String,
    val displayName: String,
    val email: String? = null,
    val emailVerified: Boolean,
    val providers: List<String>,
)

@Serializable
data class InstallationMetadata(
    val platform: String = "android",
    val appVersion: String,
    val buildNumber: Int,
    val osVersion: String,
    val deviceModel: String? = null,
)

@Serializable
data class InstallationReport(
    val installationId: String,
    val platform: String = "android",
    val appVersion: String,
    val buildNumber: Int,
    val metadataRevision: Long,
    val osVersion: String,
    val deviceModel: String? = null,
) {
    fun metadata() = InstallationMetadata(platform, appVersion, buildNumber, osVersion, deviceModel)
}

@Serializable
data class VersionObservation(
    val appVersion: String,
    val buildNumber: Int,
    val metadataRevision: Long,
    val observedAt: String,
)

@Serializable
data class RegisteredDevice(
    val installationId: String,
    val platform: String,
    val appVersion: String,
    val buildNumber: Int,
    val metadataRevision: Long,
    val osVersion: String,
    val deviceModel: String? = null,
    val firstSeenAt: String,
    val lastSeenAt: String,
    val versionHistory: List<VersionObservation> = emptyList(),
    val sessionStatus: String = "unknown",
)

@Serializable
data class DevicePage(val items: List<RegisteredDevice>, val nextCursor: String? = null)

@Serializable
data class PlatformPolicy(
    val minimumBuild: Int? = null,
)

@Serializable data class PolicyPlatforms(val android: PlatformPolicy, val ios: PlatformPolicy)

@Serializable
data class AppPolicy(
    val requireVerifiedEmail: Boolean,
    val platforms: PolicyPlatforms,
    val revision: Long,
    val updatedAt: String,
)

@Serializable
data class ProcessingAccess(
    val allowed: Boolean,
    val reason: String? = null,
)

@Serializable
data class SessionResponse(
    val user: AccountProfile,
    val device: RegisteredDevice,
    val policy: AppPolicy,
    val access: ProcessingAccess,
)

@Serializable data class ProfileSyncResponse(val user: AccountProfile, val policy: AppPolicy)

@Serializable data class MailOutcome(val status: String)

enum class AuthProblem {
    INVALID_INPUT,
    INVALID_CREDENTIALS,
    EMAIL_IN_USE,
    CREDENTIAL_IN_USE,
    WEAK_PASSWORD,
    REAUTH_REQUIRED,
    ACCOUNT_MISMATCH,
    UNAUTHENTICATED,
    ACCOUNT_DISABLED,
    ACCOUNT_DELETION_PENDING,
    ACCOUNT_RECOVERY_EXPIRED,
    RATE_LIMITED,
    OFFLINE,
    SERVICE_UNAVAILABLE,
    CONFIGURATION,
    STORAGE,
    LAST_METHOD,
    EMAIL_UNAVAILABLE,
    CANCELLED,
    PROFILE_SYNC_REQUIRED,
    DEVICE_CONFLICT,
    GLOBAL_LOGOUT_UNCONFIRMED,
}

class AuthFailure(val problem: AuthProblem, val retryAfterSeconds: Long? = null, val httpStatus: Int? = null) :
    Exception(problem.name)

fun canUnlink(providers: Set<String>, provider: String): Boolean =
    provider in providers &&
        providers.minus(provider).any { it == PASSWORD_PROVIDER || it == GOOGLE_PROVIDER }

fun validAuthEmail(email: String): Boolean =
    email.length in 3..254 &&
        !email.any { it.isWhitespace() || it.isISOControl() } &&
        email.substringBefore('@').isNotEmpty() &&
        email.count { it == '@' } == 1 &&
        email.substringAfter('@').contains('.') &&
        !email.endsWith('.')

@Serializable
data class AccountDeletionReceipt(
    val requestId: String,
    val status: String,
    val recoverUntil: String? = null,
)

@Serializable
data class AccountRecoveryRequest(
    val id: String,
    val status: String,
    val reason: String? = null,
    val requestedAt: String,
    val reviewedAt: String? = null,
    val reviewReason: String? = null,
    val revision: Long,
)

@Serializable
data class AccountRecoveryDeletion(
    val requestId: String,
    val requestedAt: String? = null,
    val recoverUntil: String? = null,
    val phase: String? = null,
    val failureCode: String? = null,
    val recoveryAvailable: Boolean,
)

@Serializable
data class AccountRecoveryStatus(
    val accountStatus: String,
    val deletion: AccountRecoveryDeletion? = null,
    val request: AccountRecoveryRequest? = null,
)
