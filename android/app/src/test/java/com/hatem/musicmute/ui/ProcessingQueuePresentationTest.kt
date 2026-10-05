package com.hatem.musicmute.ui

import com.hatem.musicmute.R
import com.hatem.musicmute.processing.Job
import com.hatem.musicmute.processing.JobInput
import com.hatem.musicmute.processing.JobStatus
import com.hatem.musicmute.processing.ProcessingQueue
import com.hatem.musicmute.processing.RealtimeState
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ProcessingQueuePresentationTest {
    @Test fun validLiveWaitingPositionShowsTheJobRank() {
        for (position in listOf(1, 4, 99)) {
            assertEquals(
                ProcessingQueuePresentation(R.string.realtime_queue_position, position),
                processingQueuePresentation(job(queue(position = position)), RealtimeState.LIVE),
            )
        }
    }

    @Test fun everyNonLiveStateHidesTheCachedPosition() {
        for (connection in RealtimeState.entries.filter { it != RealtimeState.LIVE }) {
            assertEquals(
                ProcessingQueuePresentation(R.string.realtime_reconnecting),
                processingQueuePresentation(job(queue(position = 1)), connection),
            )
        }
    }

    @Test fun invalidOrMissingPositionNeverDisplaysARank() {
        for (position in listOf(null, 0, -1)) {
            assertEquals(
                ProcessingQueuePresentation(R.string.realtime_queue_unavailable),
                processingQueuePresentation(job(queue(position = position)), RealtimeState.LIVE),
            )
        }
    }

    @Test fun blockedAndUnavailableStatesNeverDisplayAStaleRank() {
        for (state in listOf("blocked", "unavailable", "not_queued", "unknown")) {
            assertEquals(
                ProcessingQueuePresentation(R.string.realtime_queue_unavailable),
                processingQueuePresentation(job(queue(state = state, position = 3)), RealtimeState.LIVE),
            )
        }
    }

    @Test fun blockedReasonsRetainTheirLocalizedExplanation() {
        val reasons = mapOf(
            "account_capacity" to R.string.realtime_account_wait,
            "retry_backoff" to R.string.realtime_retry_wait,
            "processing_paused" to R.string.realtime_processing_paused,
            "worker_unavailable" to R.string.realtime_worker_wait,
            "account_restricted" to R.string.realtime_queue_unavailable,
            "eligibility_unavailable" to R.string.realtime_queue_unavailable,
            "unknown" to R.string.realtime_queue_unavailable,
            null to R.string.realtime_queue_unavailable,
        )
        for ((reason, textRes) in reasons) {
            assertEquals(
                ProcessingQueuePresentation(textRes),
                processingQueuePresentation(job(queue(state = "blocked", position = 3, reason = reason)), RealtimeState.LIVE),
            )
        }
    }

    @Test fun missingQueueShowsUnavailableOnlyForQueuedJobs() {
        assertEquals(
            ProcessingQueuePresentation(R.string.realtime_queue_unavailable),
            processingQueuePresentation(job(null), RealtimeState.LIVE),
        )
        assertNull(processingQueuePresentation(null, RealtimeState.LIVE))
        for (status in JobStatus.entries.filter { it != JobStatus.QUEUED }.map { it.wireValue } + "unknown") {
            for (connection in RealtimeState.entries) {
                assertNull(processingQueuePresentation(job(queue(position = 1)).copy(status = status), connection))
            }
        }
    }

    private fun queue(state: String = "waiting", position: Int? = null, reason: String? = null) =
        ProcessingQueue(state = state, position = position, reason = reason, asOf = "2026-10-01T00:00:00Z")

    private fun job(queue: ProcessingQueue?) = Job(
        id = "job",
        status = "queued",
        createdAt = Instant.EPOCH,
        updatedAt = Instant.EPOCH,
        input = JobInput(extension = "mp3", bytes = 1_000, durationSeconds = 16.0),
        canDownloadInput = false,
        canDownloadOutput = false,
        queue = queue,
    )
}
