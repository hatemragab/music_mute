package com.hatem.musicmute.download

import java.io.File
import java.io.IOException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Audio-only HTTPS source; no video fallback, transcoder, remux, or fix-up step. */
object AudioDownloadPolicy {
    const val FORMAT = "bestaudio[protocol=https]"
    val flags =
        listOf(
            "--ignore-config",
            "--no-playlist",
            "--no-simulate",
            "--write-info-json",
            "--no-mtime",
            "--newline",
            "--progress",
        )
    val options =
        mapOf(
            "-f" to FORMAT,
            "--fixup" to "never",
            "--socket-timeout" to "30",
            "--retries" to "3",
            "--fragment-retries" to "3",
            "--progress-template" to
                "download:[download] %(progress._percent_str)s VOCAL:%(progress.downloaded_bytes)s:%(progress.total_bytes)s",
        )
}

data class DownloadedAudio(
    val title: String,
    val file: File,
    val codec: String,
    val extension: String,
    val bitrateKbps: Int,
    val durationMs: Long,
)

object DownloadedAudioReader {
    fun read(directory: File): DownloadedAudio {
        val metadata = File(directory, "audio.info.json")
        if (!metadata.isFile || metadata.length() > 16 * 1024 * 1024)
            throw IOException("Missing audio metadata")
        val info = Json.parseToJsonElement(metadata.readText()).jsonObject
        fun text(key: String) = info[key]?.jsonPrimitive?.contentOrNull.orEmpty()
        fun number(key: String) =
            info[key]?.jsonPrimitive?.doubleOrNull?.takeIf { it.isFinite() && it >= 0 } ?: 0.0
        val extension = text("ext")
        val codec = text("acodec")
        require(text("vcodec") == "none" && codec.isNotBlank() && codec != "none") {
            "Not an audio-only stream"
        }
        require(extension in setOf("webm", "m4a", "mp4", "opus", "ogg", "aac")) {
            "Unsupported audio container"
        }
        val file = File(directory, "audio.$extension")
        require(file.isFile && file.length() > 0) { "Downloaded audio is missing" }
        return DownloadedAudio(
            text("title").take(500),
            file,
            codec.take(80),
            extension,
            number("abr").toInt(),
            (number("duration") * 1000).toLong(),
        )
    }
}

/** Resolve only this app's downloaded files, never arbitrary paths supplied by metadata. */
fun resolveAudioFile(root: File, relativePath: String): File? {
    if (relativePath.isBlank()) return null
    val file = File(root, relativePath).canonicalFile
    val canonicalRoot = root.canonicalFile
    return file.takeIf {
        it.toPath().startsWith(canonicalRoot.toPath()) &&
            it != canonicalRoot &&
            it.isFile &&
            it.length() > 0
    }
}
