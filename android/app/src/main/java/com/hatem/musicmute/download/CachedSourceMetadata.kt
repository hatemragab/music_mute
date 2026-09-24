package com.hatem.musicmute.download

import com.yausername.youtubedl_android.YoutubeDLRequest
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/** Remove yt-dlp's automatic re-extraction fallback before consuming saved metadata. */
internal fun prepareCachedSource(directory: File) {
    val file = File(directory, "audio.info.json")
    require(file.isFile && file.length() in 1..16 * 1024 * 1024) { "Missing audio metadata" }
    val info = Json.parseToJsonElement(file.readText()).jsonObject
    require(info["entries"] == null) { "Unexpected playlist metadata" }
    file.writeText(JsonObject(info - setOf("webpage_url", "original_url")).toString())
}

internal fun createCachedAudioRequest(directory: File): YoutubeDLRequest =
    createAudioRequest("", directory).apply {
        addOption("--load-info-json", File(directory, "audio.info.json").absolutePath)
    }
