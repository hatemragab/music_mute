package com.hatem.musicmute.updates

import java.io.File
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DirectUpdateInstallerTest {
    private val root = kotlin.io.path.createTempDirectory("musicmute-update-").toFile()
    private val target =
        ReleaseTarget(
            id = "6aa46ad418983c1bd08b5749",
            versionName = "0.1.1",
            buildNumber = 2,
            changelogEn = "test",
            source = "direct_apk",
            storeUrl = null,
            artifact = ReleaseArtifact(4, "a".repeat(64), "b".repeat(64)),
        )
    private val grant =
        ReleaseDownloadGrant(
            target.id,
            "https://signed.example.test/release.apk?token=redacted",
            "2099-09-12T01:00:00.000Z",
            4,
            "a".repeat(64),
            "b".repeat(64),
        )

    private class FakeApi(private val grant: ReleaseDownloadGrant) : UpdatePolicyApi {
        override suspend fun policy(): UpdatePolicySnapshot = error("unused")
        override suspend fun downloadGrant(releaseId: String) = grant
    }

    private class FakeDownloader : UpdateDownloadClient {
        var calls = 0
        var cancelled = false
        override fun download(url: String, destination: File): Flow<UpdateDownloadEvent> = flow {
            calls++
            destination.parentFile?.mkdirs()
            destination.writeText("test")
            emit(UpdateDownloadEvent.Progress(2, 4))
            emit(UpdateDownloadEvent.Complete(destination))
        }
        override fun cancel() { cancelled = true }
    }

    private class FakePlatform(var permitted: Boolean = true) : ApkInstallPlatform {
        var permissionRequests = 0
        var launches = 0
        var storeOpens = 0
        override fun canRequestPackageInstalls() = permitted
        override fun requestPackageInstallPermission() { permissionRequests++ }
        override fun launchInstaller(apk: File) { launches++ }
        override fun openStore(url: String) { storeOpens++ }
    }

    @Test
    fun verifierFailureNeverLaunchesAndroidInstaller() = runTest {
        val platform = FakePlatform()
        val installer =
            DirectUpdateInstaller(
                FakeApi(grant),
                root,
                FakeDownloader(),
                ApkVerifier { _, _, _ -> throw UpdateFailure(UpdateProblem.APK_CHECKSUM_MISMATCH) },
                platform,
                installedBuild = { 1 },
            )

        installer.start(target)

        assertEquals(0, platform.launches)
        assertEquals(UpdateInstallState.Failed(UpdateProblem.APK_CHECKSUM_MISMATCH), installer.state.value)
    }

    @Test
    fun downloadGrantMustMatchPublishedTargetBeforeAnyBytesAreFetched() = runTest {
        val downloader = FakeDownloader()
        val mismatched = grant.copy(sha256Hex = "c".repeat(64))
        val installer =
            DirectUpdateInstaller(
                FakeApi(mismatched), root, downloader, ApkVerifier { _, _, _ -> }, FakePlatform(), { 1 }
            )

        installer.start(target)

        assertEquals(0, downloader.calls)
        assertEquals(UpdateInstallState.Failed(UpdateProblem.INVALID_POLICY), installer.state.value)
    }

    @Test
    fun unknownSourcePermissionResumesValidatedInstallerHandoffOnForeground() = runTest {
        val platform = FakePlatform(permitted = false)
        val installer =
            DirectUpdateInstaller(
                FakeApi(grant), root, FakeDownloader(), ApkVerifier { _, _, _ -> }, platform, { 1 }
            )

        installer.start(target)
        assertEquals(1, platform.permissionRequests)
        assertEquals(UpdateInstallState.PermissionNeeded, installer.state.value)
        assertEquals(0, platform.launches)

        platform.permitted = true
        installer.onForeground()
        assertEquals(1, platform.launches)
        assertEquals(UpdateInstallState.AwaitingInstaller, installer.state.value)
    }

    @Test
    fun cancellationStopsTheSelectedOpenSourceDownloader() = runTest {
        val downloader = FakeDownloader()
        val installer =
            DirectUpdateInstaller(
                FakeApi(grant), root, downloader, ApkVerifier { _, _, _ -> }, FakePlatform(), { 1 }
            )
        installer.cancel()
        assertTrue(downloader.cancelled)
        assertEquals(UpdateInstallState.Idle, installer.state.value)
    }

    @Test
    fun expiredGrantAndInsufficientStorageFailBeforeDownload() = runTest {
        val downloader = FakeDownloader()
        val expired = grant.copy(expiresAt = "2026-09-12T00:00:00.000Z")
        val expiredInstaller =
            DirectUpdateInstaller(
                FakeApi(expired), root, downloader, ApkVerifier { _, _, _ -> }, FakePlatform(), { 1 },
                nowEpochMs = { java.time.Instant.parse("2026-09-12T00:01:00.000Z").toEpochMilli() },
            )
        expiredInstaller.start(target)
        assertEquals(UpdateInstallState.Failed(UpdateProblem.RELEASE_UNAVAILABLE), expiredInstaller.state.value)
        assertEquals(0, downloader.calls)

        val storageInstaller =
            DirectUpdateInstaller(
                FakeApi(grant), root, downloader, ApkVerifier { _, _, _ -> }, FakePlatform(), { 1 },
                nowEpochMs = { java.time.Instant.parse("2026-09-12T00:01:00.000Z").toEpochMilli() },
                availableSpace = { 3 },
            )
        storageInstaller.start(target)
        assertEquals(UpdateInstallState.Failed(UpdateProblem.INSUFFICIENT_STORAGE), storageInstaller.state.value)
        assertEquals(0, downloader.calls)
    }

    @Test
    fun directBuildCanMigrateToTheVerifiedPlayListingWithoutDownloadingAnApk() = runTest {
        val downloader = FakeDownloader()
        val platform = FakePlatform()
        val playTarget =
            target.copy(
                source = "google_play",
                storeUrl = "https://play.google.com/store/apps/details?id=com.hatem.musicmute",
                artifact = null,
            )
        val installer =
            DirectUpdateInstaller(
                FakeApi(grant), root, downloader, ApkVerifier { _, _, _ -> }, platform, { 1 }
            )

        installer.start(playTarget)

        assertEquals(1, platform.storeOpens)
        assertEquals(0, downloader.calls)
        assertEquals(UpdateInstallState.StoreOpened, installer.state.value)
    }
}
