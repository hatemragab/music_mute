package com.hatem.musicmute.updates

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.azhon.appupdate.util.ApkUtil
import com.hatem.musicmute.BuildConfig
import java.io.File
import java.net.URL
import java.security.MessageDigest
import java.time.Instant
import java.util.concurrent.atomic.AtomicLong
import javax.net.ssl.HttpsURLConnection
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

sealed interface UpdateDownloadEvent {
    data class Progress(val bytes: Long, val totalBytes: Long) : UpdateDownloadEvent
    data class Complete(val file: File) : UpdateDownloadEvent
}

interface UpdateDownloadClient {
    fun download(url: String, destination: File): Flow<UpdateDownloadEvent>
    fun cancel()
}

fun interface ApkVerifier {
    suspend fun verify(file: File, target: ReleaseTarget, grant: ReleaseDownloadGrant)
}

interface ApkInstallPlatform {
    fun canRequestPackageInstalls(): Boolean
    fun requestPackageInstallPermission()
    fun launchInstaller(apk: File)
    fun openStore(url: String)
}

class DirectUpdateInstaller(
    private val api: UpdatePolicyApi,
    private val downloadRoot: File,
    private val downloader: UpdateDownloadClient,
    private val verifier: ApkVerifier,
    private val platform: ApkInstallPlatform,
    private val installedBuild: () -> Int,
    private val nowEpochMs: () -> Long = System::currentTimeMillis,
    private val availableSpace: () -> Long = { downloadRoot.usableSpace },
) : UpdateInstaller {
    private val mutableState = MutableStateFlow<UpdateInstallState>(UpdateInstallState.Idle)
    override val state = mutableState.asStateFlow()
    private val actionLock = Mutex()
    private val generation = AtomicLong()
    private data class PendingInstall(
        val file: File,
        val target: ReleaseTarget,
        val grant: ReleaseDownloadGrant,
    )

    private var pending: PendingInstall? = null
    private var installerLaunched = false

    override suspend fun start(target: ReleaseTarget) = actionLock.withLock {
        val ticket = generation.incrementAndGet()
        installerLaunched = false
        try {
            if (target.source == "google_play") {
                pending = null
                openStore(target)
                return@withLock
            }
            val artifact = target.artifact
            if (target.source != "direct_apk" || artifact == null)
                throw UpdateFailure(UpdateProblem.INVALID_POLICY)
            val grant = api.downloadGrant(target.id)
            validateDownloadGrant(grant)
            if (
                grant.releaseId != target.id ||
                    grant.bytes != artifact.bytes ||
                    grant.sha256Hex != artifact.sha256Hex ||
                    grant.signerSha256Hex != artifact.signerSha256Hex
            ) throw UpdateFailure(UpdateProblem.INVALID_POLICY)
            if (Instant.parse(grant.expiresAt).toEpochMilli() <= nowEpochMs())
                throw UpdateFailure(UpdateProblem.RELEASE_UNAVAILABLE)
            val retained =
                pending?.takeIf {
                    it.target.id == target.id &&
                        it.target.buildNumber == target.buildNumber &&
                        it.grant.bytes == grant.bytes &&
                        it.grant.sha256Hex == grant.sha256Hex &&
                        it.grant.signerSha256Hex == grant.signerSha256Hex &&
                        it.file.isFile
                }
            if (retained != null) {
                pending = retained.copy(grant = grant)
                continueInstall(retained.file, target, grant)
                return@withLock
            }
            pending = null
            if (!downloadRoot.isDirectory && !downloadRoot.mkdirs())
                throw UpdateFailure(UpdateProblem.INSUFFICIENT_STORAGE)
            if (availableSpace() < grant.bytes)
                throw UpdateFailure(UpdateProblem.INSUFFICIENT_STORAGE)
            val destination =
                File(
                    downloadRoot,
                    "musicmute-${target.buildNumber}-${artifact.sha256Hex.take(12)}.apk",
                )
            destination.parentFile?.mkdirs()
            if (destination.exists() && !destination.delete())
                throw UpdateFailure(UpdateProblem.DOWNLOAD_FAILED)
            var downloaded: File? = null
            downloader.download(grant.url, destination).collect { event ->
                if (generation.get() != ticket) throw CancellationException("Update cancelled")
                when (event) {
                    is UpdateDownloadEvent.Progress -> {
                        if (
                            event.bytes > grant.bytes ||
                                (event.totalBytes > 0 && event.totalBytes != grant.bytes)
                        ) throw UpdateFailure(UpdateProblem.APK_SIZE_MISMATCH)
                        val percent =
                            if (event.totalBytes <= 0) 0
                            else ((event.bytes * 100) / event.totalBytes).toInt().coerceIn(0, 100)
                        mutableState.value = UpdateInstallState.Downloading(percent)
                    }
                    is UpdateDownloadEvent.Complete -> {
                        if (!event.file.isFile || event.file.length() != grant.bytes)
                            throw UpdateFailure(UpdateProblem.APK_SIZE_MISMATCH)
                        downloaded = event.file
                    }
                }
            }
            val apk = downloaded ?: throw UpdateFailure(UpdateProblem.DOWNLOAD_FAILED)
            if (apk.canonicalFile != destination.canonicalFile)
                throw UpdateFailure(UpdateProblem.APK_INVALID)
            mutableState.value = UpdateInstallState.Verifying
            verifier.verify(apk, target, grant)
            if (generation.get() != ticket) throw CancellationException("Update cancelled")
            pending = PendingInstall(apk, target, grant)
            if (!platform.canRequestPackageInstalls()) {
                mutableState.value = UpdateInstallState.PermissionNeeded
                requestInstallPermission()
            } else launch(apk)
        } catch (error: CancellationException) {
            if (generation.get() == ticket) mutableState.value = UpdateInstallState.Idle
        } catch (error: UpdateFailure) {
            mutableState.value = UpdateInstallState.Failed(error.problem)
        } catch (_: Exception) {
            mutableState.value = UpdateInstallState.Failed(UpdateProblem.DOWNLOAD_FAILED)
        }
    }

    override suspend fun onForeground() = actionLock.withLock {
        try {
            val current = pending ?: return@withLock
            if (installedBuild() >= current.target.buildNumber) {
                pending = null
                installerLaunched = false
                mutableState.value = UpdateInstallState.Idle
                return@withLock
            }
            if (installerLaunched) {
                installerLaunched = false
                mutableState.value = UpdateInstallState.Failed(UpdateProblem.INSTALL_CANCELLED)
                return@withLock
            }
            if (mutableState.value == UpdateInstallState.PermissionNeeded) {
                if (!platform.canRequestPackageInstalls()) {
                    mutableState.value =
                        UpdateInstallState.Failed(UpdateProblem.INSTALL_PERMISSION_REQUIRED)
                    return@withLock
                }
                continueInstall(current.file, current.target, current.grant)
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: UpdateFailure) {
            mutableState.value = UpdateInstallState.Failed(error.problem)
        } catch (_: Exception) {
            mutableState.value = UpdateInstallState.Failed(UpdateProblem.INSTALLER_UNAVAILABLE)
        }
    }

    private suspend fun continueInstall(
        apk: File,
        target: ReleaseTarget,
        grant: ReleaseDownloadGrant,
    ) {
        mutableState.value = UpdateInstallState.Verifying
        verifier.verify(apk, target, grant)
        if (!platform.canRequestPackageInstalls()) {
            mutableState.value = UpdateInstallState.PermissionNeeded
            requestInstallPermission()
        } else {
            launch(apk)
        }
    }

    private fun requestInstallPermission() {
        try {
            platform.requestPackageInstallPermission()
        } catch (_: Exception) {
            throw UpdateFailure(UpdateProblem.INSTALLER_UNAVAILABLE)
        }
    }

    private fun openStore(target: ReleaseTarget) {
        validateGooglePlayTarget(target, BuildConfig.APPLICATION_ID)
        val value = requireNotNull(target.storeUrl)
        try {
            platform.openStore(value)
            mutableState.value = UpdateInstallState.StoreOpened
        } catch (_: Exception) {
            mutableState.value = UpdateInstallState.Failed(UpdateProblem.PLAY_UPDATE_UNAVAILABLE)
        }
    }

    private fun launch(apk: File) {
        try {
            platform.launchInstaller(apk)
            installerLaunched = true
            mutableState.value = UpdateInstallState.AwaitingInstaller
        } catch (_: Exception) {
            mutableState.value = UpdateInstallState.Failed(UpdateProblem.INSTALLER_UNAVAILABLE)
        }
    }

    override fun cancel() {
        generation.incrementAndGet()
        downloader.cancel()
        pending = null
        installerLaunched = false
        mutableState.value = UpdateInstallState.Idle
    }
}

private class HttpsUpdateDownloadClient : UpdateDownloadClient {
    @Volatile private var active: HttpsURLConnection? = null
    @Volatile private var cancelled = false

    override fun download(url: String, destination: File): Flow<UpdateDownloadEvent> = flow {
        cancelled = false
        val connection = URL(url).openConnection() as? HttpsURLConnection
            ?: throw UpdateFailure(UpdateProblem.INVALID_POLICY)
        active = connection
        var complete = false
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS
            connection.requestMethod = "GET"
            connection.setRequestProperty("Accept-Encoding", "identity")
            if (connection.responseCode !in 200..299)
                throw UpdateFailure(UpdateProblem.DOWNLOAD_FAILED)
            val totalBytes = connection.contentLengthLong
            connection.inputStream.buffered().use { input ->
                destination.outputStream().buffered().use { output ->
                    val buffer = ByteArray(BUFFER_BYTES)
                    var downloaded = 0L
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        val next = downloaded + count
                        emit(UpdateDownloadEvent.Progress(next, totalBytes))
                        output.write(buffer, 0, count)
                        downloaded = next
                    }
                }
            }
            emit(UpdateDownloadEvent.Complete(destination))
            complete = true
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (cancelled) throw CancellationException("Update cancelled")
            if (error is UpdateFailure) throw error
            throw UpdateFailure(UpdateProblem.DOWNLOAD_FAILED)
        } finally {
            connection.disconnect()
            if (active === connection) active = null
            if (!complete) destination.delete()
        }
    }.flowOn(Dispatchers.IO)

    override fun cancel() {
        cancelled = true
        active?.disconnect()
    }

    companion object {
        private const val CONNECT_TIMEOUT_MS = 15_000
        private const val READ_TIMEOUT_MS = 30_000
        private const val BUFFER_BYTES = 64 * 1024
    }
}

