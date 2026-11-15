package com.hatem.musicmute.download

import org.junit.Assert.*
import org.junit.Test

class SourceDownloadBoundsTest {
    @Test fun reportedByteOverflowRemainsOversizedAfterFilesAreRemoved() {
        val bounds = SourceDownloadBounds(100, 10)
        assertFalse(bounds.check(101, 2))
        assertFalse(bounds.check(0, 3))
        assertEquals(SourceBound.BYTES, bounds.failure)
    }

    @Test fun deadlineDoesNotImplyOversizedMedia() {
        val bounds = SourceDownloadBounds(100, 10)
        assertTrue(bounds.check(100, 9))
        assertFalse(bounds.check(100, 10))
        assertEquals(SourceBound.DEADLINE, bounds.failure)
    }
}
