package com.hatem.musicmute.auth

import kotlinx.serialization.Serializable

@Serializable
data class PendingProfileName(val uid: String, val fullName: String)

fun validatedFullName(value: String): String {
    val name = value.trim()
    if (name.codePointCount(0, name.length) !in 1..200 || name.codePoints().anyMatch(Character::isISOControl))
        throw AuthFailure(AuthProblem.INVALID_INPUT)
    return name
}

/** Account creation is deliberately outside this retryable, owner-scoped operation. */
internal suspend fun completeProfileNameUpdate(
    request: PendingProfileName,
    persist: suspend (PendingProfileName) -> Unit,
    apply: suspend (PendingProfileName) -> Unit,
    clear: suspend (String) -> Unit,
): Boolean = try {
    persist(request)
    apply(request)
    clear(request.uid)
    true
} catch (_: AuthFailure) {
    false
}
