package com.hatem.musicmute.library

import java.util.Locale

fun queryLibrary(
    entries: List<LibraryEntry>,
    query: String = "",
    filter: LibraryFilter = LibraryFilter.ALL,
    sort: LibrarySort = LibrarySort.NEWEST,
    starredOnly: Boolean = false,
): List<LibraryEntry> {
    val needle = query.trim().lowercase(Locale.ROOT)
    val matching = entries.filter { entry ->
        (if (filter == LibraryFilter.REMOVED) entry.hidden else !entry.hidden) &&
            entry.title.lowercase(Locale.ROOT).contains(needle) &&
            (!starredOnly || entry.starred) &&
            when (filter) {
                LibraryFilter.STARRED -> entry.starred
                LibraryFilter.MOST_PLAYED -> entry.playCount > 0
                LibraryFilter.DOWNLOADED -> entry.offlineStatus == OfflineStatus.AVAILABLE
                LibraryFilter.NOT_DOWNLOADED -> entry.offlineStatus != OfflineStatus.AVAILABLE
                else -> true
            }
    }
    return when (if (filter == LibraryFilter.MOST_PLAYED) LibrarySort.MOST_PLAYED else sort) {
        LibrarySort.NEWEST -> matching.sortedWith(compareByDescending<LibraryEntry> { it.createdAtEpochMs }.thenBy { it.key.jobId })
        LibrarySort.TITLE -> matching.sortedWith(compareBy<LibraryEntry> { it.title.lowercase(Locale.ROOT) }.thenBy { it.key.jobId })
        LibrarySort.MOST_PLAYED -> matching.sortedWith(compareByDescending<LibraryEntry> { it.playCount.coerceAtLeast(0) }
            .thenByDescending { it.createdAtEpochMs }.thenBy { it.key.jobId })
    }
}
