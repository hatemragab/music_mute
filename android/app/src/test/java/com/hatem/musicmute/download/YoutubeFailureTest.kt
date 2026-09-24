package com.hatem.musicmute.download

import org.junit.Assert.*
import org.junit.Test

class YoutubeFailureTest {
    @Test fun temporaryFailuresRemainRetryable() {
        for (message in listOf("Connection reset", "Connection timed out")) {
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
        assertEquals("stage=download;extractor=2026.08.19;category=NETWORK;refusal=NONE;hint=NONE", failure.diagnostic)
        assertEquals(DownloadError.NETWORK, classifyDownloadError(failure))
        assertNull(failure.cause)
    }

    @Test fun refusalsNeverUseTheTransientRetryLoop() {
        val messages = mapOf(
            "HTTP Error 429: Too Many Requests" to SourceRefusal.RATE_LIMITED,
            "This content isn't available, try again later" to SourceRefusal.RATE_LIMITED,
            "HTTP Error 403: Forbidden" to SourceRefusal.FORBIDDEN,
            "Sign in to confirm you're not a bot" to SourceRefusal.AUTH_REQUIRED,
        )
        messages.forEach { (message, expected) ->
            assertEquals(expected, sourceRefusal(message))
            val reason = classifyDownloadError(Exception(message))
            assertEquals(DownloadError.UNAVAILABLE, reason)
            assertFalse(sourceRetryPlan(reason, 0, true, 0, 0.0).shouldRetry)
        }
        assertEquals(SourceRefusal.NONE, sourceRefusal("Video 403429 has no formats"))
    }

    @Test fun cooldownIsBoundedAcrossClockChangesAndRestart() {
        assertEquals(0L, sourceWaitMillis(1000, 1001))
        assertEquals(5000L, sourceWaitMillis(6000, 1000))
        assertEquals(SOURCE_COOLDOWN_MILLIS, sourceWaitMillis(Long.MAX_VALUE, 0))
    }

    @Test fun nativeWarningsBecomeAllowlistedHints() {
        assertEquals(SourceHint.PO_TOKEN, sourceHint("Missing PO Token for https://private.example?secret=abc"))
        assertEquals(SourceHint.JS_CHALLENGE, sourceHint("n challenge solving failed"))
        assertEquals(SourceHint.FORMAT_UNAVAILABLE, sourceHint("Requested format is not available"))
        val failure = YoutubeSourceFailure(DownloadError.UNAVAILABLE, "download", "2026.08.19",
            SourceRefusal.FORBIDDEN, SourceHint.PO_TOKEN)
        assertFalse(failure.diagnostic.contains("https"))
        assertNull(failure.cause)
    }
}