internal fun createUpdateDownloadClient(): UpdateDownloadClient = HttpsUpdateDownloadClient()

private class AndroidApkInstallPlatform(private val context: Context) : ApkInstallPlatform {
    override fun canRequestPackageInstalls(): Boolean = context.packageManager.canRequestPackageInstalls()
    override fun requestPackageInstallPermission() {
        context.startActivity(
            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }
    override fun launchInstaller(apk: File) {
        val intent =
            ApkUtil.createInstallIntent(context, "${context.packageName}.fileProvider", apk)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        if (intent.resolveActivity(context.packageManager) == null) throw ActivityNotFoundException()
        context.startActivity(intent)
    }
    override fun openStore(url: String) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (intent.resolveActivity(context.packageManager) == null) throw ActivityNotFoundException()
        context.startActivity(intent)
    }
}

private class AndroidApkVerifier(
    private val context: Context,
    private val installedBuild: () -> Int,
) : ApkVerifier {
    override suspend fun verify(file: File, target: ReleaseTarget, grant: ReleaseDownloadGrant) {
        verifyApkBytes(file, grant)

        val flags =
            if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES
            else @Suppress("DEPRECATION") PackageManager.GET_SIGNATURES
        @Suppress("DEPRECATION")
        val info = context.packageManager.getPackageArchiveInfo(file.absolutePath, flags)
            ?: throw UpdateFailure(UpdateProblem.APK_INVALID)
        if (info.packageName != context.packageName)
            throw UpdateFailure(UpdateProblem.APK_PACKAGE_MISMATCH)
        val versionCode =
            if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
        val signatures =
            if (Build.VERSION.SDK_INT >= 28)
                info.signingInfo?.apkContentsSigners.orEmpty().asSequence()
            else @Suppress("DEPRECATION") info.signatures.orEmpty().asSequence()
        validateApkIdentity(
            ApkArchiveIdentity(
                packageName = info.packageName,
                buildNumber = versionCode,
                signerSha256Hex =
                    signatures.map {
                        MessageDigest.getInstance("SHA-256").digest(it.toByteArray()).toHex()
                    }.toSet(),
            ),
            expectedPackageName = context.packageName,
            installedBuild = installedBuild(),
            target = target,
            grant = grant,
        )
    }
}

