package com.hatem.musicmute.ui.player

import com.hatem.musicmute.playback.PlaybackState
import com.hatem.musicmute.playback.RepeatMode
import org.junit.Assert.*
import org.junit.Test

class PlaybackPresentationTest {
    @Test fun unavailableOrFailedAudioCannotSeekEvenWithStaleDuration() {
        assertFalse(PlaybackState(durationMs = 120_000).canSeekAudio())
        assertFalse(PlaybackState(trackId = "track", durationMs = 120_000, failed = true).canSeekAudio())
        assertFalse(PlaybackState(trackId = "track", durationMs = 120_000, buffering = true).canSeekAudio())
        assertFalse(PlaybackState(trackId = "track", durationMs = 0).canSeekAudio())
        assertFalse(PlaybackState(trackId = "track", durationMs = 120_000, switching = true).canSeekAudio())
        assertTrue(PlaybackState(trackId = "track", durationMs = 120_000).canSeekAudio())
    }

    @Test fun progressRemainsFiniteForUnknownAndStaleDurations() {
        assertEquals(0f, playbackProgress(15_000, 0), 0f)
        assertEquals(0f, playbackProgress(15_000, -1), 0f)
        assertEquals(0f, playbackProgress(-1, 60_000), 0f)
        assertEquals(0.5f, playbackProgress(30_000, 60_000), 0.001f)
        assertEquals(1f, playbackProgress(Long.MAX_VALUE, 60_000), 0f)
    }

    @Test fun repeatSongControlTogglesCurrentTrackRepeatOnly() {
        assertEquals(RepeatMode.ONE, RepeatMode.OFF.toggleCurrentTrackRepeat())
        assertEquals(RepeatMode.ONE, RepeatMode.ALL.toggleCurrentTrackRepeat())
        assertEquals(RepeatMode.OFF, RepeatMode.ONE.toggleCurrentTrackRepeat())
    }

    @Test fun miniPlayerIsVisibleOnlyWhileATrackIsPlaying() {
        assertFalse(PlaybackState().shouldShowMiniPlayer())
        assertFalse(PlaybackState(trackId = "restored-track").shouldShowMiniPlayer())
        assertFalse(PlaybackState(playing = true).shouldShowMiniPlayer())
        assertTrue(PlaybackState(trackId = "active-track", playing = true).shouldShowMiniPlayer())
    }
}
