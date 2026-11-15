package com.hatem.musicmute.updates

import android.app.Activity
import android.os.Handler
import android.os.Looper
import com.azhon.appupdate.listener.LifecycleCallbacksAdapter
import com.azhon.appupdate.listener.OnButtonClickListener
import com.azhon.appupdate.listener.OnDownloadListenerAdapter
import com.azhon.appupdate.manager.DownloadManager
import com.azhon.appupdate.view.UpdateDialogActivity
import com.hatem.musicmute.R
import java.io.File
import java.lang.ref.WeakReference
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.withContext

/** Activity references live only for the prompt; signed URLs never enter logs or saved state. */
internal class AppUpdateDownloadClient(
    private val transport: UpdateDownloadClient,
    private val verifier: ApkVerifier,
) : UpdateDownloadClient {
    private var activity = WeakReference<Activity>(null)
    private var required = false
    private var onLater: () -> Unit = {}
    private var target: ReleaseTarget? = null
    private var grant: ReleaseDownloadGrant? = null
    private var cancelActive: (() -> Unit)? = null

    fun configurePrompt(activity: Activity, required: Boolean, onLater: () -> Unit) {
        this.activity = WeakReference(activity)
        this.required = required
        this.onLater = onLater
    }

    override fun prepare(target: ReleaseTarget, grant: ReleaseDownloadGrant) {
        this.target = target
        this.grant = grant
    }

    override fun download(url: String, destination: File): Flow<UpdateDownloadEvent> = callbackFlow {
        val host = activity.get()
        val selected = target
        val permission = grant
        if (host == null || host.isFinishing || host.isDestroyed || selected == null || permission == null) {
            close(UpdateFailure(UpdateProblem.INSTALLER_UNAVAILABLE))
            return@callbackFlow
        }
        val http = AppUpdateHttpManager(transport, destination, selected, permission, verifier)
        val application = host.application
        val main = Handler(Looper.getMainLooper())
        var dialog = WeakReference<Activity>(null)
        var manager: DownloadManager? = null
        val handoff = AppUpdateHandoff()
        fun deliverAfterHostResume() {
            // Run after MainActivity.onResume, including its installer reconciliation.
            main.post {
                handoff.takeReady()?.let { apk ->
                    trySend(UpdateDownloadEvent.Complete(apk))
                    close()
                }
            }
        }
        val lifecycle = object : LifecycleCallbacksAdapter() {
            override fun onActivityCreated(activity: Activity, savedInstanceState: android.os.Bundle?) {
                if (activity is UpdateDialogActivity) {
                    dialog = WeakReference(activity)
                    handoff.dialogOpened()
                }
            }
            override fun onActivityResumed(activity: Activity) {
                if (activity === host) {
                    handoff.hostResumed()
                    deliverAfterHostResume()
                }
            }
        }
        val stop: () -> Unit = {
            http.cancel()
            close(CancellationException("Update cancelled"))
        }
        cancelActive = stop
        fun cleanup() {
            if (cancelActive === stop) cancelActive = null
            // AppUpdate iterates listeners during callbacks; release on the next main-loop turn.
            main.post {
                dialog.get()?.finish()
                application.unregisterActivityLifecycleCallbacks(lifecycle)
                manager?.release()
            }
        }
        try {
            withContext(Dispatchers.Main.immediate) {
                application.registerActivityLifecycleCallbacks(lifecycle)
                manager = DownloadManager.Builder(host)
                    .apkUrl(url)
                    .apkName(destination.name)
                    .apkVersionCode(selected.buildNumber)
                    .apkVersionName(selected.versionName)
                    .apkDescription(selected.changelogEn.ifBlank { host.getString(R.string.update_available_title) })
                    .apkSize(String.format(Locale.ROOT, "%.1f MB", permission.bytes / 1_000_000.0))
                    .smallIcon(R.mipmap.ic_launcher)
                    .forcedUpgrade(required)
                    .showNotification(false)
                    .showBgdToast(false)
                    .jumpInstallPage(false)
                    .enableLog(false)
                    .httpManager(http)
                    .onButtonClickListener(object : OnButtonClickListener {
                        override fun onButtonClick(id: Int) {
                            if (id == OnButtonClickListener.CANCEL && !required) {
                                stop()
                                onLater()
                            }
                        }
                    })
                    .onDownloadListener(object : OnDownloadListenerAdapter() {
                        override fun start() {
                            trySend(UpdateDownloadEvent.Progress(0, permission.bytes))
                        }
                        override fun downloading(max: Int, progress: Int) {
                            trySend(UpdateDownloadEvent.Progress(progress.toLong(), max.toLong()))
                        }
                        override fun done(apk: File) {
                            // The custom HTTP manager verified this file before AppUpdate saw Done.
                            handoff.verified(apk)
                            main.post {
                                dialog.get()?.finish()
                                deliverAfterHostResume()
                            }
                        }
                        override fun error(e: Throwable) {
                            close(if (e is UpdateFailure) e else UpdateFailure(UpdateProblem.DOWNLOAD_FAILED))
                        }
                        override fun cancel() = stop()
                    })
                    .build()
                manager?.download()
            }
        } catch (error: Exception) {
            http.cancel()
            cleanup()
            throw error
        }
        awaitClose {
            cleanup()
        }
    }

    override fun cancel() {
        cancelActive?.invoke()
        transport.cancel()
    }
}
