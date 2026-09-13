package com.hatem.musicmute.processing

import org.junit.Assert.*
import org.junit.Test

class ProcessingUsageRepositoryTest {
    private fun usage() = ProcessingUsage(1, 3600.0, 600.0, 300.0, 2700.0, 0, 1,
        "2026-09-14T12:00:00Z", listOf(ProcessingReplenishment("2026-09-14T12:00:00Z", 600.0)), "available", "2026-09-13T12:00:00Z")
    @Test fun reservationIsSeparateFromUsedAndRollingReplenishment() { usage().validate(); assertEquals(2700.0, usage().remainingAudioSeconds, 0.0); usage().requireAvailable() }
    @Test(expected = JobsFailure::class) fun unavailableIsNotFreeCapacity() { usage().copy(availability = "unavailable").requireAvailable() }
    @Test(expected = JobsFailure::class) fun activeJobBlocksNewPreparation() { usage().copy(activeJobs = 1).requireAvailable() }
    @Test(expected = JobsFailure::class) fun nonfiniteUsageIsRejected() { usage().copy(remainingAudioSeconds = Double.NaN).validate() }
}
