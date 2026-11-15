package com.hatem.musicmute.library

import org.junit.Assert.assertEquals
import org.junit.Test

class LibraryQueryTest {
    private fun entry(id: String, title: String, offline: Boolean = false, hidden: Boolean = false) =
        LibraryEntry(LibraryKey("owner", id), title, 0, null, true, hidden,
            if (offline) OfflineStatus.AVAILABLE else OfflineStatus.REMOTE_ONLY)

    @Test fun queryAndOfflineFiltersDoNotExposeHiddenTracks() {
        val entries = listOf(entry("1", "صوت صباح", true), entry("2", "صوت مساء"), entry("3", "صوت مخفي", true, true))
        assertEquals(listOf("1"), queryLibrary(entries, " صوت ", LibraryFilter.DOWNLOADED).map { it.key.jobId })
        assertEquals(listOf("3"), queryLibrary(entries, "", LibraryFilter.REMOVED).map { it.key.jobId })
    }

    @Test fun searchIsCaseInsensitiveAndTitleOrderHasStableTies() {
        val entries = listOf(entry("2", "VOICE"), entry("1", "voice"), entry("3", "other"))
        assertEquals(listOf("1", "2"), queryLibrary(entries, "Voice", sort = LibrarySort.TITLE).map { it.key.jobId })
    }
}
