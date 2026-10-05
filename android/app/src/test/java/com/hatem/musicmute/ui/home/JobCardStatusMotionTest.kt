package com.hatem.musicmute.ui.home

import com.hatem.musicmute.processing.AudioTaskStage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class JobCardStatusMotionTest {
    @Test
    fun animatedStagesOnlyRepresentWorkThatCanAdvance() {
        val staticStages = setOf(
            AudioTaskStage.REVIEW, AudioTaskStage.INTERRUPTED, AudioTaskStage.CANCELLING,
            AudioTaskStage.READY, AudioTaskStage.FAILED, AudioTaskStage.CANCELLED, AudioTaskStage.UNKNOWN,
        )
        AudioTaskStage.entries.forEach { stage ->
            assertEquals(stage.name, stage !in staticStages, jobCardStatusCanAnimate(stage, true, true))
        }
    }

    @Test
    fun inactiveOrWorkerUnavailableStagesNeverAnimate() {
        AudioTaskStage.entries.forEach { stage ->
            assertFalse(stage.name, jobCardStatusCanAnimate(stage, false, true))
            assertFalse(stage.name, jobCardStatusCanAnimate(stage, true, false))
        }
    }

    @Test
    fun unknownWorkerAvailabilityDoesNotPauseLocalPreparationOrSourceTransfers() {
        assertTrue(jobCardStatusCanAnimate(AudioTaskStage.DOWNLOADING_SOURCE, true, null))
        assertTrue(jobCardStatusCanAnimate(AudioTaskStage.PREPARING_INPUT, true, null))
        assertTrue(jobCardStatusCanAnimate(AudioTaskStage.UPLOADING_INPUT, true, null))
    }
}
