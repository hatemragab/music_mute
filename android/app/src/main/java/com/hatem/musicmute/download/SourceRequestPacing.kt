package com.hatem.musicmute.download

import android.content.Context

internal enum class SourceRefusal { NONE, RATE_LIMITED, FORBIDDEN, AUTH_REQUIRED }

/** Inspect native text in memory, but retain only these categories. */
internal fun sourceRefusal(text: String): SourceRefusal {
    val message = text.lowercase()
    return when {
        Regex("(?:http(?: error)?[ :]+|status(?: code)?[ :]+)429\\b").containsMatchIn(message) ||
            "too many requests" in message || "try again later" in message -> SourceRefusal.RATE_LIMITED
        Regex("(?:http(?: error)?[ :]+|status(?: code)?[ :]+)403\\b").containsMatchIn(message) -> SourceRefusal.FORBIDDEN
        "sign in" in message || "confirm you're not a bot" in message -> SourceRefusal.AUTH_REQUIRED
        else -> SourceRefusal.NONE
    }
}

internal const val SOURCE_GAP_MILLIS = 5_000L
internal const val SOURCE_COOLDOWN_MILLIS = 15 * 60_000L

internal fun sourceWaitMillis(until: Long, now: Long): Long =
    (until - now).coerceIn(0L, SOURCE_COOLDOWN_MILLIS)

/** Device-wide pacing survives restart; intentionally not scoped to a login. */
internal class SourceRequestPacing(context: Context) {
    private val preferences = context.getSharedPreferences("youtube_request_pacing", Context.MODE_PRIVATE)

    fun remainingMillis(now: Long = System.currentTimeMillis()): Long =
        sourceWaitMillis(preferences.getLong("not_before", 0L), now)

    fun finish(refusal: SourceRefusal = SourceRefusal.NONE) {
        val now = System.currentTimeMillis()
        val gap = if (refusal == SourceRefusal.NONE) SOURCE_GAP_MILLIS else SOURCE_COOLDOWN_MILLIS
        val remaining = maxOf(remainingMillis(now), gap)
        check(preferences.edit().putLong("not_before", now + remaining).commit())
    }
}
