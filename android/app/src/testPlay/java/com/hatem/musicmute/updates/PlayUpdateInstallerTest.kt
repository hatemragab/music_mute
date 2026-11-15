package com.hatem.musicmute.updates

import android.app.Activity
import android.app.PendingIntent
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.ActivityOptionsCompat
import com.google.android.gms.tasks.OnCompleteListener
import com.google.android.gms.tasks.OnFailureListener
import com.google.android.gms.tasks.OnSuccessListener
import com.google.android.gms.tasks.Task
import com.google.android.play.core.appupdate.AppUpdateInfo
import com.google.android.play.core.appupdate.AppUpdateManager
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.InstallState
import com.google.android.play.core.install.InstallStateUpdatedListener
import com.google.android.play.core.install.model.ActivityResult
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability
import java.lang.reflect.Proxy
import java.util.concurrent.Executor
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PlayUpdateInstallerTest {
    private val packageName = "com.hatem.musicmute"
    private val storeUrl = "https://play.google.com/store/apps/details?id=$packageName"
    private val target = ReleaseTarget("6aa46ad418983c1bd08b5749", "0.1.15", 15, "Playback improvements", "google_play", storeUrl)
    private val owner = Any()
    private val launcher = object : ActivityResultLauncher<IntentSenderRequest>() {
        override fun launch(input: IntentSenderRequest, options: ActivityOptionsCompat?) = Unit
        override fun unregister() = Unit
        override val contract: ActivityResultContract<IntentSenderRequest, *> = ActivityResultContracts.StartIntentSenderForResult()
    }

    private fun installer(fake: FakeManager, opened: MutableList<String> = mutableListOf(), bind: Boolean = true): PlayUpdateInstaller =
        PlayUpdateInstaller(packageName, fake.manager, opened::add).also { if (bind) it.bindLauncher(owner, launcher) }

    @Test fun requiredImmediateAcceptsMinimumAndIntermediateBuilds() = runTest {
        for (available in listOf(12, 14, 15)) {
            val fake = FakeManager(info(available))
            val installer = installer(fake)
            installer.start(target, UpdateDecision.REQUIRED, 12)
            assertEquals(listOf(AppUpdateType.IMMEDIATE), fake.launched)
            assertEquals(UpdateInstallState.PlayFlow, installer.state.value)
        }
    }

    @Test fun optionalFlexibleRequiresTheDashboardTarget() = runTest {
        val rejected = FakeManager(info(14))
        val installer = installer(rejected)
        installer.start(target, UpdateDecision.OPTIONAL, 12)
        assertTrue(rejected.launched.isEmpty())
        assertEquals(UpdateInstallState.Failed(UpdateProblem.PLAY_UPDATE_UNAVAILABLE), installer.state.value)
        rejected.nextInfo = FakeTask(Result.success(info(15)))
        installer.start(target, UpdateDecision.OPTIONAL, 12)
        assertEquals(listOf(AppUpdateType.FLEXIBLE), rejected.launched)
        assertEquals(2, rejected.queries)
    }

    @Test fun optionalUsesImmediateOnlyWhenFlexibleIsDisallowed() = runTest {
        val fake = FakeManager(info(15, flexible = false))
        installer(fake).start(target, UpdateDecision.OPTIONAL, null)
        assertEquals(listOf(AppUpdateType.IMMEDIATE), fake.launched)
    }

    @Test fun invalidRequiredMinimumFailsClosedBeforeQuery() = runTest {
        for (minimum in listOf(null, 0, -1, 16)) {
            val fake = FakeManager(info(15))
            val installer = installer(fake)
            installer.start(target, UpdateDecision.REQUIRED, minimum)
            assertEquals(UpdateInstallState.Failed(UpdateProblem.INVALID_POLICY), installer.state.value)
            assertEquals(0, fake.queries)
        }
    }

    @Test fun unavailableDisallowedAndBelowMinimumNeverLaunchOrOpenAUrl() = runTest {
        for (info in listOf(info(11), info(15, immediate = false), info(15, availability = UpdateAvailability.UPDATE_NOT_AVAILABLE))) {
            val fake = FakeManager(info)
            val opened = mutableListOf<String>()
            val installer = installer(fake, opened)
            installer.start(target, UpdateDecision.REQUIRED, 12)
            assertEquals(UpdateInstallState.Failed(UpdateProblem.PLAY_UPDATE_UNAVAILABLE), installer.state.value)
            assertTrue(fake.launched.isEmpty())
            assertTrue(opened.isEmpty())
        }
    }

    @Test fun optionalWithNoAllowedTypeAndPlayTaskFailureAreRecoverable() = runTest {
        val fake = FakeManager(info(15, flexible = false, immediate = false))
        val installer = installer(fake)
        installer.start(target, UpdateDecision.OPTIONAL, null)
        assertEquals(UpdateInstallState.Failed(UpdateProblem.PLAY_UPDATE_UNAVAILABLE), installer.state.value)
        fake.nextInfo = FakeTask(Result.failure(SecurityException("Play unavailable")))
        installer.start(target, UpdateDecision.OPTIONAL, null)
        assertEquals(UpdateInstallState.Failed(UpdateProblem.PLAY_UPDATE_UNAVAILABLE), installer.state.value)
    }

    @Test fun invalidTargetsNeverQueryPlayOrOpenForeignUrls() = runTest {
        val fake = FakeManager(info(15))
        val opened = mutableListOf<String>()
        val installer = installer(fake, opened)
        for (invalid in listOf(target.copy(source = "direct_apk"), target.copy(artifact = ReleaseArtifact(1024, "a".repeat(64), "b".repeat(64))),
            target.copy(storeUrl = null), target.copy(storeUrl = "https://example.test/update.apk"),
            target.copy(storeUrl = "$storeUrl&campaign=test"), target.copy(storeUrl = "https://play.google.com:444/store/apps/details?id=$packageName"))) {
            installer.start(invalid, UpdateDecision.REQUIRED, 12)
            installer.openStore(invalid)
            assertEquals(UpdateInstallState.Failed(UpdateProblem.INVALID_POLICY), installer.state.value)
        }
        assertEquals(0, fake.queries)
        assertTrue(opened.isEmpty())
    }

    @Test fun storeFallbackOpensOnlyTheListingAndLaunchFailureIsRecoverable() = runTest {
        val fake = FakeManager(info(15))
        val opened = mutableListOf<String>()
        val installer = installer(fake, opened)
        installer.openStore(target)
        assertEquals(listOf(storeUrl), opened)
        assertEquals(UpdateInstallState.StoreOpened, installer.state.value)
        val denied = PlayUpdateInstaller(packageName, fake.manager) { throw SecurityException("Denied") }
        denied.openStore(target)
        assertEquals(UpdateInstallState.Failed(UpdateProblem.PLAY_UPDATE_UNAVAILABLE), denied.state.value)
    }

    @Test fun missingLauncherFailsClosed() = runTest {
        val fake = FakeManager(info(15))
        val installer = installer(fake, bind = false)
        installer.start(target, UpdateDecision.REQUIRED, 12)
        assertEquals(UpdateInstallState.Failed(UpdateProblem.PLAY_UPDATE_UNAVAILABLE), installer.state.value)
        assertEquals(0, fake.queries)
    }

    @Test fun cancellationAndConsentCannotClearRequiredAdmission() = runTest {
        val fake = FakeManager(info(14))
        val installer = installer(fake)
        val snapshot = UpdatePolicySnapshot(1, 1, "android", "play", 12, target, "2026-10-08T00:00:00Z")
        installer.start(target, UpdateDecision.REQUIRED, 12)
        installer.onActivityResult(owner, Activity.RESULT_CANCELED)
        assertEquals(UpdateInstallState.Failed(UpdateProblem.INSTALL_CANCELLED), installer.state.value)
        assertEquals(UpdateDecision.REQUIRED, decideUpdate(10, snapshot))
        installer.start(target, UpdateDecision.REQUIRED, 12)
        installer.onActivityResult(owner, Activity.RESULT_OK)
        assertEquals(UpdateInstallState.Installing, installer.state.value)
        assertEquals(UpdateDecision.REQUIRED, decideUpdate(10, snapshot))
        assertTrue(updatePromptPresentation(UpdateUiState(restoring = false, decision = UpdateDecision.REQUIRED), installer.state.value).blocksContent)
        assertEquals(UpdateDecision.OPTIONAL, decideUpdate(14, snapshot))
    }

    @Test fun optionalCancellationAndFailedFlowLeaveContentUsable() = runTest {
        val fake = FakeManager(info(15))
        val installer = installer(fake)
        installer.start(target, UpdateDecision.OPTIONAL, null)
        installer.onActivityResult(owner, Activity.RESULT_CANCELED)
        assertEquals(UpdateInstallState.Idle, installer.state.value)
        installer.start(target, UpdateDecision.OPTIONAL, null)
        installer.onActivityResult(owner, ActivityResult.RESULT_IN_APP_UPDATE_FAILED)
        assertEquals(UpdateInstallState.Failed(UpdateProblem.PLAY_UPDATE_UNAVAILABLE), installer.state.value)
        assertFalse(updatePromptPresentation(UpdateUiState(restoring = false, decision = UpdateDecision.OPTIONAL), installer.state.value).blocksContent)
    }

    @Test fun foregroundResumesImmediateWithFreshInfo() = runTest {
        val fake = FakeManager(info(14, availability = UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS))
        val installer = installer(fake)
        installer.onForeground(target, UpdateDecision.REQUIRED, 12)
        assertEquals(listOf(AppUpdateType.IMMEDIATE), fake.launched)
    }

    @Test fun sameActivityResumesInterruptedImmediateWithoutAResultCallback() = runTest {
        val fake = FakeManager(info(14))
        val installer = installer(fake)
        installer.start(target, UpdateDecision.REQUIRED, 12)
        installer.onBackground(owner)
        fake.nextInfo = FakeTask(Result.success(info(14, availability = UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS)))
        installer.onForeground(target, UpdateDecision.REQUIRED, 12)
        assertEquals(listOf(AppUpdateType.IMMEDIATE, AppUpdateType.IMMEDIATE), fake.launched)
        assertEquals(2, fake.queries)
    }

    @Test fun listenerRegistrationFailureCannotCrashTheActivityOrLaunchAFlow() = runTest {
        val fake = FakeManager(info(15))
        fake.failRegistration = true
        val installer = installer(fake)
        installer.start(target, UpdateDecision.REQUIRED, 12)
        assertEquals(UpdateInstallState.Failed(UpdateProblem.PLAY_UPDATE_UNAVAILABLE), installer.state.value)
        assertTrue(fake.launched.isEmpty())
    }

    @Test fun flexibleProgressDownloadAndExplicitRestartSurviveDeferral() = runTest {
        val fake = FakeManager(info(15))
        val installer = installer(fake)
        installer.start(target, UpdateDecision.OPTIONAL, 12)
        installer.onActivityResult(owner, Activity.RESULT_OK)
        fake.emit(InstallStatus.DOWNLOADING, 40, 100)
        assertEquals(UpdateInstallState.Downloading(40), installer.state.value)
        installer.cancel()
        assertEquals(UpdateInstallState.Downloading(40), installer.state.value)
        fake.emit(InstallStatus.DOWNLOADED, 100, 100)
        assertEquals(UpdateInstallState.Downloaded, installer.state.value)
        assertEquals(0, fake.completions)
        assertTrue(updatePromptPresentation(UpdateUiState(restoring = false, decision = UpdateDecision.NONE), installer.state.value).visible)
        installer.cancel()
        assertEquals(UpdateInstallState.Downloaded, installer.state.value)
        installer.completeUpdate()
        assertEquals(1, fake.completions)
        assertEquals(UpdateInstallState.Installing, installer.state.value)
    }

    @Test fun foregroundRecoversDownloadedAndDownloadingAfterProcessRecreation() = runTest {
        for ((status, state) in listOf(InstallStatus.DOWNLOADED to UpdateInstallState.Downloaded, InstallStatus.DOWNLOADING to UpdateInstallState.Downloading(50))) {
            val fake = FakeManager(info(15, status = status, downloaded = 50, total = 100))
            val installer = installer(fake)
            installer.onForeground(target, UpdateDecision.NONE, 12)
            assertEquals(state, installer.state.value)
            assertTrue(fake.launched.isEmpty())
        }
    }

    @Test fun lifecycleUnregistersAndIgnoresStaleQueryListenerAndResult() = runTest {
        val fake = FakeManager(info(15))
        fake.nextInfo = FakeTask()
        val pending = fake.nextInfo
        val installer = installer(fake)
        val oldListener = fake.listeners.single()
        val query = launch { installer.start(target, UpdateDecision.OPTIONAL, null) }
        runCurrent()
        installer.unbindLauncher(owner)
        assertTrue(fake.listeners.isEmpty())
        val replacement = Any()
        installer.bindLauncher(replacement, launcher)
        pending.complete(Result.success(info(15)))
        query.join()
        assertTrue(fake.launched.isEmpty())
        oldListener.onStateUpdate(installState(InstallStatus.DOWNLOADED, 100, 100))
        installer.onActivityResult(owner, Activity.RESULT_CANCELED)
        assertEquals(UpdateInstallState.Idle, installer.state.value)
        // A delayed destruction of the old Activity cannot detach its replacement.
        installer.unbindLauncher(owner)
        assertEquals(1, fake.listeners.size)
    }

    @Test fun duplicateStartsDoNotRelaunchWhileThePlayFlowIsOpen() = runTest {
        val fake = FakeManager(info(15))
        val installer = installer(fake)
        installer.start(target, UpdateDecision.OPTIONAL, null)
        installer.start(target, UpdateDecision.OPTIONAL, null)
        assertEquals(1, fake.queries)
        assertEquals(1, fake.launched.size)
    }

    @Test fun failedCompletionAndFalseLaunchReturnRetryableFailure() = runTest {
        val fake = FakeManager(info(15, status = InstallStatus.DOWNLOADED))
        val installer = installer(fake)
        installer.onForeground(target, UpdateDecision.OPTIONAL, null)
        fake.completion = FakeTask(Result.failure(SecurityException("Install denied")))
        installer.completeUpdate()
        assertEquals(UpdateInstallState.Failed(UpdateProblem.PLAY_UPDATE_UNAVAILABLE, downloaded = true), installer.state.value)
        assertTrue(updatePromptPresentation(UpdateUiState(restoring = false), installer.state.value).visible)
        fake.completion = FakeTask(Result.success(null))
        installer.completeUpdate()
        assertEquals(2, fake.completions)
        assertEquals(UpdateInstallState.Installing, installer.state.value)
        val retryInstaller = installer(fake)
        fake.nextInfo = FakeTask(Result.success(info(15)))
        fake.launchAllowed = false
        retryInstaller.start(target, UpdateDecision.OPTIONAL, null)
        assertEquals(UpdateInstallState.Failed(UpdateProblem.PLAY_UPDATE_UNAVAILABLE), retryInstaller.state.value)
    }

    @Test fun pendingOptionalQueryUsesTheLatestRequiredMinimumAndImmediateType() = runTest {
        val nextTarget = target.copy(id = "6aa46ad418983c1bd08b574a", versionName = "1.0.0", buildNumber = 20)
        for (offeredBuild in listOf(15, 18)) {
            val fake = FakeManager(info(15))
            fake.nextInfo = FakeTask()
            val pending = fake.nextInfo
            val installer = installer(fake)
            val query = launch { installer.start(target, UpdateDecision.OPTIONAL, 12) }
            runCurrent()
            assertEquals(UpdateInstallState.CheckingPlay, installer.state.value)

            // Installed build 14 now needs minimum 16. Updating policy cannot be skipped by the query fence.
            installer.onForeground(nextTarget, UpdateDecision.REQUIRED, 16)
            assertEquals(1, fake.queries)
            pending.complete(Result.success(info(offeredBuild)))
            query.join()

            if (offeredBuild == 15) {
                assertTrue(fake.launched.isEmpty())
                assertEquals(UpdateInstallState.Failed(UpdateProblem.PLAY_UPDATE_UNAVAILABLE), installer.state.value)
            } else {
                assertEquals(listOf(AppUpdateType.IMMEDIATE), fake.launched)
                assertEquals(UpdateInstallState.PlayFlow, installer.state.value)
            }
        }
    }

    @Test fun pendingOptionalQueryCannotStartAfterDeferralOrAWithdrawnTarget() = runTest {
        for (withdrawn in listOf(false, true)) {
            val fake = FakeManager(info(15))
            fake.nextInfo = FakeTask()
            val pending = fake.nextInfo
            val installer = installer(fake)
            val query = launch { installer.start(target, UpdateDecision.OPTIONAL, 12) }
            runCurrent()
            installer.synchronizePolicy(if (withdrawn) null else target, UpdateDecision.NONE, if (withdrawn) null else 12)
            pending.complete(Result.success(info(15)))
            query.join()
            assertTrue(fake.launched.isEmpty())
            assertEquals(UpdateInstallState.Idle, installer.state.value)
        }
    }

    @Test fun supersedingInvalidRequiredPolicyRejectsPendingSuccessAndFailureCallbacks() = runTest {
        for (result in listOf(Result.success(info(20)), Result.failure(SecurityException("Old Play check failed")))) {
            val fake = FakeManager(info(15))
            fake.nextInfo = FakeTask()
            val pending = fake.nextInfo
            val installer = installer(fake)
            val query = launch { installer.start(target, UpdateDecision.OPTIONAL, 12) }
            runCurrent()
            installer.synchronizePolicy(target.copy(buildNumber = 20), UpdateDecision.REQUIRED, null)
            pending.complete(result)
            query.join()
            assertTrue(fake.launched.isEmpty())
            assertEquals(UpdateInstallState.Failed(UpdateProblem.INVALID_POLICY), installer.state.value)
        }
    }

    @Test fun deferredDownloadedUpdateSurvivesForegroundQueryFailureAndCanRestart() = runTest {
        val fake = FakeManager(info(15, status = InstallStatus.DOWNLOADED))
        val installer = installer(fake)
        installer.onForeground(target, UpdateDecision.OPTIONAL, 12)
        fake.nextInfo = FakeTask(Result.failure(SecurityException("Play service temporarily unavailable")))

        installer.onForeground(target, UpdateDecision.NONE, 12)

        assertEquals(UpdateInstallState.Failed(UpdateProblem.PLAY_UPDATE_UNAVAILABLE, downloaded = true), installer.state.value)
        val prompt = updatePromptPresentation(UpdateUiState(restoring = false, decision = UpdateDecision.NONE), installer.state.value)
        assertTrue(prompt.visible)
        assertFalse(prompt.blocksContent)
        installer.completeUpdate()
        assertEquals(1, fake.completions)
        assertEquals(UpdateInstallState.Installing, installer.state.value)
    }

    @Test fun deferredDownloadedUpdateSurvivesCompletionAndStoreFallbackFailures() = runTest {
        val fake = FakeManager(info(15, status = InstallStatus.DOWNLOADED))
        val installer = PlayUpdateInstaller(packageName, fake.manager) { throw SecurityException("Store activity denied") }
        installer.bindLauncher(owner, launcher)
        installer.onForeground(target, UpdateDecision.NONE, 12)
        fake.completion = FakeTask(Result.failure(SecurityException("Completion unavailable")))
        installer.completeUpdate()
        assertTrue(installer.state.value.restartAvailable)

        installer.openStore(target)

        assertEquals(UpdateInstallState.Failed(UpdateProblem.PLAY_UPDATE_UNAVAILABLE, downloaded = true), installer.state.value)
        assertTrue(updatePromptPresentation(UpdateUiState(restoring = false, decision = UpdateDecision.NONE), installer.state.value).visible)
        fake.completion = FakeTask(Result.success(null))
        installer.completeUpdate()
        assertEquals(2, fake.completions)
        assertEquals(UpdateInstallState.Installing, installer.state.value)
    }

    @Test fun aHigherThresholdInvalidatesDownloadedReadinessAndLateDownloadCallbacks() = runTest {
        for (decision in listOf(UpdateDecision.REQUIRED, UpdateDecision.OPTIONAL, UpdateDecision.NONE)) {
            val fake = FakeManager(info(15, status = InstallStatus.DOWNLOADED))
            val installer = installer(fake)
            installer.onForeground(target, UpdateDecision.OPTIONAL, 12)
            assertTrue(installer.state.value.restartAvailable)

            installer.synchronizePolicy(target.copy(buildNumber = 20), decision, 16)
            fake.emit(InstallStatus.DOWNLOADED, 100, 100)

            assertFalse(installer.state.value.restartAvailable)
            assertEquals(UpdateInstallState.Failed(UpdateProblem.PLAY_UPDATE_UNAVAILABLE), installer.state.value)
            installer.completeUpdate()
            assertEquals(0, fake.completions)
            fake.nextInfo = FakeTask(Result.failure(SecurityException("Play unavailable")))
            installer.onForeground(target.copy(buildNumber = 20), decision, 16)
            assertFalse(installer.state.value.restartAvailable)
        }
    }

    @Test fun invalidOrWithdrawnPolicyIgnoresLateInstallCallbacksFromAnOlderDownload() = runTest {
        for (withdrawn in listOf(false, true)) {
            val fake = FakeManager(info(15, status = InstallStatus.DOWNLOADED))
            val installer = installer(fake)
            installer.onForeground(target, UpdateDecision.OPTIONAL, 12)
            installer.synchronizePolicy(if (withdrawn) null else target, if (withdrawn) UpdateDecision.NONE else UpdateDecision.REQUIRED, null)
            fake.emit(InstallStatus.FAILED, 100, 100)
            assertEquals(if (withdrawn) UpdateInstallState.Idle else UpdateInstallState.Failed(UpdateProblem.INVALID_POLICY), installer.state.value)
            installer.completeUpdate()
            assertEquals(0, fake.completions)
        }
    }

    @Test fun downloadedBuildBelowTargetStillQualifiesForTheCurrentRequiredMinimum() = runTest {
        val fake = FakeManager(info(18, status = InstallStatus.DOWNLOADED))
        val installer = installer(fake)
        val nextTarget = target.copy(buildNumber = 20)
        installer.onForeground(nextTarget, UpdateDecision.REQUIRED, 16)
        assertTrue(installer.state.value.restartAvailable)
        fake.nextInfo = FakeTask(Result.failure(SecurityException("Play unavailable")))
        installer.onForeground(nextTarget, UpdateDecision.REQUIRED, 16)
        assertTrue(installer.state.value.restartAvailable)
        installer.completeUpdate()
        assertEquals(1, fake.completions)
    }

    @Test fun aPendingQueryDoesNotOpenAnUpdateWhileTheActivityIsBackgrounded() = runTest {
        val fake = FakeManager(info(15))
        fake.nextInfo = FakeTask()
        val pending = fake.nextInfo
        val installer = installer(fake)
        val query = launch { installer.start(target, UpdateDecision.OPTIONAL, 12) }
        runCurrent()
        installer.onBackground(owner)
        pending.complete(Result.success(info(15)))
        query.join()
        assertTrue(fake.launched.isEmpty())
        assertEquals(UpdateInstallState.Idle, installer.state.value)
    }

    private fun info(build: Int, flexible: Boolean = true, immediate: Boolean = true,
        availability: Int = UpdateAvailability.UPDATE_AVAILABLE, status: Int = InstallStatus.UNKNOWN,
        downloaded: Long = 0, total: Long = 100): AppUpdateInfo {
        // AppUpdateInfo has no public test constructor. No Android runtime or Play service is invoked.
        val unsafeClass = Class.forName("sun.misc.Unsafe")
        val unsafe = unsafeClass.getDeclaredField("theUnsafe").let { it.isAccessible = true; it.get(null) }
        val pending = unsafeClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, PendingIntent::class.java) as PendingIntent
        return AppUpdateInfo::class.java.declaredConstructors.single().let {
            it.isAccessible = true
            it.newInstance(packageName, build, availability, status, null, 0, downloaded, total, 0L, 0L,
                if (immediate) pending else null, if (flexible) pending else null, null, null, emptyMap<Int, Set<Int>>()) as AppUpdateInfo
        }
    }

    private fun installState(status: Int, downloaded: Long, total: Long): InstallState = object : InstallState() {
        override fun installStatus() = status
        override fun bytesDownloaded() = downloaded
        override fun totalBytesToDownload() = total
        override fun installErrorCode() = 0
        override fun packageName() = packageName
    }

    private inner class FakeManager(initial: AppUpdateInfo) {
        var nextInfo = FakeTask(Result.success(initial))
        var completion = FakeTask<Void?>(Result.success(null))
        var queries = 0
        var completions = 0
        var launchAllowed = true
        var failRegistration = false
        val launched = mutableListOf<Int>()
        val listeners = mutableListOf<InstallStateUpdatedListener>()
        val manager = Proxy.newProxyInstance(AppUpdateManager::class.java.classLoader, arrayOf(AppUpdateManager::class.java)) { _, method, args ->
            when (method.name) {
                "getAppUpdateInfo" -> { queries++; nextInfo }
                "registerListener" -> { if (failRegistration) throw SecurityException("Registration denied"); listeners.add(args!![0] as InstallStateUpdatedListener); null }
                "unregisterListener" -> { listeners.remove(args!![0] as InstallStateUpdatedListener); null }
                "startUpdateFlowForResult" -> { launched.add((args!![2] as AppUpdateOptions).appUpdateType()); launchAllowed }
                "completeUpdate" -> { completions++; completion }
                else -> error("Unexpected manager call: ${method.name}")
            }
        } as AppUpdateManager
        fun emit(status: Int, downloaded: Long, total: Long) = listeners.toList().forEach { it.onStateUpdate(installState(status, downloaded, total)) }
    }

    private class FakeTask<T>(private var value: Result<T>? = null) : Task<T>() {
        private val listeners = mutableListOf<Pair<Executor, OnCompleteListener<T>>>()
        fun complete(result: Result<T>) { value = result; listeners.toList().forEach { (executor, listener) -> executor.execute { listener.onComplete(this) } } }
        override fun isComplete() = value != null
        override fun isSuccessful() = value?.isSuccess == true
        override fun isCanceled() = false
        override fun getResult(): T = requireNotNull(value).getOrThrow()
        override fun <X : Throwable> getResult(type: Class<X>): T = result
        override fun getException(): Exception? = value?.exceptionOrNull() as? Exception
        override fun addOnCompleteListener(executor: Executor, listener: OnCompleteListener<T>): Task<T> {
            if (isComplete) executor.execute { listener.onComplete(this) } else listeners.add(executor to listener)
            return this
        }
        override fun addOnSuccessListener(listener: OnSuccessListener<in T>): Task<T> = error("unused")
        override fun addOnSuccessListener(executor: Executor, listener: OnSuccessListener<in T>): Task<T> = error("unused")
        override fun addOnSuccessListener(activity: Activity, listener: OnSuccessListener<in T>): Task<T> = error("unused")
        override fun addOnFailureListener(listener: OnFailureListener): Task<T> = error("unused")
        override fun addOnFailureListener(executor: Executor, listener: OnFailureListener): Task<T> = error("unused")
        override fun addOnFailureListener(activity: Activity, listener: OnFailureListener): Task<T> = error("unused")
    }
}
