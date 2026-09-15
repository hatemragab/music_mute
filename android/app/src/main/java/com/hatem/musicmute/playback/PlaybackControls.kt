package com.hatem.musicmute.playback

internal fun normalizedPlaybackSpeed(value: Float): Float =
    if (value.isFinite()) value.coerceIn(0.5f, 2f) else 1f

internal fun normalizedPlaybackVolume(value: Float): Float =
    if (value.isFinite()) value.coerceIn(0f, 1f) else 1f
