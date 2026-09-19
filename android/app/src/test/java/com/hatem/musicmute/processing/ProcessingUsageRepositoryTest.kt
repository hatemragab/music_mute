package com.hatem.musicmute.processing

import org.junit.Assert.*
import org.junit.Test

class ProcessingUsageRepositoryTest {
    private fun usage() = ProcessingUsage(
        schemaVersion = 2,
        plan = "standard",
        policyRevision = 1,
        effectivePolicySource = "global",
        period = ProcessingUsagePeriod(
            "2026-09",
            "2026-09-01T00:00:00Z",
            "2026-10-01T00:00:00Z",
            "2026-10-01T00:00:00Z",
        ),
        processing = ProcessingUsageAmounts(7200.0, 600.0, 300.0, 100.0, 6300.0),
        usageRevision = 3,
        activeJobs = 0,
        maxProcessingJobs = 1,
        availability = ProcessingAvailability("available"),
        checkedAt = "2026-09-13T12:00:00Z",
    )
    @Test fun reservationIsSeparateFromUsedAndMonthlyReset() {
        usage().validate()
        assertEquals(6300.0, usage().processing.remainingSeconds, 0.0)
        assertEquals("2026-10-01T00:00:00Z", usage().period.nextResetAt)
        usage().requireAvailable()
    }
    @Test(expected = JobsFailure::class) fun pausedUsageIsNotFreeCapacity() {
        usage().copy(availability = ProcessingAvailability("blocked", "paused")).requireAvailable()
    }
    @Test(expected = JobsFailure::class) fun activeJobBlocksNewPreparation() { usage().copy(activeJobs = 1).requireAvailable() }
    @Test(expected = JobsFailure::class) fun nonfiniteUsageIsRejected() {
        usage().copy(processing = usage().processing.copy(remainingSeconds = Double.NaN)).validate()
    }
}
