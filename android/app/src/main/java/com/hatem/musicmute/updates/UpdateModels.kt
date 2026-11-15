package com.hatem.musicmute.updates

import kotlinx.serialization.Serializable

@Serializable
data class ReleaseArtifact(
    val bytes: Long,
    val sha256Hex: String,
    val signerSha256Hex: String,
)

@Serializable
data class ReleaseTarget(
    val id: String,
    val versionName: String,
    val buildNumber: Int,
    val changelogEn: String,
    val source: String,
    val storeUrl: String? = null,
    val artifact: ReleaseArtifact? = null,
)

@Serializable
data class UpdatePolicySnapshot(
    val schemaVersion: Int,
    val revision: Long,
    val platform: String,
    val distribution: String,
    val minimumBuild: Int? = null,
    val target: ReleaseTarget? = null,
    val checkedAt: String,
)

@Serializable
data class ReleaseDownloadGrant(
    val releaseId: String,
    val url: String,
    val expiresAt: String,
    val bytes: Long,
    val sha256Hex: String,
    val signerSha256Hex: String,
)

enum class UpdateDecision {
    NONE,
    OPTIONAL,
    REQUIRED,
}

enum class UpdateTrigger {
    LAUNCH,
    RECONNECT,
    FOREGROUND,
    INTERVAL,
    RETRY,
    PROCESSING_REJECTED,
}

enum class UpdateProblem {
    UPDATE_REQUIRED,
    OFFLINE,
    SERVICE_UNAVAILABLE,
    RATE_LIMITED,
    INVALID_POLICY,
    RELEASE_UNAVAILABLE,
    DOWNLOAD_FAILED,
    INSUFFICIENT_STORAGE,
    APK_CHECKSUM_MISMATCH,
    APK_SIZE_MISMATCH,
    APK_PACKAGE_MISMATCH,
    APK_BUILD_MISMATCH,
    APK_SIGNER_MISMATCH,
    APK_INVALID,
    INSTALL_PERMISSION_REQUIRED,
    INSTALLER_UNAVAILABLE,
    INSTALL_CANCELLED,
    PLAY_UPDATE_UNAVAILABLE,
}

class UpdateFailure(
    val problem: UpdateProblem,
    val retryAfterSeconds: Long? = null,
) : Exception(problem.name)

data class UpdateUiState(
    val restoring: Boolean = true,
    val decision: UpdateDecision = UpdateDecision.NONE,
    val snapshot: UpdatePolicySnapshot? = null,
    val checking: Boolean = false,
    val failure: UpdateProblem? = null,
)

sealed interface UpdateInstallState {
    data object Idle : UpdateInstallState
    data class Downloading(val percent: Int) : UpdateInstallState
    data object Verifying : UpdateInstallState
    data object PermissionNeeded : UpdateInstallState
    data object AwaitingInstaller : UpdateInstallState
    data object StoreOpened : UpdateInstallState
    data class Failed(val problem: UpdateProblem) : UpdateInstallState
}
