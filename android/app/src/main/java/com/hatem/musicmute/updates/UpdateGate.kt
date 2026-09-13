package com.hatem.musicmute.updates

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Icon
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CloudDownload
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.ui.design.*

data class UpdatePromptPresentation(
    val visible: Boolean,
    val blocksContent: Boolean,
    val allowLater: Boolean,
    val dismissible: Boolean,
    val showRetry: Boolean,
)

fun updatePromptPresentation(
    state: UpdateUiState,
    install: UpdateInstallState,
): UpdatePromptPresentation {
    val visible = state.decision != UpdateDecision.NONE
    val required = state.decision == UpdateDecision.REQUIRED
    return UpdatePromptPresentation(
        visible = visible,
        blocksContent = required,
        allowLater = state.decision == UpdateDecision.OPTIONAL,
        dismissible = state.decision == UpdateDecision.OPTIONAL,
        showRetry = state.failure != null || install is UpdateInstallState.Failed,
    )
}

@Composable
@Suppress("UNUSED_PARAMETER")
fun UpdateGate(
    state: UpdateUiState,
    install: UpdateInstallState,
    currentVersion: String,
    currentBuild: Int,
    installer: UpdateInstaller,
    onUpdate: () -> Unit,
    onLater: () -> Unit,
    onRetryPolicy: () -> Unit,
    onCancelInstall: () -> Unit,
    content: @Composable () -> Unit,
) {
    if (state.restoring) {
        Surface(Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
        }
        return
    }
    val prompt = updatePromptPresentation(state, install)
    BackHandler(enabled = prompt.blocksContent) {}
    if (prompt.blocksContent) {
        Surface(Modifier.fillMaxSize()) {
            CreativePage(Modifier.safeDrawingPadding()) {
                CreativeHeader(stringResource(R.string.app_name))
                CreativeCard {
                    Icon(Icons.Outlined.CloudDownload, null, Modifier.size(48.dp), tint = MaterialTheme.colorScheme.primary)
                    Text(stringResource(R.string.update_required_title), style = MaterialTheme.typography.headlineMedium)
                    UpdateCardContent(state, install, currentVersion, currentBuild, false,
                        onUpdate, onLater, onRetryPolicy, onCancelInstall)
                }
            }
        }
    } else {
        Column(Modifier.fillMaxSize().then(if (prompt.visible)
            Modifier.windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top)) else Modifier)) {
            if (prompt.visible) {
                Box(Modifier.fillMaxWidth().heightIn(max = 300.dp).verticalScroll(rememberScrollState()).padding(12.dp)) {
                    CreativeCard {
                        Text(stringResource(R.string.update_available_title), style = MaterialTheme.typography.titleMedium)
                        UpdateCardContent(state, install, currentVersion, currentBuild, true,
                            onUpdate, onLater, onRetryPolicy, onCancelInstall)
                    }
                }
            }
            // Keep content at one stable composition location when the optional banner changes.
            Box(Modifier.weight(1f).fillMaxWidth()) { content() }
        }
    }
}

@Composable
private fun UpdateCardContent(
    state: UpdateUiState,
    install: UpdateInstallState,
    currentVersion: String,
    currentBuild: Int,
    optional: Boolean,
    onUpdate: () -> Unit,
    onLater: () -> Unit,
    onRetryPolicy: () -> Unit,
    onCancelInstall: () -> Unit,
) {
    val target = state.snapshot?.target
    val busy =
        install is UpdateInstallState.Downloading ||
            install == UpdateInstallState.Verifying ||
            install == UpdateInstallState.PermissionNeeded ||
            install == UpdateInstallState.AwaitingInstaller
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (target == null) {
            Text(stringResource(R.string.update_loading_details))
        } else {
            Text(
                stringResource(
                    R.string.update_version_message,
                    currentVersion,
                    currentBuild,
                    target.versionName,
                    target.buildNumber,
                )
            )
        }
        target?.changelogEn?.takeIf { !optional && it.isNotBlank() }?.let {
            Text(it, style = MaterialTheme.typography.bodyMedium)
        }
        when (install) {
            is UpdateInstallState.Downloading -> {
                LinearProgressIndicator(
                    progress = { install.percent / 100f },
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(stringResource(R.string.update_downloading, install.percent))
            }
            UpdateInstallState.Verifying -> {
                LinearProgressIndicator(Modifier.fillMaxWidth())
                Text(stringResource(R.string.update_verifying))
            }
            UpdateInstallState.PermissionNeeded -> Text(stringResource(R.string.update_permission_needed))
            UpdateInstallState.AwaitingInstaller -> Text(stringResource(R.string.update_installer_waiting))
            UpdateInstallState.StoreOpened -> Text(stringResource(R.string.update_store_opened))
            is UpdateInstallState.Failed -> Text(updateProblemText(install.problem))
            UpdateInstallState.Idle -> state.failure?.let { Text(updateProblemText(it)) }
        }
        if (state.checking) CircularProgressIndicator(Modifier.padding(top = 4.dp))
    }
    CreativePrimaryButton(onClick = onUpdate, modifier = Modifier.fillMaxWidth(), enabled = !state.checking && !busy && target != null) {
        Text(stringResource(if (state.failure != null || install is UpdateInstallState.Failed) R.string.retry else R.string.update_now))
    }
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        if (state.failure != null) {
            TextButton(onClick = onRetryPolicy, enabled = !state.checking) {
                Text(stringResource(R.string.update_check_again))
            }
        }
        if (optional) {
            TextButton(onClick = { if (busy) onCancelInstall(); onLater() }) {
                Text(stringResource(R.string.update_later))
            }
        }
    }
}

@Composable
private fun updateProblemText(problem: UpdateProblem): String =
    stringResource(
        when (problem) {
            UpdateProblem.OFFLINE -> R.string.update_error_offline
            UpdateProblem.RATE_LIMITED -> R.string.update_error_rate_limited
            UpdateProblem.RELEASE_UNAVAILABLE -> R.string.update_error_release_unavailable
            UpdateProblem.INSUFFICIENT_STORAGE -> R.string.update_error_storage
            UpdateProblem.APK_CHECKSUM_MISMATCH,
            UpdateProblem.APK_SIZE_MISMATCH,
            UpdateProblem.APK_PACKAGE_MISMATCH,
            UpdateProblem.APK_BUILD_MISMATCH,
            UpdateProblem.APK_SIGNER_MISMATCH,
            UpdateProblem.APK_INVALID -> R.string.update_error_invalid_apk
            UpdateProblem.INSTALL_PERMISSION_REQUIRED -> R.string.update_permission_needed
            UpdateProblem.INSTALLER_UNAVAILABLE -> R.string.update_error_installer_unavailable
            UpdateProblem.INSTALL_CANCELLED -> R.string.update_error_install_cancelled
            UpdateProblem.PLAY_UPDATE_UNAVAILABLE -> R.string.update_error_play_unavailable
            else -> R.string.update_error_service
        }
    )
