package com.hatem.musicmute.ui.player

import com.hatem.musicmute.playback.PlaybackState
import com.hatem.musicmute.playback.sectionLoopRange
import org.junit.Assert.*
import org.junit.Test

class PlaybackPresentationTest {
    @Test fun unavailableOrFailedAudioCannotSeekEvenWithStaleDuration() {
        assertFalse(PlaybackState(durationMs = 120_000).canSeekAudio())
        assertFalse(PlaybackState(trackId = "track", durationMs = 120_000, failed = true).canSeekAudio())
        assertFalse(PlaybackState(trackId = "track", durationMs = 120_000, buffering = true).canSeekAudio())
        assertFalse(PlaybackState(trackId = "track", durationMs = 0).canSeekAudio())
        assertTrue(PlaybackState(trackId = "track", durationMs = 120_000).canSeekAudio())
    }

    @Test fun progressRemainsFiniteForUnknownAndStaleDurations() {
        assertEquals(0f, playbackProgress(15_000, 0), 0f)
        assertEquals(0f, playbackProgress(15_000, -1), 0f)
        assertEquals(0f, playbackProgress(-1, 60_000), 0f)
        assertEquals(0.5f, playbackProgress(30_000, 60_000), 0.001f)
        assertEquals(1f, playbackProgress(Long.MAX_VALUE, 60_000), 0f)
    }

    @Test fun sectionLoopStartsAtThePlayheadAndStopsAfterFifteenSeconds() {
        assertEquals(12_000L to 27_000L, sectionLoopRange(12_000, 180_000))
        assertEquals(170_000L to 180_000L, sectionLoopRange(170_000, 180_000))
        assertNull(sectionLoopRange(179_500, 180_000))
        assertNull(sectionLoopRange(-1, 180_000))
    }
}
