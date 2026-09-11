package com.hatem.musicmute.processing

import android.media.MediaCodecList
import android.media.MediaExtractor
import android.media.MediaFormat
import java.io.File

/** Platform inspection is a client preflight; the worker still validates the complete media. */
fun inspectProcessingAudio(file: File): AudioInspection {
    val type = sniffProcessingContainer(file)
        ?: throw InputPreparationException(InputPreparationError.UNSUPPORTED)
    val extractor = MediaExtractor()
    try {
        extractor.setDataSource(file.absolutePath)
        var audio = false
        var video = false
        var duration = Double.NaN
        for (index in 0 until extractor.trackCount) {
            val format = extractor.getTrackFormat(index)
            val mime = format.getString(MediaFormat.KEY_MIME).orEmpty()
            if (mime.startsWith("video/")) video = true
            if (mime.startsWith("audio/")) {
                if (MediaCodecList(MediaCodecList.REGULAR_CODECS).findDecoderForFormat(format) == null)
                    throw InputPreparationException(InputPreparationError.UNSUPPORTED)
                audio = true
                val seconds = if (format.containsKey(MediaFormat.KEY_DURATION))
                    format.getLong(MediaFormat.KEY_DURATION) / 1_000_000.0 else Double.NaN
                if (!seconds.isFinite() || seconds <= 0)
                    throw InputPreparationException(InputPreparationError.INVALID_AUDIO)
                duration = if (duration.isNaN()) seconds else maxOf(duration, seconds)
            }
        }
        return AudioInspection(duration, audio, video, type)
    } catch (error: InputPreparationException) {
        throw error
    } catch (_: Exception) {
        throw InputPreparationException(InputPreparationError.INVALID_AUDIO)
    } finally {
        extractor.release()
    }
}

internal fun sniffProcessingContainer(file: File): String? {
    val header = file.inputStream().use { source ->
        val bytes = ByteArray(16)
        val count = source.read(bytes)
        bytes.copyOf(count.coerceAtLeast(0))
    }
    fun byte(index: Int) = header.getOrNull(index)?.toInt()?.and(255) ?: -1
    fun text(start: Int, end: Int) = if (header.size >= end)
        String(header, start, end - start, Charsets.US_ASCII) else ""
    return when {
        text(4, 8) == "ftyp" -> "audio/mp4"
        byte(0) == 0x1a && byte(1) == 0x45 && byte(2) == 0xdf && byte(3) == 0xa3 -> "audio/webm"
        text(0, 4) == "OggS" -> "audio/ogg"
        text(0, 3) == "ID3" -> if (file.extension.lowercase() == "aac") "audio/aac" else "audio/mpeg"
        byte(0) == 0xff && (byte(1) and 0xf6) == 0xf0 -> "audio/aac"
        byte(0) == 0xff && (byte(1) and 0xe0) == 0xe0 -> "audio/mpeg"
        else -> null
    }
}
