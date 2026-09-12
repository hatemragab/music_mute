package com.hatem.musicmute.updates

import java.net.URI
import java.time.Instant

private val releaseIdPattern = Regex("^[a-f0-9]{24}$")
private val digestPattern = Regex("^[a-f0-9]{64}$")
private val versionPattern = Regex("^(?:0|[1-9]\\d*)(?:\\.(?:0|[1-9]\\d*)){0,2}$")

private fun invalid(): Nothing = throw UpdateFailure(UpdateProblem.INVALID_POLICY)

private fun validBuild(value: Int?): Boolean = value != null && value in 1..Int.MAX_VALUE

private fun validHttps(value: String): Boolean {
    val uri = runCatching { URI(value) }.getOrNull() ?: return false
    return uri.scheme == "https" &&
        !uri.host.isNullOrBlank() &&
        uri.rawUserInfo == null &&
        uri.rawFragment == null
}

fun validateUpdateSnapshot(snapshot: UpdatePolicySnapshot) {
    if (
        snapshot.schemaVersion != 1 ||
            snapshot.revision < 0 ||
            snapshot.platform != "android" ||
            snapshot.distribution !in setOf("direct", "play") ||
            snapshot.minimumBuild?.let(::validBuild) == false ||
            runCatching { Instant.parse(snapshot.checkedAt) }.isFailure
    ) invalid()

    val target = snapshot.target
    if (snapshot.minimumBuild != null && (target == null || target.buildNumber < snapshot.minimumBuild))
        invalid()
    if (target == null) return
    if (
        !releaseIdPattern.matches(target.id) ||
            !validBuild(target.buildNumber) ||
            !versionPattern.matches(target.versionName) ||
            target.versionName.length > 64 ||
            target.changelogEn.isBlank() ||
            target.changelogEn.length > 10_000 ||
            target.changelogEn.any { it == '<' || it == '>' }
    ) invalid()

    when (snapshot.distribution) {
        "direct" ->
            when (target.source) {
                "direct_apk" -> {
                    val artifact = target.artifact ?: invalid()
                    if (
                        target.storeUrl != null ||
                            artifact.bytes <= 0 ||
                            !digestPattern.matches(artifact.sha256Hex) ||
                            !digestPattern.matches(artifact.signerSha256Hex)
                    ) invalid()
                }
                "google_play" -> if (target.artifact != null || target.storeUrl?.let(::validHttps) != true) invalid()
                else -> invalid()
            }
        "play" ->
            if (target.source != "google_play" || target.artifact != null || target.storeUrl?.let(::validHttps) != true)
                invalid()
        else -> invalid()
    }
}

fun decideUpdate(installedBuild: Int, snapshot: UpdatePolicySnapshot): UpdateDecision {
    if (!validBuild(installedBuild)) invalid()
    validateUpdateSnapshot(snapshot)
    if (snapshot.minimumBuild != null && installedBuild < snapshot.minimumBuild)
        return UpdateDecision.REQUIRED
    return if (snapshot.target != null && installedBuild < snapshot.target.buildNumber)
        UpdateDecision.OPTIONAL
    else UpdateDecision.NONE
}

fun resolveUpdateSource(distribution: String, selectedSource: String): String =
    when (distribution) {
        "direct" -> selectedSource.takeIf { it in setOf("direct_apk", "google_play") } ?: invalid()
        "play" -> "google_play"
        else -> invalid()
    }

fun validateGooglePlayTarget(target: ReleaseTarget, packageName: String) {
    val value = target.storeUrl ?: invalid()
    val uri = runCatching { URI(value) }.getOrNull() ?: invalid()
    if (
        target.source != "google_play" ||
            target.artifact != null ||
            packageName.isBlank() ||
            uri.scheme != "https" ||
            uri.host != "play.google.com" ||
            uri.path != "/store/apps/details" ||
            uri.rawQuery != "id=$packageName" ||
            uri.rawUserInfo != null ||
            uri.rawFragment != null
    ) invalid()
}

fun validateDownloadGrant(grant: ReleaseDownloadGrant) {
    if (
        !releaseIdPattern.matches(grant.releaseId) ||
            !validHttps(grant.url) ||
            runCatching { Instant.parse(grant.expiresAt) }.isFailure ||
            grant.bytes <= 0 ||
            !digestPattern.matches(grant.sha256Hex) ||
            !digestPattern.matches(grant.signerSha256Hex)
    ) invalid()
}
