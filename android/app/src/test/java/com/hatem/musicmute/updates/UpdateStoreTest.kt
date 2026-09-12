package com.hatem.musicmute.updates

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateStoreTest {
    @Test
    fun requiredAuthorityAndTimingSurviveSerializedProcessRecreation() = runTest {
        val snapshot =
            UpdatePolicySnapshot(
                schemaVersion = 1,
                revision = 9,
                platform = "android",
                distribution = "direct",
                minimumBuild = 3,
                target =
                    ReleaseTarget(
                        id = "6aa46ad418983c1bd08b5749",
                        versionName = "0.1.2",
                        buildNumber = 3,
                        changelogEn = "In-app updates",
                        source = "direct_apk",
                        artifact = ReleaseArtifact(4, "a".repeat(64), "b".repeat(64)),
                    ),
                checkedAt = "2026-09-12T00:00:00.000Z",
            )
        val original =
            StoredUpdateState(
                snapshot = snapshot,
                lastAttemptEpochMs = 100,
                lastSuccessEpochMs = 90,
                failureCount = 2,
                retryNotBeforeEpochMs = 500,
                provisionalRequired = true,
            )
        val bytes = ByteArrayOutputStream().also { UpdateStateSerializer.writeTo(original, it) }.toByteArray()

        val restored = UpdateStateSerializer.readFrom(ByteArrayInputStream(bytes))

        assertEquals(original, restored)
        assertTrue(restored.provisionalRequired)
        assertEquals(9L, restored.snapshot?.revision)
    }
}
