package com.hatem.musicmute.playback

import com.hatem.musicmute.library.LibraryKey
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class ListeningToolsTest {
    @Test fun carBrowsingHandlesUnpagedLegacyRequestsWithoutBinderOverflowOrLostTracks() {
        assertEquals(BrowseWindow(0, 199, 199), browseWindow(450, 0, 0, Int.MAX_VALUE))
        assertEquals(BrowseWindow(199, 199, 398), browseWindow(450, 199, 0, Int.MAX_VALUE))
        assertEquals(BrowseWindow(398, 52, null), browseWindow(450, 398, 0, Int.MAX_VALUE))
        assertEquals(BrowseWindow(40, 20, null), browseWindow(450, 0, 2, 20))
        assertEquals(BrowseWindow(450, 0, null), browseWindow(450, 0, Int.MAX_VALUE, Int.MAX_VALUE))
        assertNull(browseWindow(450, 0, -1, 20))
        assertNull(browseWindow(450, 0, 1, 0))
    }

    @Test fun loopsRejectShortReversedAndOutOfBoundsRanges() {
        assertFalse(AudioRange(-1, 600).valid(1000))
        assertFalse(AudioRange(800, 600).valid(1000))
        assertFalse(AudioRange(0, 499).valid(1000))
        assertFalse(AudioRange(500, 1500).valid(1000))
        assertTrue(AudioRange(500, 1000).valid(1000))
        assertNull(loopSeek(750, AudioRange(500, 1000), 2000))
        assertEquals(500L, loopSeek(1000, AudioRange(500, 1000), 2000))
        assertEquals(500L, loopSeek(499, AudioRange(500, 1000), 2000))
        assertNull(loopSeek(1000, AudioRange(500, 2000), 1000))
    }

    @Test fun sleepUsesBoundedMonotonicDeadlinesAndClipLimits() {
        assertEquals(910_000L, sleepDeadline(10_000, 15))
        assertNull(sleepDeadline(10_000, 0))
        assertNull(sleepDeadline(10_000, 181))
        assertTrue(clipRangeValid(AudioRange(500, 300_500), 400_000))
        assertFalse(clipRangeValid(AudioRange(0, 300_001), 400_000))
        assertFalse(clipRangeValid(AudioRange(0, 499), 400_000))
    }

    @Test fun bookmarksAreBoundedAtomicAndIsolatedByOwnerJobAndSource() {
        val root = Files.createTempDirectory("bookmarks").toFile()
        try {
            val store = BookmarkStore(root)
            val key = LibraryKey("owner/../one", "job/../one")
            store.save(key, false, listOf(AudioBookmark(4000, "  hello  "), AudioBookmark(-1, "bad"),
                AudioBookmark(1000, "x".repeat(100)), AudioBookmark(4000, "duplicate")))
            val marks = store.load(key, false)
            assertEquals(listOf(1000L, 4000L), marks.map { it.positionMs })
            assertEquals(80, marks.first().label.length)
            assertEquals("hello", marks.last().label)
            assertTrue(store.load(key, true).isEmpty())
            assertTrue(store.load(LibraryKey("two", key.jobId), false).isEmpty())
            assertTrue(store.load(LibraryKey(key.ownerUid, "two"), false).isEmpty())
            store.save(key, true, (0..150).map { AudioBookmark(it * 1000L, "mark") })
            assertEquals(100, store.load(key, true).size)
            store.clear(key.ownerUid)
            assertTrue(store.load(key, false).isEmpty())
            assertTrue(store.load(key, true).isEmpty())
        } finally { root.deleteRecursively() }
    }

    @Test fun corruptAndOversizedBookmarkFilesRecoverWithoutCrashing() {
        val root = Files.createTempDirectory("bookmarks-corrupt").toFile()
        try {
            val key = LibraryKey("one", "job")
            val store = BookmarkStore(root)
            store.save(key, false, listOf(AudioBookmark(1000, "hello")))
            val file = root.walk().first { it.extension == "json" }
            file.writeText("invalid")
            assertTrue(store.load(key, false).isEmpty())
            file.writeText(" ".repeat(64_001))
            assertTrue(store.load(key, false).isEmpty())
        } finally { root.deleteRecursively() }
    }
}
