package com.hatem.musicmute.updates

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class UpdatePolicyTest {
    private fun snapshot(
        minimumBuild: Int? = 10,
        targetBuild: Int? = 12,
        distribution: String = "direct",
        source: String = "direct_apk",
    ) =
        UpdatePolicySnapshot(
            schemaVersion = 1,
            revision = 7,
            platform = "android",
            distribution = distribution,
            minimumBuild = minimumBuild,
            target =
                targetBuild?.let {
                    ReleaseTarget(
                        id = "6aa46ad418983c1bd08b5749",
                        versionName = "0.1.2",
                        buildNumber = it,
                        changelogEn = "Secure in-app updates",
                        source = source,
                        artifact =
                            if (source == "direct_apk")
                                ReleaseArtifact(
                                    bytes = 1_024,
                                    sha256Hex = "a".repeat(64),
                                    signerSha256Hex = "b".repeat(64),
                                )
                            else null,
                        storeUrl =
                            if (source == "google_play")
                                "https://play.google.com/store/apps/details?id=com.hatem.musicmute"
                            else null,
                    )
                },
            checkedAt = "2026-09-12T00:00:00.000Z",
        )

    @Test
    fun integerBuildPolicySeparatesRequiredOptionalAndCurrentInstalls() {
        assertEquals(UpdateDecision.REQUIRED, decideUpdate(9, snapshot()))
        assertEquals(UpdateDecision.OPTIONAL, decideUpdate(10, snapshot()))
        assertEquals(UpdateDecision.NONE, decideUpdate(12, snapshot()))
        assertEquals(UpdateDecision.NONE, decideUpdate(13, snapshot()))
        assertEquals(UpdateDecision.NONE, decideUpdate(1, snapshot(null, null)))
    }

    @Test
    fun malformedOrIncompatibleSnapshotsCannotBecomeGateAuthority() {
        assertThrows(UpdateFailure::class.java) { decideUpdate(9, snapshot(minimumBuild = 12, targetBuild = 10)) }
        assertThrows(UpdateFailure::class.java) { decideUpdate(9, snapshot(distribution = "play")) }
        assertThrows(UpdateFailure::class.java) {
            decideUpdate(9, snapshot(distribution = "direct", source = "app_store"))
        }
        assertThrows(UpdateFailure::class.java) { decideUpdate(0, snapshot()) }
    }

    @Test
    fun playBuildNeverResolvesToTheDirectApkInstaller() {
        assertEquals("google_play", resolveUpdateSource("play", "direct_apk"))
        assertEquals("direct_apk", resolveUpdateSource("direct", "direct_apk"))
        assertThrows(UpdateFailure::class.java) { resolveUpdateSource("ios", "direct_apk") }
        val play = snapshot(distribution = "play", source = "google_play").target!!
        validateGooglePlayTarget(play, "com.hatem.musicmute")
        assertThrows(UpdateFailure::class.java) {
            validateGooglePlayTarget(
                play.copy(storeUrl = "https://play.google.com/store/apps/details?id=example.other"),
                "com.hatem.musicmute",
            )
        }
    }
}
