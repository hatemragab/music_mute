package com.hatem.musicmute.playback

import android.net.Uri
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import com.hatem.musicmute.library.LibraryKey

internal const val AUTO_NEXT_COMMAND = "com.hatem.musicmute.AUTO_NEXT"
internal const val AUTO_NEXT_KEY = "autoNext"

internal fun QueueTrack.mediaItem(original: Boolean = this.original): MediaItem = MediaItem.Builder()
    .setMediaId("processing:${key.jobId}")
    .setUri(Uri.Builder().scheme("musicmute").authority(if (original) "input" else "output").appendPath(key.ownerUid).appendPath(key.jobId).build())
    .setMediaMetadata(MediaMetadata.Builder().setTitle(title).setExtras(Bundle().apply {
        putBoolean("original", original); putString("ownerUid", key.ownerUid); putString("jobId", key.jobId)
    }).build()).build()

internal fun MediaItem.queueTrack(): QueueTrack? {
    mediaMetadata.extras?.let { extras ->
        val uid = extras.getString("ownerUid")
        val job = extras.getString("jobId")
        if (!uid.isNullOrBlank() && !job.isNullOrBlank()) return QueueTrack(LibraryKey(uid, job), mediaMetadata.title?.toString().orEmpty(), extras.getBoolean("original"))
    }
    val uri = localConfiguration?.uri ?: return null
    if (uri.scheme != "musicmute" || uri.authority !in setOf("output", "input") || uri.pathSegments.size != 2) return null
    return QueueTrack(LibraryKey(uri.pathSegments[0], uri.pathSegments[1]), mediaMetadata.title?.toString().orEmpty(), uri.authority == "input")
}

/** A 15-second window starting at the playhead. Shorter than one second is not a loop. */
internal fun sectionLoopRange(positionMs: Long, durationMs: Long, windowMs: Long = 15_000): Pair<Long, Long>? {
    if (positionMs < 0 || windowMs < 1_000) return null
    val start = positionMs
    val end = if (durationMs > 0) minOf(durationMs, start + windowMs) else start + windowMs
    return if (end - start >= 1_000) start to end else null
}

internal fun RepeatMode.playerMode(): Int = when (this) {
    RepeatMode.OFF -> Player.REPEAT_MODE_OFF; RepeatMode.ALL -> Player.REPEAT_MODE_ALL; RepeatMode.ONE -> Player.REPEAT_MODE_ONE
}
internal fun Int.queueRepeat(): RepeatMode = when (this) {
    Player.REPEAT_MODE_ALL -> RepeatMode.ALL; Player.REPEAT_MODE_ONE -> RepeatMode.ONE; else -> RepeatMode.OFF
}
