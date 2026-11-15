package com.hatem.musicmute.updates

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.IntentSenderRequest
import com.google.android.gms.tasks.Task
import com.google.android.play.core.appupdate.AppUpdateInfo
import com.google.android.play.core.appupdate.AppUpdateManager
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.InstallStateUpdatedListener
import com.google.android.play.core.install.model.ActivityResult
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability
import com.hatem.musicmute.BuildConfig
import java.util.concurrent.Executor
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine

internal class PlayUpdateInstaller(
    private val packageName: String,
    private val manager: AppUpdateManager,
    private val launchStore: (String) -> Unit,
) : UpdateInstaller {
    private data class Request(val target: ReleaseTarget, val decision: UpdateDecision, val minimumBuild: Int?) {
        val threshold: Int get() = if (decision == UpdateDecision.REQUIRED) requireNotNull(minimumBuild) else target.buildNumber
    }

    private val mutableState = MutableStateFlow<UpdateInstallState>(UpdateInstallState.Idle)
    override val state = mutableState.asStateFlow()
    private var owner: Any? = null
    private var launcher: ActivityResultLauncher<IntentSenderRequest>? = null
    private var listener: InstallStateUpdatedListener? = null
    private var request: Request? = null
    private var generation = 0L
    private var querying = false
    private var flowActive = false
    private var flowType: Int? = null
    private var needsRecovery = false
    private var backgrounded = false
    private var playBuild: Int? = null
    private var downloadedBuild: Int? = null

    override fun bindLauncher(owner: Any, launcher: ActivityResultLauncher<IntentSenderRequest>) {
        this.owner?.let(::unbindLauncher)
        this.owner = owner
        this.launcher = launcher
        backgrounded = false
        val bindingGeneration = generation
        val boundListener = InstallStateUpdatedListener { update ->
            if (this.owner !== owner || bindingGeneration != generation || request == null || update.packageName() != packageName) return@InstallStateUpdatedListener
            if (flowType == AppUpdateType.FLEXIBLE || mutableState.value is UpdateInstallState.Downloading || mutableState.value == UpdateInstallState.Downloaded) {
                applyStatus(update.installStatus(), update.bytesDownloaded(), update.totalBytesToDownload())
            }
        }
        listener = boundListener
        try {
            manager.registerListener(boundListener)
        } catch (_: Exception) {
            listener = null
            this.launcher = null
            fail()
        }
    }

    override fun unbindLauncher(owner: Any) {
        if (this.owner !== owner) return
        listener?.let { runCatching { manager.unregisterListener(it) } }
        listener = null
        launcher = null
        this.owner = null
        generation++
        querying = false
        flowActive = false
        needsRecovery = false
        if (mutableState.value == UpdateInstallState.CheckingPlay || mutableState.value == UpdateInstallState.PlayFlow)
            mutableState.value = UpdateInstallState.Idle
    }

    override suspend fun start(target: ReleaseTarget, decision: UpdateDecision, minimumBuild: Int?) {
        synchronizePolicy(target, decision, minimumBuild)
        val next = request ?: return
        if (next.decision == UpdateDecision.NONE) {
            fail(UpdateProblem.INVALID_POLICY)
            return
        }
        if (querying || flowActive || mutableState.value == UpdateInstallState.Installing) return
        query(start = true)
    }

    override suspend fun onForeground(target: ReleaseTarget?, decision: UpdateDecision, minimumBuild: Int?) {
        // Synchronize before the in-flight fences: a pending response must use the latest policy.
        synchronizePolicy(target, decision, minimumBuild)
        backgrounded = false
        if (request == null || querying || (flowActive && !needsRecovery) || owner == null) return
        if (needsRecovery) flowActive = false
        needsRecovery = false
        query(start = false)
    }

    override fun synchronizePolicy(target: ReleaseTarget?, decision: UpdateDecision, minimumBuild: Int?) {
        if (target == null) {
            request = null
            downloadedBuild = null
            if (decision == UpdateDecision.REQUIRED || minimumBuild != null) fail(UpdateProblem.INVALID_POLICY)
            else mutableState.value = UpdateInstallState.Idle
            return
        }
        val next = validatedRequest(target, decision, minimumBuild)
        request = next
        if (next == null) return
        if ((downloadedBuild != null && !qualifiedDownloaded()) ||
            (mutableState.value is UpdateInstallState.Downloading && playBuild?.let { it < next.threshold } == true)) {
            fail()
        }
    }

    private fun validatedRequest(target: ReleaseTarget, decision: UpdateDecision, minimumBuild: Int?): Request? {
        if (runCatching { validateGooglePlayTarget(target, packageName) }.isFailure ||
            target.buildNumber <= 0 ||
            (decision == UpdateDecision.REQUIRED && (minimumBuild == null || minimumBuild <= 0 || minimumBuild > target.buildNumber))) {
            fail(UpdateProblem.INVALID_POLICY)
            return null
        }
        return Request(target, decision, minimumBuild)
    }

    private suspend fun query(start: Boolean) {
        val boundLauncher = launcher
        val boundOwner = owner
        if (boundLauncher == null || boundOwner == null) {
            fail()
            return
        }
        querying = true
        val ticket = generation
        if (start) mutableState.value = UpdateInstallState.CheckingPlay
        try {
            // Each attempt obtains a new AppUpdateInfo; Play allows using it only once.
            val info = manager.appUpdateInfo.awaitResult()
            if (ticket != generation || owner !== boundOwner) return
            val next = request ?: return
            if (backgrounded) {
                if (mutableState.value == UpdateInstallState.CheckingPlay) mutableState.value = UpdateInstallState.Idle
                return
            }
            if (info.availableVersionCode() < next.threshold) {
                if (start || next.decision == UpdateDecision.REQUIRED || info.installStatus() == InstallStatus.DOWNLOADED) fail()
                return
            }
            when {
                info.installStatus() == InstallStatus.DOWNLOADED -> {
                    flowType = AppUpdateType.FLEXIBLE
                    playBuild = info.availableVersionCode()
                    downloadedBuild = playBuild
                    mutableState.value = UpdateInstallState.Downloaded
                }
                info.updateAvailability() == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS ->
                    launch(info, AppUpdateType.IMMEDIATE, boundLauncher)
                info.installStatus() == InstallStatus.DOWNLOADING || info.installStatus() == InstallStatus.PENDING -> {
                    flowType = AppUpdateType.FLEXIBLE
                    playBuild = info.availableVersionCode()
                    applyStatus(info.installStatus(), info.bytesDownloaded(), info.totalBytesToDownload())
                }
                start && next.decision != UpdateDecision.NONE -> {
                    if (info.updateAvailability() != UpdateAvailability.UPDATE_AVAILABLE) {
                        fail()
                        return
                    }
                    val type = if (next.decision == UpdateDecision.OPTIONAL && info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE))
                        AppUpdateType.FLEXIBLE else AppUpdateType.IMMEDIATE
                    launch(info, type, boundLauncher)
                }
                info.installStatus() == InstallStatus.INSTALLING -> mutableState.value = UpdateInstallState.Installing
                else -> {
                    if (mutableState.value is UpdateInstallState.Downloading || mutableState.value == UpdateInstallState.Installing || mutableState.value == UpdateInstallState.PlayFlow || mutableState.value == UpdateInstallState.CheckingPlay)
                        mutableState.value = UpdateInstallState.Idle
                }
            }
        } catch (error: CancellationException) {
            if (ticket == generation && mutableState.value == UpdateInstallState.CheckingPlay) mutableState.value = UpdateInstallState.Idle
            throw error
        } catch (_: Exception) {
            if (ticket == generation && owner === boundOwner && request != null) fail(preserveDownloaded = true)
        } finally {
            if (ticket == generation) querying = false
        }
    }

    private fun launch(info: AppUpdateInfo, type: Int, boundLauncher: ActivityResultLauncher<IntentSenderRequest>) {
        if (!info.isUpdateTypeAllowed(type)) {
            fail()
            return
        }
        flowType = type
        playBuild = info.availableVersionCode()
        downloadedBuild = null
        flowActive = true
        mutableState.value = UpdateInstallState.PlayFlow
        if (!manager.startUpdateFlowForResult(info, boundLauncher, AppUpdateOptions.newBuilder(type).build())) {
            flowActive = false
            fail()
        }
    }

    override fun onActivityResult(owner: Any, resultCode: Int) {
        if (this.owner !== owner || !flowActive) return
        flowActive = false
        when (resultCode) {
            Activity.RESULT_OK -> {
                // Consent is not installation proof. The coordinator alone owns admission.
                if (playBuild?.let { build -> request?.let { build >= it.threshold } } != true) {
                    fail()
                    return
                }
                if (mutableState.value != UpdateInstallState.Downloaded && mutableState.value != UpdateInstallState.Installing)
                    mutableState.value = if (flowType == AppUpdateType.FLEXIBLE) UpdateInstallState.Downloading(0) else UpdateInstallState.Installing
            }
            Activity.RESULT_CANCELED -> if (request?.decision == UpdateDecision.REQUIRED) fail(UpdateProblem.INSTALL_CANCELLED) else mutableState.value = UpdateInstallState.Idle
            ActivityResult.RESULT_IN_APP_UPDATE_FAILED -> fail()
            else -> fail()
        }
    }

    override fun onBackground(owner: Any) {
        if (this.owner === owner) {
            needsRecovery = true
            backgrounded = true
        }
    }

    override suspend fun completeUpdate() {
        if (!mutableState.value.restartAvailable || !qualifiedDownloaded() || owner == null) return
        val ticket = generation
        mutableState.value = UpdateInstallState.Installing
        try {
            manager.completeUpdate().awaitResult()
        } catch (error: CancellationException) {
            if (ticket == generation && request != null) {
                if (qualifiedDownloaded()) mutableState.value = UpdateInstallState.Downloaded else fail()
            }
            throw error
        } catch (_: Exception) {
            if (ticket == generation && request != null) fail(preserveDownloaded = true)
        }
    }

    override fun openStore(target: ReleaseTarget) {
        if (runCatching { validateGooglePlayTarget(target, packageName) }.isFailure) {
            fail(UpdateProblem.INVALID_POLICY)
            return
        }
        try {
            launchStore(requireNotNull(target.storeUrl))
            // Retain a flexible download/restart action across the store handoff.
            if (mutableState.value !is UpdateInstallState.Downloading && !mutableState.value.restartAvailable)
                mutableState.value = UpdateInstallState.StoreOpened
        } catch (_: Exception) {
            fail(preserveDownloaded = true)
        }
    }

    override fun cancel() {
        if (request?.decision == UpdateDecision.REQUIRED) {
            fail(UpdateProblem.INSTALL_CANCELLED)
        } else if (mutableState.value !is UpdateInstallState.Downloading && !mutableState.value.restartAvailable && mutableState.value != UpdateInstallState.Installing) {
            mutableState.value = UpdateInstallState.Idle
        }
    }

    private fun applyStatus(status: Int, downloaded: Long, total: Long) {
        if (status in setOf(InstallStatus.PENDING, InstallStatus.DOWNLOADING, InstallStatus.DOWNLOADED, InstallStatus.INSTALLING) &&
            playBuild?.let { build -> request?.let { build >= it.threshold } } != true) {
            fail()
            return
        }
        if (status == InstallStatus.DOWNLOADED) downloadedBuild = playBuild
        else if (status != InstallStatus.INSTALLING) downloadedBuild = null
        mutableState.value = when (status) {
            InstallStatus.PENDING -> UpdateInstallState.Downloading(0)
            InstallStatus.DOWNLOADING -> UpdateInstallState.Downloading(if (total > 0) ((downloaded.toDouble() / total) * 100).toInt().coerceIn(0, 100) else 0)
            InstallStatus.DOWNLOADED -> UpdateInstallState.Downloaded
            InstallStatus.INSTALLING -> UpdateInstallState.Installing
            InstallStatus.INSTALLED -> UpdateInstallState.Idle
            InstallStatus.CANCELED -> if (request?.decision == UpdateDecision.REQUIRED) UpdateInstallState.Failed(UpdateProblem.INSTALL_CANCELLED) else UpdateInstallState.Idle
            InstallStatus.FAILED -> UpdateInstallState.Failed(UpdateProblem.PLAY_UPDATE_UNAVAILABLE)
            else -> mutableState.value
        }
    }

    private fun qualifiedDownloaded(): Boolean =
        downloadedBuild?.let { build -> request?.let { build >= it.threshold } } == true

    private fun fail(problem: UpdateProblem = UpdateProblem.PLAY_UPDATE_UNAVAILABLE, preserveDownloaded: Boolean = false) {
        flowActive = false
        val ready = preserveDownloaded && qualifiedDownloaded()
        if (!ready) downloadedBuild = null
        mutableState.value = UpdateInstallState.Failed(problem, downloaded = ready)
    }
}

private val completionExecutor = Executor { it.run() }
private suspend fun <T> Task<T>.awaitResult(): T = suspendCancellableCoroutine { continuation ->
    addOnCompleteListener(completionExecutor) { completed ->
        if (!continuation.isActive) return@addOnCompleteListener
        when {
            completed.isCanceled -> continuation.cancel()
            completed.isSuccessful -> continuation.resume(completed.result)
            else -> continuation.resumeWithException(completed.exception ?: IllegalStateException("Play update failed"))
        }
    }
}

fun createUpdateInstaller(context: Context): UpdateInstaller {
    val applicationContext = context.applicationContext
    return PlayUpdateInstaller(BuildConfig.APPLICATION_ID, AppUpdateManagerFactory.create(applicationContext)) { url ->
        applicationContext.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
