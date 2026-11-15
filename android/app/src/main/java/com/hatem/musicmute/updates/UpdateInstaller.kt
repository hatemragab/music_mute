package com.hatem.musicmute.updates

import android.content.Context
import android.os.Build
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.IntentSenderRequest
import kotlinx.coroutines.flow.StateFlow

interface UpdateInstaller {
    val state: StateFlow<UpdateInstallState>
    fun bindLauncher(owner: Any, launcher: ActivityResultLauncher<IntentSenderRequest>)
    fun unbindLauncher(owner: Any)
    fun onActivityResult(owner: Any, resultCode: Int)
    fun onBackground(owner: Any)
    fun synchronizePolicy(target: ReleaseTarget?, decision: UpdateDecision, minimumBuild: Int?)
    suspend fun start(target: ReleaseTarget, decision: UpdateDecision, minimumBuild: Int?)
    suspend fun onForeground(target: ReleaseTarget?, decision: UpdateDecision, minimumBuild: Int?)
    suspend fun completeUpdate()
    fun openStore(target: ReleaseTarget)
    fun cancel()
}

class UpdateAdmission(private val state: StateFlow<UpdateUiState>) {
    fun isRequired(): Boolean = state.value.decision == UpdateDecision.REQUIRED

    fun isBlocked(): Boolean =
        state.value.restoring || isRequired()
    fun requireAllowed() {
        if (isBlocked()) throw UpdateFailure(UpdateProblem.UPDATE_REQUIRED)
    }
}

fun installedBuildNumber(context: Context): Int {
    @Suppress("DEPRECATION")
    val info = context.packageManager.getPackageInfo(context.packageName, 0)
    val value =
        if (Build.VERSION.SDK_INT >= 28) info.longVersionCode
        else @Suppress("DEPRECATION") info.versionCode.toLong()
    if (value !in 1..Int.MAX_VALUE.toLong()) throw UpdateFailure(UpdateProblem.INVALID_POLICY)
    return value.toInt()
}
