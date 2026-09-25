package com.hatem.musicmute.processing

fun processedAudioExportName(displayName: String): String {
    val safe = displayName
        .replace(Regex("[\\p{Cntrl}/\\\\:*?\"<>|]"), "_")
        .trim()
        .trim('.', '_')
        .take(120)
        .ifBlank { "MusicMute voice" }
    return "$safe.mp3"
}
