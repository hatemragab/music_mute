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

    @Test fun mostPlayedTabRanksOnlyPlayedVisibleTracksAndCombinesStarredSearch() {
        val entries = listOf(
            entry("never", "Voice new"),
            entry("b", "Voice second").copy(playCount = 3),
            entry("a", "Voice first").copy(playCount = 3),
            entry("popular", "Voice popular").copy(playCount = 8, starred = false),
            entry("hidden", "Voice hidden", hidden = true).copy(playCount = 99),
        )
        assertEquals(listOf("popular", "a", "b"), queryLibrary(entries, filter = LibraryFilter.MOST_PLAYED,
            sort = LibrarySort.TITLE).map { it.key.jobId })
        assertEquals(listOf("a", "b"), queryLibrary(entries, "VOICE", LibraryFilter.MOST_PLAYED,
            starredOnly = true).map { it.key.jobId })
    }

    @Test fun mostPlayedSortKeepsUnplayedTracksAndStarredCheckboxCombinesOtherTabs() {
        val entries = listOf(entry("unplayed", "Voice", true),
            entry("played", "Voice", true).copy(playCount = 2),
            entry("unstarred", "Voice", true).copy(playCount = 5, starred = false),
            entry("remote", "Voice").copy(playCount = 3))
        assertEquals(listOf("unstarred", "remote", "played", "unplayed"), queryLibrary(entries,
            sort = LibrarySort.MOST_PLAYED).map { it.key.jobId })
        assertEquals(listOf("played", "unplayed"), queryLibrary(entries, filter = LibraryFilter.DOWNLOADED,
            sort = LibrarySort.MOST_PLAYED, starredOnly = true).map { it.key.jobId })
    }
}
