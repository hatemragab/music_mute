package com.hatem.musicmute.playback

import android.content.Context
import android.graphics.Bitmap
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.toBitmap
import com.hatem.musicmute.R
import java.io.ByteArrayOutputStream

private var cachedPlaybackArtwork: ByteArray? = null

// Media controllers need encoded artwork; a vector resource URI is not a bitmap.
// Reuse the app mark and encode once, without reading media or making network requests.
@Synchronized
internal fun playbackArtwork(context: Context): ByteArray {
    cachedPlaybackArtwork?.let { return it }
    val drawable = requireNotNull(ContextCompat.getDrawable(context, R.drawable.ic_vocal))
    val bitmap = drawable.toBitmap(256, 256, Bitmap.Config.ARGB_8888)
    return try {
        ByteArrayOutputStream().use { output ->
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
            output.toByteArray().also { cachedPlaybackArtwork = it }
        }
    } finally {
        bitmap.recycle()
    }
}
