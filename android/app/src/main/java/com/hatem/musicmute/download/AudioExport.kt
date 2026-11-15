package com.hatem.musicmute.download

import java.io.File
import java.io.OutputStream

fun audioExportName(record: DownloadRecord): String {
    val title =
        record.title
            .replace(Regex("[\\p{Cntrl}/\\\\:*?\"<>|]"), "_")
            .trim()
            .trim('.')
            .take(120)
            .ifBlank { "MusicMute audio" }
    return "$title.${record.extension}"
}

fun processedAudioExportName(displayName: String): String {
    val safe = displayName
        .replace(Regex("[\\p{Cntrl}/\\\\:*?\"<>|]"), "_")
        .trim()
        .trim('.', '_')
        .take(120)
        .ifBlank { "MusicMute voice" }
    return "$safe.mp3"
}

fun audioMimeType(extension: String): String =
    when (extension) {
        "webm" -> "audio/webm"
        "m4a",
        "mp4" -> "audio/mp4"
        "opus",
        "ogg" -> "audio/ogg"
        "aac" -> "audio/aac"
        else -> "application/octet-stream"
    }

/** Copies the original bytes; no decoding, remuxing, or encoding occurs. */
internal fun copyOriginalAudio(source: File, destination: OutputStream): Long {
    require(source.isFile && source.length() > 0) { "Audio file is missing" }
    return source.inputStream().use { it.copyTo(destination) }
}
