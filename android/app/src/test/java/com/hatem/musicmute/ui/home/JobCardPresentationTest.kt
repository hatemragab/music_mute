package com.hatem.musicmute.ui.home

import com.hatem.musicmute.processing.AudioTaskStage
import com.hatem.musicmute.processing.Job
import com.hatem.musicmute.processing.JobInput
import com.hatem.musicmute.processing.UrlImportRecord
import com.hatem.musicmute.processing.audioTaskPresentations
import java.time.Instant
import org.junit.Assert.*
import org.junit.Test

class JobCardPresentationTest {
    @Test fun importFailuresOnlyOfferActionsAllowedByTheirRecoveryPolicy() {
        val record = UrlImportRecord("preview", "https://example.com/audio", "request",
            status = "failed", errorCode = "IMPORT_DEPENDENCY_FAILED")
        val retryable = audioTaskPresentations(emptyList(), emptyList(), 0, listOf(record)).single()
        assertEquals(listOf(JobCardAction.RETRY, JobCardAction.DELETE), jobCardActions(retryable))
        val nonRetryable = audioTaskPresentations(emptyList(), emptyList(), 0,
            listOf(record.copy(errorCode = "IMPORT_INVALID_AUDIO"))).single()
        assertEquals(listOf(JobCardAction.DELETE), jobCardActions(nonRetryable))
        assertTrue(jobCardActions(nonRetryable.copy(canDelete = false)).isEmpty())
    }

    @Test fun historyKeepsLocalRecoveryActionsWithoutAddingUnsupportedHomeCommands() {
        val task = task("failed").copy(canRetry = true, canDelete = true)
        assertTrue(jobCardActions(task).isEmpty())
        assertEquals(listOf(JobCardAction.RETRY, JobCardAction.DELETE), jobCardActions(task, allTaskActions = true))
        assertEquals(listOf(JobCardAction.CANCEL), jobCardActions(task("processing")))
        assertTrue(jobCardActions(task("cancel_requested")).isEmpty())
    }

    @Test fun queuedPausedAndTerminalStatesNeverShowMeasuredProcessingProgress() {
        val processing = task("processing").copy(progressFraction = 0.6f)
        assertEquals(0.6f, jobCardProgress(processing))
        assertNull(jobCardProgress(processing.copy(stage = AudioTaskStage.QUEUED)))
        assertNull(jobCardProgress(processing.copy(stage = AudioTaskStage.WAITING)))
        assertNull(jobCardProgress(processing.copy(stage = AudioTaskStage.CANCELLING)))
        assertNull(jobCardProgress(processing.copy(workerAvailable = false)))
        assertNull(jobCardProgress(processing.copy(active = false)))
        assertNull(jobCardProgress(processing.copy(stage = AudioTaskStage.READY, active = false)))
    }

    @Test fun phaseProgressRejectsNonFiniteValuesAndBoundsTransferAndProcessingPercentages() {
        val task = task("processing")
        for (fraction in listOf(Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY)) {
            assertNull(jobCardProgress(task.copy(progressFraction = fraction)))
        }
        assertEquals(0f, jobCardProgress(task.copy(progressFraction = -0.1f)))
        assertEquals(1f, jobCardProgress(task.copy(progressFraction = 1.2f)))
        assertEquals(0.4f, jobCardProgress(task.copy(stage = AudioTaskStage.UPLOADING_INPUT, progressFraction = 0.4f)))
        assertEquals(0.8f, jobCardProgress(task.copy(stage = AudioTaskStage.UPLOADING_RESULT, progressFraction = 0.8f)))
    }

    private fun task(status: String) = audioTaskPresentations(emptyList(), listOf(Job(
        id = "68c000000000000000000001", status = status,
        createdAt = Instant.EPOCH, updatedAt = Instant.EPOCH,
        input = JobInput("mp3", 1000, 180.0), canDownloadInput = false, canDownloadOutput = false,
    )), 0).single()
}
