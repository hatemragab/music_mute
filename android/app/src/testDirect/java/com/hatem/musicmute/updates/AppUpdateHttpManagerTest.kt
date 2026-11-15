package com.hatem.musicmute.updates

import com.azhon.appupdate.base.bean.DownloadStatus
import java.io.File
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppUpdateHttpManagerTest {
    private val target = ReleaseTarget("release", "0.1.4", 5, "Changes", "direct_apk",
        artifact = ReleaseArtifact(4, "a".repeat(64), "b".repeat(64)))
    private val grant = ReleaseDownloadGrant("release", "https://example.test/app.apk",
        "2099-01-01T00:00:00Z", 4, "a".repeat(64), "b".repeat(64))

    @Test fun completionIsExposedOnlyAfterVerification() = runTest {
        val root = kotlin.io.path.createTempDirectory().toFile()
        try {
            val file = File(root, "app.apk")
            var verified = false
            val manager = AppUpdateHttpManager(transport(4), file, target, grant,
                ApkVerifier { _, _, _ -> verified = true })
            val events = manager.download(grant.url, file.name).toList()
            assertTrue(verified)
            assertTrue(events.first() is DownloadStatus.Start)
            assertTrue(events.any { it is DownloadStatus.Downloading })
            assertEquals(file, (events.last() as DownloadStatus.Done).apk)
        } finally { root.deleteRecursively() }
    }

    @Test fun invalidApkNeverReachesLibraryCompletionOrNotification() = runTest {
        val root = kotlin.io.path.createTempDirectory().toFile()
        try {
            val file = File(root, "app.apk")
            val manager = AppUpdateHttpManager(transport(4), file, target, grant,
                ApkVerifier { _, _, _ -> throw UpdateFailure(UpdateProblem.APK_SIGNER_MISMATCH) })
            val events = manager.download(grant.url, file.name).toList()
            assertFalse(events.any { it is DownloadStatus.Done })
            assertEquals(UpdateProblem.APK_SIGNER_MISMATCH,
                ((events.last() as DownloadStatus.Error).e as UpdateFailure).problem)
            assertFalse(file.exists())
        } finally { root.deleteRecursively() }
    }

    @Test fun oversizedDownloadFailsBeforeVerification() = runTest {
        val root = kotlin.io.path.createTempDirectory().toFile()
        try {
            var verified = false
            val manager = AppUpdateHttpManager(transport(5), File(root, "app.apk"), target, grant,
                ApkVerifier { _, _, _ -> verified = true })
            val events = manager.download(grant.url, "app.apk").toList()
            assertFalse(verified)
            assertFalse(events.any { it is DownloadStatus.Done })
            assertTrue(events.last() is DownloadStatus.Error)
        } finally { root.deleteRecursively() }
    }

    @Test fun cancellationDuringVerificationNeverExposesCompletion() = runTest {
        val root = kotlin.io.path.createTempDirectory().toFile()
        try {
            val file = File(root, "app.apk")
            lateinit var manager: AppUpdateHttpManager
            manager = AppUpdateHttpManager(transport(4), file, target, grant,
                ApkVerifier { _, _, _ -> manager.cancel() })
            val events = mutableListOf<DownloadStatus>()
            try {
                manager.download(grant.url, file.name).toList(events)
                org.junit.Assert.fail("Expected cancellation")
            } catch (_: CancellationException) {
                assertFalse(events.any { it is DownloadStatus.Done })
                assertFalse(file.exists())
            }
        } finally { root.deleteRecursively() }
    }

    @Test fun libraryCannotSubstituteAnotherDownloadUrl() = runTest {
        val root = kotlin.io.path.createTempDirectory().toFile()
        try {
            var fetched = false
            val transport = object : UpdateDownloadClient {
                override fun download(url: String, destination: File) = flow<UpdateDownloadEvent> {
                    fetched = true
                }
                override fun cancel() = Unit
            }
            val manager = AppUpdateHttpManager(transport, File(root, "app.apk"), target, grant,
                ApkVerifier { _, _, _ -> })
            val events = manager.download("https://other.example.test/app.apk", "app.apk").toList()
            assertFalse(fetched)
            assertTrue(events.single() is DownloadStatus.Error)
        } finally { root.deleteRecursively() }
    }

    private fun transport(bytes: Int) = object : UpdateDownloadClient {
        override fun download(url: String, destination: File) = flow {
            emit(UpdateDownloadEvent.Progress(bytes.toLong(), bytes.toLong()))
            destination.writeBytes(ByteArray(bytes))
            emit(UpdateDownloadEvent.Complete(destination))
        }
        override fun cancel() = Unit
    }
}
