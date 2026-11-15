package com.hatem.musicmute.updates

import java.security.MessageDigest
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ApkValidationTest {
    private val signer = "b".repeat(64)
    private val target =
        ReleaseTarget(
            id = "6aa46ad418983c1bd08b5749",
            versionName = "0.1.2",
            buildNumber = 3,
            changelogEn = "In-app updates",
            source = "direct_apk",
            artifact = ReleaseArtifact(4, "a".repeat(64), signer),
        )

    @Test
    fun wholeFileSizeAndSha256AreVerifiedBeforeArchiveIdentity() = runTest {
        val file = kotlin.io.path.createTempFile("verified-update-", ".apk").toFile()
        file.writeBytes(byteArrayOf(1, 2, 3, 4))
        val digest =
            MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") {
                "%02x".format(it)
            }
        val grant = grant(bytes = 4, sha256 = digest)

        verifyApkBytes(file, grant)

        assertProblem(UpdateProblem.APK_SIZE_MISMATCH) {
            verifyApkBytes(file, grant.copy(bytes = 5))
        }
        assertProblem(UpdateProblem.APK_CHECKSUM_MISMATCH) {
            verifyApkBytes(file, grant.copy(sha256Hex = "c".repeat(64)))
        }
    }

    @Test
    fun packageBuildAndSignerMustAllMatchThePublishedTarget() {
        val grant = grant()
        validateApkIdentity(
            ApkArchiveIdentity("com.hatem.musicmute", 3, setOf(signer)),
            "com.hatem.musicmute",
            2,
            target,
            grant,
        )

        assertProblem(UpdateProblem.APK_PACKAGE_MISMATCH) {
            validateApkIdentity(
                ApkArchiveIdentity("example.other", 3, setOf(signer)),
                "com.hatem.musicmute",
                2,
                target,
                grant,
            )
        }
        assertProblem(UpdateProblem.APK_BUILD_MISMATCH) {
            validateApkIdentity(
                ApkArchiveIdentity("com.hatem.musicmute", 2, setOf(signer)),
                "com.hatem.musicmute",
                2,
                target,
                grant,
            )
        }
        assertProblem(UpdateProblem.APK_SIGNER_MISMATCH) {
            validateApkIdentity(
                ApkArchiveIdentity("com.hatem.musicmute", 3, setOf("c".repeat(64))),
                "com.hatem.musicmute",
                2,
                target,
                grant,
            )
        }
    }

    private fun grant(bytes: Long = 4, sha256: String = "a".repeat(64)) =
        ReleaseDownloadGrant(
            releaseId = target.id,
            url = "https://signed.example.test/release.apk",
            expiresAt = "2099-09-12T01:00:00.000Z",
            bytes = bytes,
            sha256Hex = sha256,
            signerSha256Hex = signer,
        )

    private fun assertProblem(expected: UpdateProblem, block: () -> Unit) {
        val failure = assertThrows(UpdateFailure::class.java, block)
        assertEquals(expected, failure.problem)
    }
}
