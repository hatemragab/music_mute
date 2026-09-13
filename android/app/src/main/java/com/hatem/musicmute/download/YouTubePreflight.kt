package com.hatem.musicmute.download

import com.hatem.musicmute.processing.JobsFailure
import com.hatem.musicmute.processing.JobsProblem
import java.net.URI
import java.net.URLDecoder
import kotlinx.serialization.json.*

object YouTubePreflight {
    fun validateUrl(value: String) {
        val uri = try { URI(value.trim()) } catch (_: Exception) { throw JobsFailure(JobsProblem.INVALID_INPUT) }
        val keys = uri.rawQuery.orEmpty().split('&').map { URLDecoder.decode(it.substringBefore('='), "UTF-8").lowercase() }
        if ("list" in keys || uri.path.orEmpty().trimEnd('/').endsWith("/playlist"))
            throw JobsFailure(JobsProblem.YOUTUBE_PLAYLIST_UNSUPPORTED)
    }
    fun validateMetadata(body: String, maxDuration: Double, inclusive: Boolean = true): Double {
        if (body.length > 1024 * 1024) throw JobsFailure(JobsProblem.MEDIA_UNSUPPORTED)
        val info = try { Json.parseToJsonElement(body).jsonObject } catch (_: Exception) { throw JobsFailure(JobsProblem.MEDIA_DURATION_UNKNOWN) }
        fun text(key: String) = info[key]?.jsonPrimitive?.contentOrNull
        if (text("_type") in setOf("playlist", "multi_video") || info["entries"] != null)
            throw JobsFailure(JobsProblem.YOUTUBE_PLAYLIST_UNSUPPORTED)
        if (info["is_live"]?.jsonPrimitive?.booleanOrNull == true || text("live_status") in setOf("is_live", "is_upcoming", "post_live"))
            throw JobsFailure(JobsProblem.YOUTUBE_LIVE_UNSUPPORTED)
        val duration = info["duration"]?.jsonPrimitive?.takeUnless { it.isString }?.doubleOrNull
            ?.takeIf { it.isFinite() && it > 0 } ?: throw JobsFailure(JobsProblem.MEDIA_DURATION_UNKNOWN)
        if (duration > maxDuration || (!inclusive && duration == maxDuration)) throw JobsFailure(JobsProblem.MEDIA_TOO_LONG)
        return duration
    }
}
fun withinSourceDownloadBounds(actualBytes: Long, elapsedSeconds: Long, maxBytes: Long, deadlineSeconds: Long) =
    actualBytes >= 0 && actualBytes <= maxBytes && elapsedSeconds >= 0 && elapsedSeconds < deadlineSeconds
