package com.hatem.musicmute.playback

import com.hatem.musicmute.library.LibraryKey
import com.hatem.musicmute.processing.ClientErrorCode
import com.hatem.musicmute.processing.JobsFailure
import com.hatem.musicmute.processing.JobsProblem
import java.nio.file.Files
import com.hatem.musicmute.processing.ProcessingSession
import java.io.IOException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class PlaybackQueueTest {
    private val tracks = (0..3).map { QueueTrack(LibraryKey("owner", "$it"), "Track $it") }

    @Test fun upNextUsesActualShuffleOrderAndAutomaticPlaybackPolicy() {
        val shuffled = listOf(tracks[2], tracks[0], tracks[3], tracks[1])
        assertEquals(listOf(tracks[3], tracks[1]), upcomingTracks(shuffled, tracks[0].key, RepeatMode.OFF, true))
        assertEquals(emptyList<QueueTrack>(), upcomingTracks(shuffled, tracks[1].key, RepeatMode.OFF, true))
        assertEquals(listOf(tracks[2], tracks[0]), upcomingTracks(shuffled, tracks[1].key, RepeatMode.ALL, true))
        assertEquals(emptyList<QueueTrack>(), upcomingTracks(shuffled, tracks[0].key, RepeatMode.ALL, false))
        assertEquals(listOf(tracks[0]), upcomingTracks(shuffled, tracks[0].key, RepeatMode.ONE, false))
        assertEquals(emptyList<QueueTrack>(), upcomingTracks(shuffled, LibraryKey("other", "0"), RepeatMode.ALL, true))
    }

    @Test fun coldServiceWaitsForOwnerAndCheckpointRestoreBeforeSavingEmptyQueue() {
        val gate = OwnerQueueRestore()
        assertFalse(gate.canCheckpoint(null))
        val owner = ProcessingSession("owner", 1)
        assertTrue(gate.attach(owner))
        assertFalse(gate.canCheckpoint(owner))
        assertFalse(gate.attach(owner))
        gate.restored(owner)
        assertTrue(gate.canCheckpoint(owner))
        val nextEpoch = owner.copy(epoch = 2)
        assertTrue(gate.attach(nextEpoch))
        gate.restored(owner) // A superseded disk read must not open the new owner's gate.
        assertFalse(gate.canCheckpoint(nextEpoch))
        gate.restored(nextEpoch)
        assertTrue(gate.canCheckpoint(nextEpoch))
        gate.attach(null)
        assertFalse(gate.canCheckpoint(nextEpoch))
    }

    @Test fun endPrecedenceAndManualNavigation() {
        assertEquals(2, queueNextIndex(2, 4, RepeatMode.ONE, false))
        assertEquals(-1, queueNextIndex(2, 4, RepeatMode.ALL, false))
        assertEquals(3, queueNextIndex(2, 4, RepeatMode.OFF, true))
        assertEquals(-1, queueNextIndex(3, 4, RepeatMode.OFF, true))
        assertEquals(0, queueNextIndex(3, 4, RepeatMode.ALL, true))
        assertEquals(3, queueNextIndex(2, 4, RepeatMode.ONE, false, manual = true))
        assertEquals(2, queuePreviousIndex(2, 4000))
        assertEquals(1, queuePreviousIndex(2, 2999))
    }

    @Test fun missingTraversalCannotLoopEvenWithRepeatAll() {
        assertEquals(listOf(3, 0, 1), unavailableCandidates(2, listOf(0, 1, 2, 3), RepeatMode.ALL))
        assertEquals(emptyList<Int>(), unavailableCandidates(2, listOf(0, 1, 2, 3), RepeatMode.ONE))
        assertEquals(listOf(3), unavailableCandidates(2, listOf(0, 1, 2, 3), RepeatMode.OFF))
    }

    @Test fun shuffleStableContainsEveryTrackAndPreservesCurrent() {
        val order = queueOrder(4, true, 42, 2)
        assertEquals(order, queueOrder(4, true, 42, 2))
        assertEquals(2, order.first())
        assertEquals((0..3).toSet(), order.toSet())
    }

    @Test fun persistenceIsOwnerScopedAndRestoresPositionWithoutPlaybackFlag() {
        val root = Files.createTempDirectory("queue-test").toFile()
        try {
            val store = PlaybackQueueStore(root)
            store.save("owner", QueueSnapshot(tracks, 2, -50, RepeatMode.ALL, true, false, 42, listOf(2, 0, 3, 1)))
            val restored = PlaybackQueueStore(root).load("owner")!!
            assertEquals(0L, restored.positionMs)
            assertEquals(tracks, restored.tracks)
            assertEquals(listOf(2, 0, 3, 1), restored.order)
            assertFalse(restored.autoNext)
            assertNull(store.load("other"))
            store.save("owner", QueueSnapshot(listOf(QueueTrack(LibraryKey("other", "1"), "bad"))))
            assertEquals(tracks, store.load("owner")!!.tracks)
            store.clear("owner")
            assertNull(store.load("owner"))
        } finally { root.deleteRecursively() }
    }

    @Test fun ownerEpochChangeDuringAcquisitionCannotReturnFile() = runTest {
        val root = Files.createTempDirectory("queue-owner").toFile()
        val file = root.resolve("audio.wav").apply { writeBytes(byteArrayOf(1)) }
        val expected = ProcessingSession("owner", 1)
        var current = expected
        try {
            try {
                resolveQueueFile(LibraryKey("owner", "1"), expected, { current }) {
                    current = expected.copy(epoch = 2)
                    file
                }
                fail("An expired owner epoch returned private audio")
            } catch (_: IOException) { }
        } finally { root.deleteRecursively() }
    }

    @Test fun wrongOwnerDoesNotStartAcquisitionAndIncompleteFileIsRejected() = runTest {
        val expected = ProcessingSession("owner", 1)
        var calls = 0
        try {
            resolveQueueFile(LibraryKey("other", "1"), expected, { expected }) { calls++; error("Must not acquire") }
            fail("Foreign owner accepted")
        } catch (_: IOException) { }
        assertEquals(0, calls)
        val root = Files.createTempDirectory("queue-empty").toFile()
        try {
            val empty = root.resolve("empty").apply { createNewFile() }
            try {
                resolveQueueFile(LibraryKey("owner", "1"), expected, { expected }) { empty }
                fail("Empty file accepted")
            } catch (_: IOException) { }
        } finally { root.deleteRecursively() }
    }

    @Test fun playbackFailureClassificationIsStructuredAndDoesNotExposeCauseMessages() {
        val secret = "https://storage.example/output?token=private"
        val error = IOException(
            "Audio unavailable: $secret",
            JobsFailure(JobsProblem.SERVICE_UNAVAILABLE),
        )

        val diagnostic = classifyPlaybackFailure(error)

        assertEquals(PlaybackFailureSource.JOB_API, diagnostic.source)
        assertEquals(ClientErrorCode.SERVER, diagnostic.code)
        assertTrue(diagnostic.retryable)
        assertEquals("JobsFailure", diagnostic.causeType)
        assertFalse(diagnostic.toString().contains(secret))
    }
}
