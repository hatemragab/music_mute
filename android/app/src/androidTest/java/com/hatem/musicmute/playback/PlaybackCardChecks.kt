package com.hatem.musicmute.playback

import android.content.Context
import android.graphics.BitmapFactory
import com.hatem.musicmute.MainActivity
import com.hatem.musicmute.R
import com.hatem.musicmute.library.LibraryKey

/** Opt-in Android framework checks; no playback, downloads or Activity launch. */
internal fun checkPlaybackCard(context: Context) {
    val track = QueueTrack(LibraryKey("fixture-owner", "fixture-job"), "Fixture audio")
    for (original in listOf(false, true)) {
        val item = track.mediaItem(context, original)
        check(item.queueTrack() == track.copy(original = original))
        check(item.mediaMetadata.title == track.title)
        check(item.mediaMetadata.artist == context.getString(
            if (original) R.string.original_track else R.string.voice_track,
        ))
        check(item.mediaMetadata.albumTitle == context.getString(R.string.app_name))
        val art = requireNotNull(item.mediaMetadata.artworkData)
        val bitmap = requireNotNull(BitmapFactory.decodeByteArray(art, 0, art.size))
        check(bitmap.width == 256 && bitmap.height == 256)
        bitmap.recycle()
    }
    check(playbackArtwork(context).contentEquals(playbackArtwork(context)))
    val player = MainActivity.playerPendingIntent(context)
    check(player == MainActivity.playerPendingIntent(context))
    check(player != MainActivity.historyPendingIntent(context))
    check(player != MainActivity.processingPendingIntent(context))
}
