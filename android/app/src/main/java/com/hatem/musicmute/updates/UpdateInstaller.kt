package com.hatem.musicmute.updates

import android.content.Context
import android.os.Build
import kotlinx.coroutines.flow.StateFlow

interface UpdateInstaller {
    val state: StateFlow<UpdateInstallState>
    suspend fun start(target: ReleaseTarget)
    suspend fun onForeground()
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
