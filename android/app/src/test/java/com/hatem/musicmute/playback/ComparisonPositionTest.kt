package com.hatem.musicmute.playback

import org.junit.Assert.assertEquals
import org.junit.Test

class ComparisonPositionTest {
    private val ranges = listOf(listOf(0L, 441000L), listOf(882000L, 1323000L))
    @Test fun untrimmedPreservesTheSameSecond() {
        assertEquals(12000L, comparisonPosition(12000, true, false, null))
        assertEquals(12000L, comparisonPosition(12000, false, false, null))
    }
    @Test fun trimmedSwitchMapsToMatchingSourceAudio() {
        assertEquals(22000L, comparisonPosition(12000, true, true, ranges))
        assertEquals(12000L, comparisonPosition(22000, false, true, ranges))
        assertEquals(10000L, comparisonPosition(15000, false, true, ranges))
        assertEquals(20000L, comparisonPosition(10000, true, true, ranges))
    }
    @Test(expected = IllegalArgumentException::class)
    fun oldTrimmedTrackCannotPretendToHaveAnAlignedTimeline() {
        comparisonPosition(12000, true, true, null)
    }
}
