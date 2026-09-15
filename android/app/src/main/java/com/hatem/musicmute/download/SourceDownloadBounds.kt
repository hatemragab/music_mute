package com.hatem.musicmute.download

import java.util.concurrent.atomic.AtomicReference

internal enum class SourceBound { BYTES, DEADLINE }

/** Sticky across native process cleanup and concurrent progress/watchdog callbacks. */
internal class SourceDownloadBounds(private val maxBytes: Long, private val deadlineSeconds: Long) {
    private val exceeded = AtomicReference<SourceBound?>(null)
    val failure: SourceBound? get() = exceeded.get()

    fun check(bytes: Long, elapsedSeconds: Long): Boolean {
        if (bytes > maxBytes) exceeded.set(SourceBound.BYTES)
        else if (elapsedSeconds >= deadlineSeconds) exceeded.compareAndSet(null, SourceBound.DEADLINE)
        return failure == null
    }
}
