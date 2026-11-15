package com.hatem.musicmute.playback

import com.hatem.musicmute.library.LibraryKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PlaybackPlayCounterTest {
    private val first = LibraryKey("owner", "first")
    private val second = LibraryKey("owner", "second")

    @Test fun preparationAndFailedStartsDoNotCountUntilAudioActuallyPlays() {
        val counter = PlaybackPlayCounter()
        counter.transitioned(first)
        assertNull(counter.playing(first, false))
        assertNull(counter.playing(first, false))
        assertEquals(first, counter.playing(first, true))
        assertNull(counter.playing(first, true))
    }

    @Test fun resumeBufferingMetadataChangesAndOrdinarySeeksNeverCountAgain() {
        val counter = PlaybackPlayCounter()
        assertEquals(first, counter.playing(first, true))
        assertNull(counter.playing(first, false))
        counter.transitioned(first)
        counter.selectionApplied(first)
        assertNull(counter.playing(first, true))
    }

    @Test fun eachRepeatAndRangeLoopCountsOneRestart() {
        val counter = PlaybackPlayCounter()
        assertEquals(first, counter.playing(first, true))
        counter.transitioned(first, repeated = true)
        assertEquals(first, counter.playing(first, true))
        assertNull(counter.playing(first, true))
        counter.loopRestarted(first)
        assertNull(counter.playing(first, false))
        assertEquals(first, counter.playing(first, true))
        assertNull(counter.playing(first, true))
    }

    @Test fun explicitSelectionOfCurrentTrackWaitsForSelectionAndCountsOnce() {
        val counter = PlaybackPlayCounter()
        assertEquals(first, counter.playing(first, true))
        counter.requestStart(first)
        assertNull(counter.playing(first, true))
        counter.selectionApplied(first)
        counter.transitioned(first)
        assertEquals(first, counter.playing(first, true))
        assertNull(counter.playing(first, true))
    }

    @Test fun queueTransitionsAndAccountChangesResetPendingStarts() {
        val counter = PlaybackPlayCounter()
        counter.requestStart(second)
        counter.transitioned(first)
        assertEquals(first, counter.playing(first, true))
        counter.transitioned(second)
        assertEquals(second, counter.playing(second, true))
        counter.clear()
        assertNull(counter.playing(null, true))
        assertEquals(LibraryKey("other", "first"), counter.playing(LibraryKey("other", "first"), true))
    }

    @Test fun checkpointResumeDoesNotCountButExplicitReplayDoes() {
        val counter = PlaybackPlayCounter()
        counter.restored(first)
        assertNull(counter.playing(first, false))
        assertNull(counter.playing(first, true))
        counter.requestStart(first)
        counter.selectionApplied(first)
        assertEquals(first, counter.playing(first, true))
    }
}
