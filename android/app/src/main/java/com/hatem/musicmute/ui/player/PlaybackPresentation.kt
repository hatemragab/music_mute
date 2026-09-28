package com.hatem.musicmute.ui.player

import com.hatem.musicmute.R
import com.hatem.musicmute.playback.PlaybackState
import com.hatem.musicmute.processing.ArtifactProgress

/** Shared by original-audio and voice-only controls. */
internal fun PlaybackState.canSeekAudio(): Boolean =
    trackId != null && durationMs > 0 && !failed && !buffering && !switching

internal fun playbackProgress(positionMs: Long, durationMs: Long): Float =
    if (durationMs > 0) (positionMs.toFloat() / durationMs).coerceIn(0f, 1f) else 0f

internal fun ArtifactProgress.downloadFraction(): Float? =
    totalBytes?.takeIf { it > 0 }
        ?.let { (bytes.toDouble() / it).toFloat().coerceIn(0f, 1f) }

internal fun ArtifactProgress.downloadPercent(): Int? =
    downloadFraction()?.let { (it * 100).toInt().coerceIn(0, 100) }

internal fun ArtifactProgress.displayRemainingMs(): Long? = estimatedRemainingMs?.let {
    if (it <= 0) 0 else ((it + 999) / 1_000) * 1_000
}

internal fun playerSaveLabel(original: Boolean): Int =
    if (original) R.string.save_original else R.string.save_voice
