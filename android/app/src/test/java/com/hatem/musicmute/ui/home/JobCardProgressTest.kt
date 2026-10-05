package com.hatem.musicmute.ui.home

import com.hatem.musicmute.processing.AudioTaskStage
import com.hatem.musicmute.processing.Job
import com.hatem.musicmute.processing.JobInput
import com.hatem.musicmute.processing.JobsProblem
import com.hatem.musicmute.processing.ProcessingLocalProblem
import com.hatem.musicmute.processing.audioTaskPresentations
import java.time.Instant
import org.junit.Assert.*
import org.junit.Test

class JobCardProgressTest {
    @Test
    fun onlyWorkStagesHaveEstimatedProgressPacing() {
        val eligible = setOf(
            AudioTaskStage.DOWNLOADING_SOURCE, AudioTaskStage.INSPECTING,
            AudioTaskStage.PREPARING_INPUT, AudioTaskStage.RESERVING_JOB,
            AudioTaskStage.UPLOADING_INPUT, AudioTaskStage.CONFIRMING_UPLOAD,
            AudioTaskStage.VALIDATING, AudioTaskStage.PROCESSING, AudioTaskStage.UPLOADING_RESULT,
        )
        AudioTaskStage.entries.forEach { stage ->
            assertEquals(stage.name, stage in eligible, jobCardStagePacingMs(stage) != null)
            assertEquals(stage.name, stage in eligible, jobCardEstimatedProgress(task().copy(stage = stage), 1_000) != null)
        }
    }

    @Test
    fun estimateStartsAtEightPercentAndRemainsMonotonicFiniteAndBelowCompletion() {
        val elapsedSamples = listOf(-1L, 0L, 300L, 1_000L, 5_000L, 30_000L, 120_000L, 1_000_000L, Long.MAX_VALUE)
        AudioTaskStage.entries.filter { jobCardStagePacingMs(it) != null }.forEach { stage ->
            val current = task().copy(stage = stage)
            assertEquals(0.08f, jobCardEstimatedProgress(current, 0)!!, 0.000001f)
            var previous = 0f
            elapsedSamples.forEach { elapsed ->
                val estimated = jobCardEstimatedProgress(current, elapsed)!!
                assertTrue("$stage at $elapsed", estimated.isFinite() && estimated >= previous && estimated <= 0.94f)
                previous = estimated
            }
            assertEquals(0.94f, previous, 0.000001f)
        }
    }

    @Test
    fun curveUsesEachStagesLocalPacingWithoutAggregateOrAudioElapsed() {
        AudioTaskStage.entries.filter { jobCardStagePacingMs(it) != null }.forEach { stage ->
            val current = task().copy(stage = stage, totalElapsedMs = 1_000_000L, processingElapsedMs = 800_000L)
            val estimate = jobCardEstimatedProgress(current, jobCardStagePacingMs(stage)!!)!!
            assertEquals(0.62362f, estimate, 0.00001f)
            assertEquals(estimate, jobCardEstimatedProgress(current.copy(totalElapsedMs = null, processingElapsedMs = null),
                jobCardStagePacingMs(stage)!!)!!, 0.000001f)
        }
        assertTrue(jobCardEstimatedProgress(task().copy(stage = AudioTaskStage.RESERVING_JOB), 5_000)!! >
            jobCardEstimatedProgress(task().copy(stage = AudioTaskStage.PROCESSING), 5_000)!!)
    }

    @Test
    fun queuedWaitingBlockedInactiveAndTerminalTasksNeverGetFakePercentages() {
        val current = task()
        for (stage in listOf(AudioTaskStage.WAITING, AudioTaskStage.QUEUED, AudioTaskStage.READY,
            AudioTaskStage.FAILED, AudioTaskStage.CANCELLED, AudioTaskStage.CANCELLING, AudioTaskStage.INTERRUPTED)) {
            assertNull(stage.name, jobCardStageProgressValue(current.copy(stage = stage), 30_000))
        }
        assertNull(jobCardStageProgressValue(current.copy(active = false), 30_000))
        assertNull(jobCardStageProgressValue(current.copy(workerAvailable = false), 30_000))
        assertNull(jobCardStageProgressValue(current.copy(problem = JobsProblem.OFFLINE), 30_000))
        assertNull(jobCardStageProgressValue(current.copy(localProblem = ProcessingLocalProblem.TRANSFER), 30_000))
        assertNull(jobCardStageProgressValue(current.copy(errorCode = "SEPARATOR_FAILED"), 30_000))
    }

    @Test
    fun genuinePhaseProgressAlwaysReplacesTheEstimateIncludingZeroAndCompleteTransfers() {
        for (stage in listOf(AudioTaskStage.UPLOADING_INPUT, AudioTaskStage.PROCESSING, AudioTaskStage.UPLOADING_RESULT)) {
            for (fraction in listOf(0f, 0.35f, 1f)) {
                val result = jobCardStageProgressValue(task().copy(stage = stage, progressFraction = fraction), 120_000)!!
                assertFalse(result.estimated)
                assertEquals(fraction, result.fraction, 0f)
            }
        }
        val fallback = jobCardStageProgressValue(task().copy(progressFraction = Float.NaN), 0)!!
        assertTrue(fallback.estimated)
        assertEquals(0.08f, fallback.fraction, 0.000001f)
    }

    private fun task() = audioTaskPresentations(emptyList(), listOf(Job(
        id = "68c000000000000000000002", status = "processing",
        createdAt = Instant.EPOCH, updatedAt = Instant.EPOCH,
        input = JobInput("mp3", 1000, 180.0), canDownloadInput = false, canDownloadOutput = false,
    )), 0).single()
}
