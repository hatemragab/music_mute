package com.hatem.musicmute.playback

import com.hatem.musicmute.library.LibraryKey

internal data class QueueDisplay(val upcoming: List<QueueTrack>, val other: List<QueueTrack>)

/** Keep the current track separate and retain access to every queued item. */
internal fun queueDisplay(
    order: List<QueueTrack>, current: LibraryKey?, repeat: RepeatMode, autoNext: Boolean,
): QueueDisplay {
    val upcoming = upcomingTracks(order, current, repeat, autoNext, order.size)
        .filter { it.key != current }
    val upcomingKeys = upcoming.mapTo(mutableSetOf()) { it.key }
    return QueueDisplay(upcoming, order.filter { it.key != current && it.key !in upcomingKeys })
}
