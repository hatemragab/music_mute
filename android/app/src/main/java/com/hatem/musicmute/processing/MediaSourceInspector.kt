package com.hatem.musicmute.processing

import android.media.MediaCodecList
import android.media.MediaExtractor
import android.media.MediaFormat

/** The selected language/commentary must never change merely because a decoder is missing. */
data class SourceAudioTrack(
    val id: Int, val isDefault: Boolean, val usable: Boolean, val durationSeconds: Double,
    val mime: String, val channels: Int, val sampleRate: Int, val bitRate: Int? = null,
)
data class MediaSourceInspection(val audio: SourceAudioTrack, val hasVideo: Boolean, val audioTrackCount: Int)

fun selectDefaultAudioTrack(tracks: List<SourceAudioTrack>): SourceAudioTrack {
    if (tracks.isEmpty()) throw InputPreparationException(InputPreparationError.NO_AUDIO)
    val defaults = tracks.filter { it.isDefault }
    val selected = if (defaults.size == 1) defaults.single() else if (defaults.isEmpty() && tracks.size == 1)
        tracks.single() else throw InputPreparationException(InputPreparationError.DEFAULT_TRACK_UNAVAILABLE)
    if (!selected.usable) throw InputPreparationException(InputPreparationError.DEFAULT_TRACK_UNAVAILABLE)
    if (!selected.durationSeconds.isFinite() || selected.durationSeconds <= 0)
        throw InputPreparationException(InputPreparationError.DURATION_UNKNOWN)
    return selected
}

fun inspectMediaSource(extractor: MediaExtractor): MediaSourceInspection {
    var video = false
    val tracks = (0 until extractor.trackCount).mapNotNull { index ->
        val format = extractor.getTrackFormat(index)
        val mime = format.getString(MediaFormat.KEY_MIME).orEmpty()
        if (mime.startsWith("video/")) video = true
        if (!mime.startsWith("audio/")) return@mapNotNull null
        fun integer(key: String, fallback: Int = 0) = if (format.containsKey(key)) format.getInteger(key) else fallback
        SourceAudioTrack(index, integer(MediaFormat.KEY_IS_DEFAULT) == 1,
            MediaCodecList(MediaCodecList.REGULAR_CODECS).findDecoderForFormat(format) != null,
            if (format.containsKey(MediaFormat.KEY_DURATION)) format.getLong(MediaFormat.KEY_DURATION) / 1_000_000.0 else Double.NaN,
            mime, integer(MediaFormat.KEY_CHANNEL_COUNT), integer(MediaFormat.KEY_SAMPLE_RATE),
            integer(MediaFormat.KEY_BIT_RATE).takeIf { it > 0 })
    }
    return MediaSourceInspection(selectDefaultAudioTrack(tracks), video, tracks.size)
}

enum class AudioPreparationRoute { COPY, REMUX, CONVERT }
fun audioPreparationRoute(hasVideo: Boolean, compatible: Boolean, fitsBytes: Boolean, channels: Int, bitRate: Int?): AudioPreparationRoute {
    if (compatible && fitsBytes && bitRate != null && bitRate <= 160_000)
        return if (hasVideo) AudioPreparationRoute.REMUX else AudioPreparationRoute.COPY
    if (channels !in 1..2) throw InputPreparationException(InputPreparationError.UNSUPPORTED)
    return AudioPreparationRoute.CONVERT
}