internal data class ApkArchiveIdentity(
    val packageName: String,
    val buildNumber: Long,
    val signerSha256Hex: Set<String>,
)

internal fun verifyApkBytes(file: File, grant: ReleaseDownloadGrant) {
    if (!file.isFile || file.length() != grant.bytes)
        throw UpdateFailure(UpdateProblem.APK_SIZE_MISMATCH)
    val digest =
        file.inputStream().buffered().use { input ->
            val md = MessageDigest.getInstance("SHA-256")
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                md.update(buffer, 0, count)
            }
            md.digest().toHex()
        }
    if (digest != grant.sha256Hex)
        throw UpdateFailure(UpdateProblem.APK_CHECKSUM_MISMATCH)
}

internal fun validateApkIdentity(
    identity: ApkArchiveIdentity,
    expectedPackageName: String,
    installedBuild: Int,
    target: ReleaseTarget,
    grant: ReleaseDownloadGrant,
) {
    if (identity.packageName != expectedPackageName)
        throw UpdateFailure(UpdateProblem.APK_PACKAGE_MISMATCH)
    if (
        identity.buildNumber != target.buildNumber.toLong() ||
            identity.buildNumber <= installedBuild
    ) throw UpdateFailure(UpdateProblem.APK_BUILD_MISMATCH)
    if (grant.signerSha256Hex !in identity.signerSha256Hex)
        throw UpdateFailure(UpdateProblem.APK_SIGNER_MISMATCH)
}

private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

fun createUpdateInstaller(
    context: Context,
    api: UpdatePolicyApi,
    installedBuild: () -> Int,
): UpdateInstaller =
    DirectUpdateInstaller(
        api = api,
        downloadRoot = File(context.externalCacheDir ?: context.cacheDir, "app-updates"),
        downloader = createUpdateDownloadClient(),
        verifier = AndroidApkVerifier(context, installedBuild),
        platform = AndroidApkInstallPlatform(context),
        installedBuild = installedBuild,
    )
