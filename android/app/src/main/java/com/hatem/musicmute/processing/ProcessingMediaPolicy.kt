package com.hatem.musicmute.processing

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

/** Server policy is an admission hint; accepted job snapshots remain authoritative. */
@Serializable
data class ProcessingMediaPolicy(
    val version: Int = 2,
    val revision: Int = 0,
    val maxDurationSeconds: Double = 1_200.0,
    val maxPreparedAudioBytes: Long = 50_000_000,
    val profileId: String = "audio-cap-aac-lc-160-v1",
    val maxLocalSourceBytes: Long? = 200_000_000,
    val maxPreparationSeconds: Long? = 120,
    val maxSourceDownloadBytes: Long? = 50_000_000,
    val maxSourceDownloadSeconds: Long? = 120,
    val acceptNewJobs: Boolean = true,
    val acceptLongJobs: Boolean = true,
    val longJobThresholdSeconds: Double? = null,
) {
    val localPreparationReady get() = (maxLocalSourceBytes ?: 0) > 0 && (maxPreparationSeconds ?: 0) > 0
    val youtubePreparationReady get() = localPreparationReady && maxSourceDownloadBytes != null && maxSourceDownloadSeconds != null
    fun acceptsPrepared(bytes: Long, durationSeconds: Double): Boolean = bytes > 0 &&
        durationSeconds.isFinite() && durationSeconds > 0 &&
        bytes <= maxPreparedAudioBytes && durationSeconds <= maxDurationSeconds
    fun acceptsDuration(seconds: Double) = acceptsPrepared(1, seconds)
    fun requireLongJobAvailable(seconds: Double) {
        if (!acceptLongJobs && (longJobThresholdSeconds == null || seconds > longJobThresholdSeconds))
            throw JobsFailure(JobsProblem.PROCESSING_CAPACITY_UNAVAILABLE)
    }

    companion object {
        /** Safe offline ceiling. A valid backend response may only reduce these limits. */
        val STANDARD = ProcessingMediaPolicy()
        fun parse(body: String): ProcessingMediaPolicy {
            try {
                val root = Json.parseToJsonElement(body).jsonObject
                fun JsonObject.number(key: String) = get(key)?.jsonPrimitive?.takeUnless { it.isString }?.doubleOrNull
                val rawVersion = root.number("schemaVersion") ?: error("Missing version")
                require(rawVersion == 2.0)
                val version = rawVersion.toInt()
                val limits = root.getValue("limits").jsonObject
                val profile = root.getValue("preparationProfile").jsonObject
                val fallback = profile.getValue("fallbackConversion").jsonObject
                require(profile["preserveCompatibleAudio"]?.jsonPrimitive?.booleanOrNull == true)
                require(fallback["codec"]?.jsonPrimitive?.content == "aac-lc")
                require(fallback["outputContentType"]?.jsonPrimitive?.content == "audio/mp4")
                require(fallback.number("targetBitrate") == 160000.0)
                val id = profile.getValue("id").jsonPrimitive.content
                require(id == "audio-cap-aac-lc-160-v1")
                fun positiveBound(key: String): Long? {
                    if (limits[key] == null || limits[key] is JsonNull) return null
                    val value = limits.number(key) ?: error("Invalid bound")
                    require(value.isFinite() && value > 0 && value <= Long.MAX_VALUE.toDouble() && value % 1 == 0.0)
                    return value.toLong()
                }
                val duration = limits.number("maxDurationSeconds") ?: error("Missing duration")
                val bytes = positiveBound("maxPreparedAudioBytes") ?: error("Missing size")
                require(duration.isFinite() && duration > 0 && duration <= STANDARD.maxDurationSeconds)
                require(bytes <= STANDARD.maxPreparedAudioBytes)
                val localBytes = positiveBound("maxLocalSourceBytes")
                val preparationSeconds = positiveBound("maxPreparationSeconds")
                val sourceBytes = positiveBound("maxSourceDownloadBytes")
                val sourceSeconds = positiveBound("maxSourceDownloadSeconds")
                require(localBytes != null && localBytes <= STANDARD.maxLocalSourceBytes!!)
                require(preparationSeconds != null && preparationSeconds <= STANDARD.maxPreparationSeconds!!)
                require(sourceBytes != null && sourceBytes <= STANDARD.maxSourceDownloadBytes!!)
                require(sourceSeconds != null && sourceSeconds <= STANDARD.maxSourceDownloadSeconds!!)
                return ProcessingMediaPolicy(2, root.number("revision")?.toInt() ?: error("Missing revision"),
                    duration, bytes, id, localBytes, preparationSeconds,
                    sourceBytes, sourceSeconds,
                    root.getValue("acceptNewJobs").jsonPrimitive.boolean,
                    root["acceptLongJobs"]?.jsonPrimitive?.booleanOrNull ?: false,
                    limits.number("longJobThresholdSeconds")?.takeIf { it.isFinite() && it > 0 && it <= duration })
            } catch (_: Exception) { throw JobsFailure(JobsProblem.PROCESSING_POLICY_INCOMPATIBLE) }
        }
    }
}
