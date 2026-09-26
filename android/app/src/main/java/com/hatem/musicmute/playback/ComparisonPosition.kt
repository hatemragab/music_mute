package com.hatem.musicmute.playback

/** Map retained 44.1 kHz source intervals; removed gaps snap to the next retained sample. */
internal fun comparisonPosition(positionMs: Long, toOriginal: Boolean, trimmed: Boolean, ranges: List<List<Long>>?): Long {
    if (!trimmed) return positionMs.coerceAtLeast(0)
    require(!ranges.isNullOrEmpty()) { "This older trimmed track has no comparison timeline" }
    var previousEnd = 0L
    var outputStart = 0L
    val sample = positionMs.coerceAtLeast(0) * 44100 / 1000
    for (range in ranges) {
        require(range.size == 2 && range[0] >= previousEnd && range[1] > range[0] && range[1] <= 52920000)
        val length = range[1] - range[0]
        if (toOriginal && sample < outputStart + length)
            return (range[0] + (sample - outputStart).coerceAtLeast(0)) * 1000 / 44100
        if (!toOriginal && sample < range[1])
            return (outputStart + (sample - range[0]).coerceIn(0, length)) * 1000 / 44100
        previousEnd = range[1]
        outputStart += length
    }
    return (if (toOriginal) previousEnd else outputStart) * 1000 / 44100
}
