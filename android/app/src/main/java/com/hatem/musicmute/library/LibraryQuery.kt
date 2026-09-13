package com.hatem.musicmute.library

import java.util.Locale

fun queryLibrary(
    entries: List<LibraryEntry>,
    query: String = "",
    filter: LibraryFilter = LibraryFilter.ALL,
    sort: LibrarySort = LibrarySort.NEWEST,
): List<LibraryEntry> {
    val needle = query.trim().lowercase(Locale.ROOT)
    val matching = entries.filter { entry ->
        (if (filter == LibraryFilter.REMOVED) entry.hidden else !entry.hidden) &&
            entry.title.lowercase(Locale.ROOT).contains(needle) &&
            when (filter) {
                LibraryFilter.STARRED -> entry.starred
                LibraryFilter.DOWNLOADED -> entry.offlineStatus == OfflineStatus.AVAILABLE
                LibraryFilter.NOT_DOWNLOADED -> entry.offlineStatus != OfflineStatus.AVAILABLE
                else -> true
            }
    }
    return when (sort) {
        LibrarySort.NEWEST -> matching.sortedWith(compareByDescending<LibraryEntry> { it.createdAtEpochMs }.thenBy { it.key.jobId })
        LibrarySort.TITLE -> matching.sortedWith(compareBy<LibraryEntry> { it.title.lowercase(Locale.ROOT) }.thenBy { it.key.jobId })
    }
}
