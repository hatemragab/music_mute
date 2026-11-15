package com.hatem.musicmute.updates

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext

@Composable
internal fun platformUpdatePrompt(
    state: UpdateUiState,
    install: UpdateInstallState,
    installer: UpdateInstaller,
    onUpdate: () -> Unit,
    onLater: () -> Unit,
): Boolean {
    val target = state.snapshot?.target ?: return false
    if (target.source != "direct_apk" || installer !is DirectUpdateInstaller) return false
    val activity = LocalContext.current.findActivity() ?: return false
    val latestLater = rememberUpdatedState(onLater)
    val latestUpdate = rememberUpdatedState(onUpdate)
    val required = state.decision == UpdateDecision.REQUIRED
    DisposableEffect(activity, installer, target.id, required) {
        installer.configurePrompt(activity, required) { latestLater.value() }
        onDispose { installer.releasePrompt() }
    }
    LaunchedEffect(activity, target.id, required) {
        if (install != UpdateInstallState.PermissionNeeded && install != UpdateInstallState.AwaitingInstaller)
            latestUpdate.value()
    }
    // Retain the localized Compose fallback for failures and permission/installer recovery.
    return install == UpdateInstallState.Idle ||
        (required && (install is UpdateInstallState.Downloading || install == UpdateInstallState.Verifying))
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
