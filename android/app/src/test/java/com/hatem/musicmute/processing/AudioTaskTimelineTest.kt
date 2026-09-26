package com.hatem.musicmute.processing

import java.time.Instant
import org.junit.Assert.*
import org.junit.Test

class AudioTaskTimelineTest {
    private val job = Job("job", "processing", Instant.EPOCH, Instant.EPOCH,
        JobInput("mp3", 1000, 30.0), true, false,
        queuedAt = Instant.EPOCH,
        stages = JobStages(validatingAt = Instant.EPOCH, processingStartedAt = Instant.EPOCH))

    @Test fun serverMeasurementsDriveTimelineAndTotalWithoutClientElapsedTime() {
        val measurements = ServerStageTimings(6000, true, listOf(
            ServerStageMeasurement("queue", 1000, true),
            ServerStageMeasurement("input-download", 500, true),
            ServerStageMeasurement("separation", 3000, false),
            ServerStageMeasurement("output-upload", 500, true),
        ))
        val task = audioTaskPresentations(emptyList(), listOf(job.copy(
            status = "ready", serverStageTimings = measurements,
            timing = JobTiming(totalElapsedMs = 999999, totalElapsedApproximate = true),
        )), 9999999).single()
        assertEquals(6000L, task.totalElapsedMs)
        assertFalse(task.totalElapsedApproximate)
        val steps = audioTaskTimeline(task)
        assertEquals(1000L, steps.single { it.stage == AudioTaskStage.QUEUED }.measurement?.durationMs)
        assertEquals(false, steps.single { it.stage == AudioTaskStage.PROCESSING }.measurement?.complete)
        assertNull(steps.single { it.stage == AudioTaskStage.PREPARING_INPUT }.measurement)
    }

    @Test fun serverOutcomesRetainCompletedStepsWhenReopenedWithoutLocalOperation() {
        for ((status, outcome) in listOf(
            "interrupted" to AudioStepState.INTERRUPTED,
            "cancel_requested" to AudioStepState.INTERRUPTED,
            "failed" to AudioStepState.FAILED,
            "cancelled" to AudioStepState.CANCELLED,
        )) {
            val task = audioTaskPresentations(emptyList(), listOf(job.copy(status = status)), 0).single()
            val steps = audioTaskTimeline(task)
            assertEquals(status, listOf(
                AudioTaskStage.PREPARING_INPUT, AudioTaskStage.RESERVING_JOB,
                AudioTaskStage.UPLOADING_INPUT, AudioTaskStage.CONFIRMING_UPLOAD,
                AudioTaskStage.QUEUED, AudioTaskStage.VALIDATING,
            ), steps.filter { it.state == AudioStepState.COMPLETE }.map { it.stage })
            assertEquals(outcome, steps.single { it.stage == AudioTaskStage.PROCESSING }.state)
            assertEquals(AudioStepState.PENDING, steps.last().state)
        }
    }

    @Test fun uploadRetryRetainsCompletedPreparationAndReservation() {
        val operation = ProcessingOperation("operation", "owner", "request", jobId = "job",
            phase = ProcessingPhase.RETRY_WAIT, serverStatus = "awaiting_upload",
            uploadedBytes = 200, input = InputDeclaration("mp3", "audio/mpeg", 1000, 30.0, "hash"))
        val task = audioTaskPresentations(listOf(operation), emptyList(), 0).single()
        val steps = audioTaskTimeline(task)
        assertEquals(listOf(AudioStepState.COMPLETE, AudioStepState.COMPLETE, AudioStepState.INTERRUPTED),
            steps.take(3).map { it.state })
        assertFalse(steps.any { it.state == AudioStepState.CURRENT })
    }

    @Test fun completedByteTransferDoesNotInventConfirmedUpload() {
        val operation = ProcessingOperation("operation", "owner", "request", jobId = "job",
            phase = ProcessingPhase.PAUSED, serverStatus = "awaiting_upload",
            uploadedBytes = 1000, input = InputDeclaration("mp3", "audio/mpeg", 1000, 30.0, "hash"))
        val steps = audioTaskTimeline(audioTaskPresentations(listOf(operation), emptyList(), 0).single())
        assertEquals(AudioStepState.COMPLETE, steps.single { it.stage == AudioTaskStage.UPLOADING_INPUT }.state)
        assertEquals(AudioStepState.FAILED, steps.single { it.stage == AudioTaskStage.CONFIRMING_UPLOAD }.state)
        assertEquals(AudioStepState.PENDING, steps.single { it.stage == AudioTaskStage.QUEUED }.state)
    }

    @Test fun finishedProcessingTimestampPreservesProcessingCompletion() {
        val failed = job.copy(status = "failed", stages = job.stages!!.copy(processingFinishedAt = Instant.EPOCH))
        val steps = audioTaskTimeline(audioTaskPresentations(emptyList(), listOf(failed), 0).single())
        assertEquals(AudioStepState.COMPLETE, steps.single { it.stage == AudioTaskStage.PROCESSING }.state)
        assertEquals(AudioStepState.FAILED, steps.single { it.stage == AudioTaskStage.UPLOADING_RESULT }.state)
        assertEquals(AudioStepState.PENDING, steps.last().state)
    }

    @Test fun requeuedJobKeepsRecoveryStatusAndOnlyOneCurrentStep() {
        val steps = audioTaskTimeline(audioTaskPresentations(emptyList(), listOf(job.copy(status = "queued")), 0).single())
        assertEquals(listOf(AudioTaskStage.QUEUED), steps.filter { it.state == AudioStepState.CURRENT }.map { it.stage })
        assertEquals(AudioStepState.PENDING, steps.single { it.stage == AudioTaskStage.PROCESSING }.state)
    }

    @Test fun readyCompletesAllStepsAndOnlyUrlSourcesIncludeDownload() {
        val ready = audioTaskPresentations(emptyList(), listOf(job.copy(status = "ready")), 0).single()
        assertTrue(audioTaskTimeline(ready).all { it.state == AudioStepState.COMPLETE })
        assertFalse(audioTaskTimeline(ready).any { it.stage == AudioTaskStage.DOWNLOADING_SOURCE })
        val url = audioTaskTimeline(ready.copy(sourceKind = SourceKind.URL))
        assertEquals(AudioTaskStage.DOWNLOADING_SOURCE, url.first().stage)
        assertTrue(url.all { it.state == AudioStepState.COMPLETE })
    }

    @Test fun unknownStateDoesNotInventHistoryOrAnActiveStep() {
        val unknown = job.copy(status = "future_status", queuedAt = null, stages = null)
        val steps = audioTaskTimeline(audioTaskPresentations(emptyList(), listOf(unknown), 0).single())
        assertFalse(steps.any { it.state == AudioStepState.CURRENT })
        assertEquals(AudioStepState.PENDING, steps.last().state)
    }
}
