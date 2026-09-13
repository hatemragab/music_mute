package com.hatem.musicmute.download

import com.hatem.musicmute.processing.*
import org.junit.Assert.*
import org.junit.Test

class YouTubePreflightTest {
    @Test(expected = JobsFailure::class) fun playlistContextRejected() { YouTubePreflight.validateUrl("https://youtube.com/watch?v=abcdefghijk&list=PL123") }
    @Test(expected = JobsFailure::class) fun liveShortVideoRejected() { YouTubePreflight.validateMetadata("""{"is_live":true,"duration":100}""", 1800.0) }
    @Test(expected = JobsFailure::class) fun missingDurationRejected() { YouTubePreflight.validateMetadata("{}", 1800.0) }
    @Test fun inclusiveBoundary() { assertEquals(1800.0, YouTubePreflight.validateMetadata("""{"duration":1800,"is_live":false}""", 1800.0), 0.0) }
    @Test(expected = JobsFailure::class) fun realExcessRejected() { YouTubePreflight.validateMetadata("""{"duration":1800.001}""", 1800.0) }
    @Test fun actualDownloadBytesDoNotNeedContentLength() {
        assertTrue(withinSourceDownloadBounds(100, 5, 100, 10))
        assertFalse(withinSourceDownloadBounds(101, 5, 100, 10))
        assertFalse(withinSourceDownloadBounds(1, 10, 100, 10))
    }
}
