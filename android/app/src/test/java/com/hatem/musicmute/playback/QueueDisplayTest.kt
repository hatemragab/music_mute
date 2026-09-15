package com.hatem.musicmute.playback

import com.hatem.musicmute.library.LibraryKey
import org.junit.Assert.*
import org.junit.Test

class QueueDisplayTest {
    private val tracks = (0..3).map { QueueTrack(LibraryKey("owner", "$it"), "Track $it") }

    @Test fun separatesPlayedTracksFromUpcoming() {
        val result = queueDisplay(tracks, tracks[1].key, RepeatMode.OFF, true)
        assertEquals(tracks.drop(2), result.upcoming)
        assertEquals(listOf(tracks[0]), result.other)
    }

    @Test fun repeatAllWrapsInActualShuffleOrderWithoutDuplicatingCurrent() {
        val order = listOf(tracks[2], tracks[0], tracks[3], tracks[1])
        val result = queueDisplay(order, tracks[3].key, RepeatMode.ALL, true)
        assertEquals(listOf(tracks[1], tracks[2], tracks[0]), result.upcoming)
        assertTrue(result.other.isEmpty())
    }

    @Test fun disabledAutoNextKeepsOtherTracksAccessibleWithoutPromisingPlayback() {
        val result = queueDisplay(tracks, tracks[1].key, RepeatMode.ALL, false)
        assertTrue(result.upcoming.isEmpty())
        assertEquals(listOf(tracks[0], tracks[2], tracks[3]), result.other)
    }

    @Test fun repeatOneDoesNotDuplicateCurrentTrack() {
        val result = queueDisplay(tracks, tracks[1].key, RepeatMode.ONE, true)
        assertTrue(result.upcoming.isEmpty())
        assertEquals(listOf(tracks[0], tracks[2], tracks[3]), result.other)
    }

    @Test fun missingCurrentAndEmptyQueueRemainUsable() {
        assertEquals(tracks, queueDisplay(tracks, null, RepeatMode.OFF, true).other)
        assertTrue(queueDisplay(emptyList(), null, RepeatMode.OFF, true).upcoming.isEmpty())
    }
}
