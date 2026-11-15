package com.hatem.musicmute.updates

import android.content.Context
import android.content.Intent
import android.net.Uri
import com.hatem.musicmute.BuildConfig
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

private class PlayUpdateInstaller(private val context: Context) : UpdateInstaller {
    private val mutableState = MutableStateFlow<UpdateInstallState>(UpdateInstallState.Idle)
    override val state = mutableState.asStateFlow()
    override suspend fun start(target: ReleaseTarget) {
        val url = target.storeUrl
        if (runCatching { validateGooglePlayTarget(target, BuildConfig.APPLICATION_ID) }.isFailure) {
            mutableState.value = UpdateInstallState.Failed(UpdateProblem.INVALID_POLICY)
            return
        }
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(requireNotNull(url))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (intent.resolveActivity(context.packageManager) == null) {
            mutableState.value = UpdateInstallState.Failed(UpdateProblem.PLAY_UPDATE_UNAVAILABLE)
            return
        }
        context.startActivity(intent)
        mutableState.value = UpdateInstallState.StoreOpened
    }
    override suspend fun onForeground() = Unit
    override fun cancel() { mutableState.value = UpdateInstallState.Idle }
}

fun createUpdateInstaller(
    context: Context,
    api: UpdatePolicyApi,
    installedBuild: () -> Int,
): UpdateInstaller = PlayUpdateInstaller(context)
