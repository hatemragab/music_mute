package com.hatem.musicmute.playback

import com.hatem.musicmute.library.LibraryKey
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class QueueEditingTest {
    private val tracks = (0..4).map { QueueTrack(LibraryKey("owner", "$it"), "Same title", original = it == 3) }

    @Test fun movesBothDirectionsByIdentityWithoutLosingVariantsOrCurrent() {
        assertEquals(listOf(tracks[0], tracks[3], tracks[1], tracks[2], tracks[4]),
            editedQueue(tracks, tracks[0].key, QueueEdit.MOVE, tracks[3].key, tracks[1].key))
        assertEquals(listOf(tracks[0], tracks[2], tracks[3], tracks[1], tracks[4]),
            editedQueue(tracks, tracks[0].key, QueueEdit.MOVE, tracks[1].key, tracks[3].key))
    }

    @Test fun wrappedRepeatAllMovesFollowVisibleUpcomingOrder() {
        val result = editedQueue(tracks, tracks[2].key, QueueEdit.MOVE, tracks[3].key, tracks[0].key, wrap = true)!!
        assertEquals(listOf(tracks[2], tracks[4], tracks[0], tracks[3], tracks[1]), result)
        assertEquals(listOf(tracks[4], tracks[0], tracks[3], tracks[1]),
            queueDisplay(result, tracks[2].key, RepeatMode.ALL, true).upcoming)
    }

    @Test fun everyWrappedMoveMatchesTheDisplayedUpcomingOrder() {
        val shuffled = listOf(tracks[3], tracks[0], tracks[4], tracks[2], tracks[1])
        for (current in shuffled) {
            val upcoming = queueDisplay(shuffled, current.key, RepeatMode.ALL, true).upcoming
            for (from in upcoming.indices) for (to in upcoming.indices) {
                if (from == to) continue
                val expected = upcoming.toMutableList().apply { add(to, removeAt(from)) }
                val result = editedQueue(shuffled, current.key, QueueEdit.MOVE,
                    upcoming[from].key, upcoming[to].key, wrap = true)!!
                assertEquals(expected, queueDisplay(result, current.key, RepeatMode.ALL, true).upcoming)
                assertEquals(shuffled.toSet(), result.toSet())
                assertEquals(current, result.first())
            }
        }
    }

    @Test fun shuffledOrderBecomesExplicitWithoutChangingOtherRelativePositions() {
        val order = listOf(tracks[2], tracks[4], tracks[0], tracks[3], tracks[1])
        val result = editedQueue(order, tracks[2].key, QueueEdit.MOVE, tracks[1].key, tracks[4].key)
        assertEquals(listOf(tracks[2], tracks[1], tracks[4], tracks[0], tracks[3]), result)
    }

    @Test fun playNextCanPromoteEarlierTracksOrAppendAfterTheLastCurrentTrack() {
        assertEquals(listOf(tracks[1], tracks[2], tracks[0], tracks[3], tracks[4]),
            editedQueue(tracks, tracks[2].key, QueueEdit.PLAY_NEXT, tracks[0].key))
        assertEquals(listOf(tracks[0], tracks[2], tracks[3], tracks[4], tracks[1]),
            editedQueue(tracks, tracks[4].key, QueueEdit.PLAY_NEXT, tracks[1].key))
        val alreadyNext = editedQueue(tracks, tracks[0].key, QueueEdit.PLAY_NEXT, tracks[1].key)
        assertEquals(tracks, alreadyNext)
    }

    @Test fun staleOrForeignKeysAndCurrentTrackMovesAreRejected() {
        val missing = LibraryKey("other", "1")
        assertNull(editedQueue(tracks, tracks[0].key, QueueEdit.MOVE, missing, tracks[2].key))
        assertNull(editedQueue(tracks, tracks[0].key, QueueEdit.MOVE, tracks[1].key, missing))
        assertNull(editedQueue(tracks, tracks[0].key, QueueEdit.MOVE, tracks[0].key, tracks[2].key))
        assertNull(editedQueue(tracks, tracks[0].key, QueueEdit.MOVE, tracks[1].key, tracks[0].key))
        assertNull(editedQueue(tracks, null, QueueEdit.PLAY_NEXT, tracks[1].key))
        assertNull(editedQueue(tracks + tracks[1], tracks[0].key, QueueEdit.CLEAR))
        assertNull(editedQueue(emptyList(), null, QueueEdit.MOVE, tracks[1].key, tracks[2].key))
    }

    @Test fun clearingRetainsOnlyCurrentAudioOrEmptiesAnIdleQueue() {
        assertEquals(listOf(tracks[3]), editedQueue(tracks, tracks[3].key, QueueEdit.CLEAR))
        assertEquals(emptyList<QueueTrack>(), editedQueue(tracks, null, QueueEdit.CLEAR))
        assertEquals(listOf(tracks[3]), editedQueue(listOf(tracks[3]), tracks[3].key, QueueEdit.CLEAR))
        assertEquals(emptyList<QueueTrack>(), editedQueue(emptyList(), null, QueueEdit.CLEAR))
    }

    @Test fun editedOrderAndCurrentPositionSurviveCheckpointRestore() {
        val root = Files.createTempDirectory("edited-queue").toFile()
        try {
            val order = editedQueue(tracks, tracks[2].key, QueueEdit.MOVE, tracks[4].key, tracks[3].key)!!
            val snapshot = QueueSnapshot(order, order.indexOf(tracks[2]), 12_000, RepeatMode.OFF,
                shuffle = false, autoNext = true, order = order.indices.toList())
            PlaybackQueueStore(root).save("owner", snapshot)
            assertEquals(snapshot, PlaybackQueueStore(root).load("owner"))
        } finally { root.deleteRecursively() }
    }
}
