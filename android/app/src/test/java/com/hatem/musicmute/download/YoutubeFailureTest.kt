package com.hatem.musicmute.download

import org.junit.Assert.*
import org.junit.Test

class YoutubeFailureTest {
    @Test fun temporaryFailuresRemainRetryable() {
        for (message in listOf("HTTP Error 403: Forbidden", "HTTP Error 429: Too Many Requests",
            "This content isn't available, try again later", "Requested format is not available")) {
            val reason = classifyDownloadError(Exception(message))
            assertTrue(message, sourceRetryPlan(reason, 0, true, 0, 0.0).shouldRetry)
            assertFalse(message, sourceRetryPlan(reason, 3, true, 0, 0.0).shouldRetry)
        }
    }

    @Test fun privateAndLoginRestrictionsAreNotRetried() {
        for (message in listOf("Private video", "Sign in to confirm your age", "Video unavailable. This video has been removed")) {
            assertEquals(DownloadError.UNAVAILABLE, classifyDownloadError(Exception(message)))
        }
    }

    @Test fun arbitraryVideoTitlesDoNotClassifyAsStorageFailures() {
        assertEquals(DownloadError.ENGINE, classifyDownloadError(Exception("Unable to extract title: space adventures")))
    }

    @Test fun diagnosticContainsOnlyStageVersionAndCategory() {
        val failure = YoutubeSourceFailure(DownloadError.NETWORK, "download", "2026.08.19")
        assertEquals("stage=download;extractor=2026.08.19;category=NETWORK", failure.diagnostic)
        assertEquals(DownloadError.NETWORK, classifyDownloadError(failure))
        assertNull(failure.cause)
    }
}
