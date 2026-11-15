package com.hatem.musicmute.ui.player

import com.hatem.musicmute.playback.PlaybackState

/** Shared by original-audio and voice-only controls. */
internal fun PlaybackState.canSeekAudio(): Boolean =
    trackId != null && durationMs > 0 && !failed && !buffering

internal fun playbackProgress(positionMs: Long, durationMs: Long): Float =
    if (durationMs > 0) (positionMs.toFloat() / durationMs).coerceIn(0f, 1f) else 0f
