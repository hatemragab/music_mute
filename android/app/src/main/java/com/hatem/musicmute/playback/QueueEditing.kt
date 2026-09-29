package com.hatem.musicmute.playback

import com.hatem.musicmute.library.LibraryKey

internal const val EDIT_QUEUE_COMMAND = "com.hatem.musicmute.EDIT_QUEUE"
internal enum class QueueEdit { MOVE, PLAY_NEXT, CLEAR }

/** Identity-based edits use the real traversal order, even when shuffle/repeat-all wraps it. */
internal fun editedQueue(
    order: List<QueueTrack>, current: LibraryKey?, edit: QueueEdit,
    key: LibraryKey? = null, target: LibraryKey? = null, wrap: Boolean = false,
): List<QueueTrack>? {
    if (order.map { it.key }.distinct().size != order.size) return null
    if (edit == QueueEdit.CLEAR) return order.filter { it.key == current }
    val currentIndex = order.indexOfFirst { it.key == current }
    val traversal = if (wrap && currentIndex >= 0) order.drop(currentIndex) + order.take(currentIndex) else order
    val from = traversal.indexOfFirst { it.key == key }
    if (from < 0 || key == current) return null
    val result = traversal.toMutableList()
    when (edit) {
        QueueEdit.MOVE -> {
            val to = traversal.indexOfFirst { it.key == target }
            if (to < 0 || target == current || from == to) return null
            result.add(to, result.removeAt(from))
        }
        QueueEdit.PLAY_NEXT -> {
            if (order.none { it.key == current }) return null
            val track = result.removeAt(from)
            result.add(result.indexOfFirst { it.key == current } + 1, track)
        }
        QueueEdit.CLEAR -> Unit
    }
    return result
}
