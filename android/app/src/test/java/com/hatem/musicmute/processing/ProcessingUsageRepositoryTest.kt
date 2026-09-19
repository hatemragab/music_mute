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
        uploads = ProcessingUploadUsage(30, 1, 29, "2026-09-14T00:00:00Z", 200, 10, 190, 1_000_000_000, 50_000_000, 950_000_000, "2026-10-01T00:00:00Z"),
        storage = ProcessingStorageUsage(1_000_000_000, 100_000_000, 900_000_000),
        effectiveLimits = ProcessingEffectiveLimits(1_200, 50_000_000, 5, 600),
        downloads = ProcessingDownloadUsage(150, 5, 145, 10_000_000_000, 250_000_000, 9_750_000_000, "2026-10-01T00:00:00Z"),
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
    @Test(expected = JobsFailure::class) fun invalidTransferLimitsAreRejected() {
        usage().copy(effectiveLimits = usage().effectiveLimits.copy(signedUrlTtlSeconds = 601)).validate()
    }
}
