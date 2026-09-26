package com.hatem.musicmute.playback

import com.hatem.musicmute.library.LibraryKey
import kotlinx.coroutines.flow.asFlow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

class PlaybackObservationTest {
    @Test fun positionTicksAndSeeksDoNotReachControlObservers() = runTest {
        val track = QueueTrack(LibraryKey("owner", "job"), "Audio")
        val playing = PlaybackState(trackId = "job", queue = listOf(track), currentIndex = 0,
            playing = true, durationMs = 120_000)
        val states = listOf(playing) + (1..100).map { playing.copy(positionMs = it * 500L) } +
            listOf(playing.copy(positionMs = 90_000), playing.copy(positionMs = 1_000))
        assertEquals(listOf(playing), states.asFlow().controls().toList())
        assertEquals(1_000L, states.last().positionMs)
    }

    @Test fun controlsRetainPauseBufferingErrorsTimelineQueueAndModeChanges() = runTest {
        val track = QueueTrack(LibraryKey("owner", "job"), "Audio")
        val playing = PlaybackState(trackId = "job", queue = listOf(track), currentIndex = 0,
            playing = true, durationMs = 120_000, positionMs = 10_000)
        val changes = listOf(
            playing,
            playing.copy(playing = false),
            playing.copy(buffering = true),
            playing.copy(failed = true),
            playing.copy(durationMs = 60_000),
            playing.copy(switching = true),
            playing.copy(original = true),
            playing.copy(comparisonFailed = true),
            playing.copy(queue = listOf(track.copy(title = "Renamed"))),
            playing.copy(currentIndex = 1),
            playing.copy(orderedQueue = listOf(track)),
            playing.copy(shuffle = true),
            playing.copy(repeatMode = RepeatMode.ONE),
            playing.copy(autoNext = false),
            playing.copy(speed = 1.5f),
            playing.copy(volume = 0.5f),
            PlaybackState(),
        )
        assertEquals(changes.map { it.copy(positionMs = 0) }, changes.asFlow().controls().toList())
    }
}
