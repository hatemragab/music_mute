package com.hatem.musicmute.processing

import org.junit.Assert.*
import org.junit.Test

class ProcessingMediaPolicyTest {
    private val fixture = """{
      "schemaVersion":2,"revision":1,"acceptNewJobs":true,"acceptLongJobs":true,
      "limits":{"maxDurationSeconds":1200,"maxPreparedAudioBytes":50000000,"maxLocalSourceBytes":200000000,
      "maxPreparationSeconds":120,"maxSourceDownloadBytes":50000000,"maxSourceDownloadSeconds":120,
      "longJobThresholdSeconds":600},
      "preparationProfile":{"id":"preserve-or-aac-lc-256-v1","preserveCompatibleAudio":true,
      "compatibilityRevision":"unavailable","fallbackConversion":{"codec":"aac-lc","outputContentType":"audio/mp4","targetBitrate":256000}}
    }"""

    @Test fun serverPolicyParsesAsTheOnlyStandardPolicy() {
        val policy = ProcessingMediaPolicy.parse(fixture)
        assertEquals(2, policy.version)
        assertTrue(policy.acceptsPrepared(50_000_000, 1_200.0))
        assertTrue(policy.localPreparationReady)
        assertTrue(policy.youtubePreparationReady)
        assertTrue(policy.acceptNewJobs)
    }

    @Test(expected = JobsFailure::class)
    fun unknownProfileRejected() {
        ProcessingMediaPolicy.parse(fixture.replace("preserve-or-aac-lc-256-v1", "future-profile"))
    }

    @Test(expected = JobsFailure::class)
    fun unknownVersionRejected() {
        ProcessingMediaPolicy.parse(fixture.replace("\"schemaVersion\":2", "\"schemaVersion\":1"))
    }

    @Test(expected = JobsFailure::class)
    fun responseCannotExpandSafeOfflineCeilings() {
        ProcessingMediaPolicy.parse(fixture.replace("50000000", "50000001"))
    }

    @Test(expected = JobsFailure::class)
    fun pausedLongAdmissionRejectsBeforeExpensiveWork() {
        standardMediaPolicy().copy(acceptLongJobs = false, longJobThresholdSeconds = 600.0)
            .requireLongJobAvailable(600.001)
    }

    @Test fun inclusivePreparedBoundaries() {
        val policy = ProcessingMediaPolicy.STANDARD
        assertTrue(policy.acceptsPrepared(49_999_999, 1_199.999))
        assertTrue(policy.acceptsPrepared(50_000_000, 1_200.0))
        assertFalse(policy.acceptsPrepared(50_000_001, 1_200.0))
        assertFalse(policy.acceptsPrepared(10, 1_200.001))
        assertFalse(policy.acceptsPrepared(10, Double.NaN))
        assertFalse(policy.acceptsPrepared(0, 1.0))
    }

    @Test fun standardOfflinePolicyHasBoundedLocalAndRemotePreparation() {
        val policy = ProcessingMediaPolicy.STANDARD
        assertEquals(200_000_000L, policy.maxLocalSourceBytes)
        assertEquals(120L, policy.maxPreparationSeconds)
        assertEquals(50_000_000L, policy.maxSourceDownloadBytes)
        assertEquals(120L, policy.maxSourceDownloadSeconds)
        assertTrue(policy.localPreparationReady)
        assertTrue(policy.youtubePreparationReady)
    }

    @Test fun readinessRequiresEveryBound() {
        assertFalse(standardMediaPolicy().copy(maxLocalSourceBytes = null).localPreparationReady)
        assertFalse(standardMediaPolicy().copy(maxPreparationSeconds = 0).localPreparationReady)
        assertFalse(standardMediaPolicy().copy(maxSourceDownloadBytes = null).youtubePreparationReady)
    }
}

internal fun standardMediaPolicy() = ProcessingMediaPolicy.STANDARD.copy(revision = 1)
