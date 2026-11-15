package com.hatem.musicmute.playback

import com.hatem.musicmute.library.LibraryKey

/** A play starts on selection/transition/repeat, and is credited only once audio is playing. */
internal class PlaybackPlayCounter {
    private var current: LibraryKey? = null
    private var pending: LibraryKey? = null
    private var requested: LibraryKey? = null

    fun requestStart(key: LibraryKey) { requested = key }

    fun transitioned(key: LibraryKey?, repeated: Boolean = false) {
        if (key != current || repeated) {
            current = key
            pending = key
        }
        selectionApplied(key)
    }

    /** Only an explicitly selected track consumes a seek; ordinary seeks never count. */
    fun selectionApplied(key: LibraryKey?) {
        if (key != null && requested == key) {
            current = key
            pending = key
            requested = null
        }
    }

    fun loopRestarted(key: LibraryKey?) { if (key != null && key == current) pending = key }

    /** Resuming a paused checkpoint continues the existing play rather than adding one. */
    fun restored(key: LibraryKey?) { current = key; pending = null; requested = null }

    fun playing(key: LibraryKey?, isPlaying: Boolean): LibraryKey? {
        if (key != current) transitioned(key)
        if (!isPlaying || key == null || key != pending) return null
        pending = null
        return key
    }

    fun clear() { current = null; pending = null; requested = null }
}
