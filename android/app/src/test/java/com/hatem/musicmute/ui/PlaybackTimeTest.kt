package com.hatem.musicmute.ui

import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Test

class PlaybackTimeTest {
    @Test
    fun formatsLongAudioAndClampsInvalidPositions() {
        val previous = Locale.getDefault()
        try {
            Locale.setDefault(Locale.US)
            assertEquals("0:00", playbackTime(-1))
            assertEquals("1:05", playbackTime(65_000))
            assertEquals("1:01:01", playbackTime(3_661_000))
        } finally {
            Locale.setDefault(previous)
        }
    }
}
