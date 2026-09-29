package com.hatem.musicmute.ui.player

import com.hatem.musicmute.R
import com.hatem.musicmute.playback.PlaybackState
import com.hatem.musicmute.playback.RepeatMode
import com.hatem.musicmute.processing.ArtifactProgress
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

    @Test fun downloadPresentationClampsProgressAndRoundsRemainingTimeUp() {
        assertEquals(25, ArtifactProgress(250, 1_000).downloadPercent())
        assertEquals(0f, ArtifactProgress(-1, 1_000).downloadFraction()!!, 0f)
        assertEquals(100, ArtifactProgress(1_500, 1_000).downloadPercent())
        assertNull(ArtifactProgress(10, null).downloadPercent())
        assertEquals(2_000L, ArtifactProgress(10, 100, estimatedRemainingMs = 1_001).displayRemainingMs())
    }

    @Test fun saveLabelFollowsTheSelectedTrack() {
        assertEquals(R.string.save_voice, playerSaveLabel(original = false))
        assertEquals(R.string.save_original, playerSaveLabel(original = true))
    }

    @Test fun downloadValuesFollowReceivedBytesForBothAudioVariants() {
        for (artifact in listOf("input", "output")) {
            val values = listOf(0L, 250L, 680L, 1_000L).map {
                ArtifactProgress(it, 1_000, artifact).downloadPercent()
            }
            assertEquals(listOf(0, 25, 68, 100), values)
            assertNull(ArtifactProgress(680, 0, artifact).downloadFraction())
            assertNull(ArtifactProgress(680, -1, artifact).downloadPercent())
        }
    }
}
