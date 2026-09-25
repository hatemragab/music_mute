package com.hatem.musicmute.processing

import com.hatem.musicmute.auth.ApiWireJson
import org.junit.Assert.*
import org.junit.Test

class ProcessingMediaPolicyTest {
    private val fixture = """{
      "schema_version":2,"revision":1,"accept_new_jobs":true,"accept_long_jobs":true,
      "limits":{"max_duration_seconds":1200,"max_prepared_audio_bytes":50000000,"max_local_source_bytes":200000000,
      "max_preparation_seconds":120,
      "long_job_threshold_seconds":600},
      "preparation_profile":{"id":"audio-cap-aac-lc-160-v1","preserve_compatible_audio":true,
      "compatibility_revision":"unavailable","fallback_conversion":{"codec":"aac-lc","output_content_type":"audio/mp4","target_bitrate":160000}}
    }"""

    @Test fun serverPolicyParsesAsTheOnlyStandardPolicy() {
        val policy = ProcessingMediaPolicy.parse(ApiWireJson.response(fixture))
        assertEquals(2, policy.version)
        assertTrue(policy.acceptsPrepared(50_000_000, 1_200.0))
        assertTrue(policy.localPreparationReady)
        assertTrue(policy.acceptNewJobs)
    }

    @Test(expected = JobsFailure::class)
    fun unknownProfileRejected() {
        ProcessingMediaPolicy.parse(ApiWireJson.response(fixture.replace("audio-cap-aac-lc-160-v1", "future-profile")))
    }

    @Test(expected = JobsFailure::class)
    fun unknownVersionRejected() {
        ProcessingMediaPolicy.parse(ApiWireJson.response(fixture.replace("\"schema_version\":2", "\"schema_version\":1")))
    }

    @Test(expected = JobsFailure::class)
    fun responseCannotExpandSafeOfflineCeilings() {
        ProcessingMediaPolicy.parse(ApiWireJson.response(fixture.replace("50000000", "50000001")))
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
        assertTrue(policy.localPreparationReady)
    }

    @Test fun readinessRequiresEveryBound() {
        assertFalse(standardMediaPolicy().copy(maxLocalSourceBytes = null).localPreparationReady)
        assertFalse(standardMediaPolicy().copy(maxPreparationSeconds = 0).localPreparationReady)
    }
}

internal fun standardMediaPolicy() = ProcessingMediaPolicy.STANDARD.copy(revision = 1)
