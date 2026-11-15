package com.hatem.musicmute.ui.library

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.library.LibraryThumbnailLoader
import com.hatem.musicmute.processing.validatedThumbnailUrl
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private val libraryThumbnails = LibraryThumbnailLoader()

/** Shared decorative artwork: the original note tile remains for unavailable images. */
@Composable
internal fun LibraryThumbnail(
    value: String?,
    modifier: Modifier = Modifier,
    shape: Shape = RoundedCornerShape(14.dp),
    shadowElevation: Dp = 4.dp,
    decodeSizePx: Int = 256,
    placeholder: @Composable BoxScope.() -> Unit,
) {
    val image = libraryThumbnail(value, decodeSizePx)
    Box(modifier.shadow(shadowElevation, shape, clip = false).clip(shape),
        contentAlignment = Alignment.Center) {
        if (image == null) placeholder()
        else Image(image, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
    }
}

/** The note tile remains visible until a bounded, decodable image is ready. */
@Composable
internal fun libraryThumbnail(value: String?, decodeSizePx: Int = 256): ImageBitmap? {
    val url = validatedThumbnailUrl(value)
    // A large player cover stays sharp while decoded RGBA pixels remain at most 1 MiB.
    val maximumEdge = decodeSizePx.coerceIn(64, 512)
    val image by key(url, maximumEdge) { produceState<ImageBitmap?>(null, url, maximumEdge) {
        this.value = null
        val bytes = libraryThumbnails.load(url) ?: return@produceState
        this.value = withContext(Dispatchers.Default) {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outWidth !in 1..4096 || bounds.outHeight !in 1..4096) return@withContext null
            val options = BitmapFactory.Options()
            options.inSampleSize = 1
            while ((bounds.outWidth + options.inSampleSize - 1) / options.inSampleSize > maximumEdge ||
                (bounds.outHeight + options.inSampleSize - 1) / options.inSampleSize > maximumEdge) options.inSampleSize *= 2
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)?.asImageBitmap()
        }
    } }
    return image
}
