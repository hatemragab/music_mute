package com.hatem.musicmute.processing

import org.junit.Assert.*
import org.junit.Test

class ProcessingMediaPolicyTest {
    private val fixture = """{
      "schemaVersion":2,"revision":1,"acceptNewJobs":false,
      "limits":{"maxDurationSeconds":1800,"maxPreparedAudioBytes":100000000,"maxLocalSourceBytes":null,
      "maxPreparationSeconds":null,"maxSourceDownloadBytes":null,"maxSourceDownloadSeconds":null},
      "preparationProfile":{"id":"preserve-or-aac-lc-256-v1","preserveCompatibleAudio":true,
      "compatibilityRevision":"unavailable","fallbackConversion":{"codec":"aac-lc","outputContentType":"audio/mp4","targetBitrate":256000}}
    }"""
    @Test fun serverReadinessFixtureParsesWithoutEnablingExpansion() {
        val policy = ProcessingMediaPolicy.parse(fixture)
        assertEquals(2, policy.version)
        assertTrue(policy.acceptsPrepared(100000000, 1800.0))
        assertFalse(policy.localExpansionReady)
        assertFalse(policy.acceptNewJobs)
    }
    @Test(expected = JobsFailure::class) fun unknownProfileRejected() { ProcessingMediaPolicy.parse(fixture.replace("preserve-or-aac-lc-256-v1", "future-profile")) }
    @Test(expected = JobsFailure::class) fun unknownVersionRejected() { ProcessingMediaPolicy.parse(fixture.replace("\"schemaVersion\":2", "\"schemaVersion\":3")) }
    @Test(expected = JobsFailure::class) fun pausedLongAdmissionRejectsBeforeExpensiveWork() {
        expandedMediaPolicy().copy(acceptLongJobs = false, longJobThresholdSeconds = 600.0).requireLongJobAvailable(601.0)
    }
    @Test fun inclusivePreparedBoundaries() {
        val policy = expandedMediaPolicy()
        assertTrue(policy.acceptsPrepared(100_000_000, 1800.0))
        assertFalse(policy.acceptsPrepared(100_000_001, 1800.0))
        assertFalse(policy.acceptsPrepared(10, 1800.001))
        assertFalse(policy.acceptsPrepared(10, Double.NaN))
        assertFalse(policy.acceptsPrepared(0, 1.0))
    }
    @Test fun legacyRemainsExclusive() {
        assertFalse(ProcessingMediaPolicy.LEGACY.acceptsPrepared(10, 600.0))
        assertFalse(ProcessingMediaPolicy.LEGACY.acceptsPrepared(30_000_000, 1.0))
    }
    @Test fun standardLocalPreparationHasBoundsWithoutExpandedAdmission() {
        val policy = ProcessingMediaPolicy.LEGACY
        assertEquals(200_000_000L, policy.maxLocalSourceBytes)
        assertEquals(120L, policy.maxPreparationSeconds)
        assertEquals(1, policy.version)
        assertNull(policy.profileId)
        assertTrue(policy.localPreparationReady)
        assertFalse(policy.localExpansionReady)
        assertFalse(policy.youtubeExpansionReady)
        assertTrue(policy.acceptsPrepared(29_999_999, 599.0))
        assertFalse(policy.acceptsPrepared(30_000_000, 599.0))
        assertFalse(policy.acceptsPrepared(1, 600.0))
    }
    @Test fun readinessIsNotAnUnlimitedBound() {
        assertFalse(expandedMediaPolicy().copy(maxLocalSourceBytes = null).localExpansionReady)
        assertFalse(ProcessingMediaPolicy.LEGACY.copy(maxLocalSourceBytes = null).localPreparationReady)
        assertFalse(ProcessingMediaPolicy.LEGACY.copy(maxPreparationSeconds = 0).localPreparationReady)
    }
}
internal fun expandedMediaPolicy() = ProcessingMediaPolicy(
    version = 2, revision = 1, maxDurationSeconds = 1800.0, maxPreparedAudioBytes = 100_000_000,
    profileId = "preserve-or-aac-lc-256-v1", maxLocalSourceBytes = 200_000_000,
    maxPreparationSeconds = 120, maxSourceDownloadBytes = 100_000_000, maxSourceDownloadSeconds = 120,
)
