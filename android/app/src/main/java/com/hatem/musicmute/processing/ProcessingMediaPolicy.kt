package com.hatem.musicmute.processing

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

/** Server policy is an admission hint; accepted job snapshots remain authoritative. */
@Serializable
data class ProcessingMediaPolicy(
    val version: Int = 1,
    val revision: Int = 0,
    val maxDurationSeconds: Double = 600.0,
    val maxPreparedAudioBytes: Long = 30_000_000,
    val profileId: String? = null,
    val maxLocalSourceBytes: Long? = null,
    val maxPreparationSeconds: Long? = null,
    val maxSourceDownloadBytes: Long? = null,
    val maxSourceDownloadSeconds: Long? = null,
    val acceptNewJobs: Boolean = true,
    val acceptLongJobs: Boolean = true,
    val longJobThresholdSeconds: Double? = null,
) {
    val localPreparationReady get() = (maxLocalSourceBytes ?: 0) > 0 && (maxPreparationSeconds ?: 0) > 0
    val localExpansionReady get() = version == 2 && localPreparationReady
    val youtubeExpansionReady get() = localExpansionReady && maxSourceDownloadBytes != null && maxSourceDownloadSeconds != null
    fun acceptsPrepared(bytes: Long, durationSeconds: Double): Boolean = bytes > 0 &&
        durationSeconds.isFinite() && durationSeconds > 0 && if (version == 2)
        bytes <= maxPreparedAudioBytes && durationSeconds <= maxDurationSeconds
        else bytes < maxPreparedAudioBytes && durationSeconds < maxDurationSeconds
    fun acceptsDuration(seconds: Double) = acceptsPrepared(1, seconds)
    fun requireLongJobAvailable(seconds: Double) {
        if (version == 2 && !acceptLongJobs && (longJobThresholdSeconds == null || seconds > longJobThresholdSeconds))
            throw JobsFailure(JobsProblem.PROCESSING_CAPACITY_UNAVAILABLE)
    }

    companion object {
        // On-device extraction does not expand server admission or establish worker capacity.
        // Keep the standard exclusive audio limits and submit without v2 qualification metadata.
        val LEGACY = ProcessingMediaPolicy(maxLocalSourceBytes = 200_000_000, maxPreparationSeconds = 120)
        fun parse(body: String): ProcessingMediaPolicy {
            try {
                val root = Json.parseToJsonElement(body).jsonObject
                fun JsonObject.number(key: String) = get(key)?.jsonPrimitive?.takeUnless { it.isString }?.doubleOrNull
                val rawVersion = root.number("schemaVersion") ?: 1.0
                require(rawVersion == 1.0 || rawVersion == 2.0)
                val version = rawVersion.toInt()
                if (version == 1) return LEGACY
                val limits = root.getValue("limits").jsonObject
                val profile = root.getValue("preparationProfile").jsonObject
                val fallback = profile.getValue("fallbackConversion").jsonObject
                require(profile["preserveCompatibleAudio"]?.jsonPrimitive?.booleanOrNull == true)
                require(fallback["codec"]?.jsonPrimitive?.content == "aac-lc")
                require(fallback["outputContentType"]?.jsonPrimitive?.content == "audio/mp4")
                require(fallback.number("targetBitrate") == 256000.0)
                val id = profile.getValue("id").jsonPrimitive.content
                require(id == "preserve-or-aac-lc-256-v1")
                fun positiveBound(key: String): Long? {
                    if (limits[key] == null || limits[key] is JsonNull) return null
                    val value = limits.number(key) ?: error("Invalid bound")
                    require(value.isFinite() && value > 0 && value <= Long.MAX_VALUE.toDouble() && value % 1 == 0.0)
                    return value.toLong()
                }
                val duration = limits.number("maxDurationSeconds") ?: error("Missing duration")
                val bytes = positiveBound("maxPreparedAudioBytes") ?: error("Missing size")
                require(duration.isFinite() && duration > 0 && duration <= 1800 && bytes <= 100_000_000)
                return ProcessingMediaPolicy(2, root.number("revision")?.toInt() ?: error("Missing revision"),
                    duration, bytes, id, positiveBound("maxLocalSourceBytes"), positiveBound("maxPreparationSeconds"),
                    positiveBound("maxSourceDownloadBytes"), positiveBound("maxSourceDownloadSeconds"),
                    root.getValue("acceptNewJobs").jsonPrimitive.boolean,
                    root["acceptLongJobs"]?.jsonPrimitive?.booleanOrNull ?: false,
                    limits.number("longJobThresholdSeconds")?.takeIf { it.isFinite() && it > 0 && it <= duration })
            } catch (_: Exception) { throw JobsFailure(JobsProblem.PROCESSING_POLICY_INCOMPATIBLE) }
        }
    }
}
