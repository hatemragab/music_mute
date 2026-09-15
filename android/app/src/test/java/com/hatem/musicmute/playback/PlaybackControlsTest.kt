package com.hatem.musicmute.playback

import org.junit.Assert.*
import org.junit.Test

class PlaybackControlsTest {
    @Test fun speedRejectsNonFiniteAndBoundsExtremeValues() {
        assertEquals(1f, normalizedPlaybackSpeed(Float.NaN), 0f)
        assertEquals(1f, normalizedPlaybackSpeed(Float.POSITIVE_INFINITY), 0f)
        assertEquals(0.5f, normalizedPlaybackSpeed(-10f), 0f)
        assertEquals(2f, normalizedPlaybackSpeed(100f), 0f)
        assertEquals(1.25f, normalizedPlaybackSpeed(1.25f), 0f)
    }

    @Test fun volumeNeverExceedsUnityGainOrPassesInvalidValues() {
        assertEquals(1f, normalizedPlaybackVolume(Float.NaN), 0f)
        assertEquals(1f, normalizedPlaybackVolume(Float.NEGATIVE_INFINITY), 0f)
        assertEquals(0f, normalizedPlaybackVolume(-1f), 0f)
        assertEquals(1f, normalizedPlaybackVolume(2f), 0f)
        assertEquals(0.35f, normalizedPlaybackVolume(0.35f), 0f)
    }
}
