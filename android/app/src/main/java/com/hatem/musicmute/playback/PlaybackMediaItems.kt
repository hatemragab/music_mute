package com.hatem.musicmute.playback

import android.content.Context
import android.net.Uri
import com.hatem.musicmute.R
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import com.hatem.musicmute.library.LibraryKey

internal const val AUTO_NEXT_COMMAND = "com.hatem.musicmute.AUTO_NEXT"
internal const val AUTO_NEXT_KEY = "autoNext"

internal fun QueueTrack.mediaItem(context: Context, original: Boolean = this.original): MediaItem = MediaItem.Builder()
    .setMediaId("processing:${key.jobId}")
    .setUri(Uri.Builder().scheme("musicmute").authority(if (original) "input" else "output").appendPath(key.ownerUid).appendPath(key.jobId).build())
    .setMediaMetadata(MediaMetadata.Builder()
        .setTitle(title)
        .setArtist(context.getString(if (original) R.string.original_track else R.string.voice_track))
        .setAlbumTitle(context.getString(R.string.app_name))
        .setArtworkData(playbackArtwork(context), MediaMetadata.PICTURE_TYPE_FRONT_COVER)
        .setExtras(Bundle().apply {
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

internal fun RepeatMode.playerMode(): Int = when (this) {
    RepeatMode.OFF -> Player.REPEAT_MODE_OFF; RepeatMode.ALL -> Player.REPEAT_MODE_ALL; RepeatMode.ONE -> Player.REPEAT_MODE_ONE
}
internal fun Int.queueRepeat(): RepeatMode = when (this) {
    Player.REPEAT_MODE_ALL -> RepeatMode.ALL; Player.REPEAT_MODE_ONE -> RepeatMode.ONE; else -> RepeatMode.OFF
}
