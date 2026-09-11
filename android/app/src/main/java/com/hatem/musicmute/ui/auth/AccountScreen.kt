package com.hatem.musicmute.ui.auth

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.BuildConfig
import com.hatem.musicmute.R
import com.hatem.musicmute.auth.*
import java.net.URI
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
internal fun AccountScreen(
    auth: AuthSessionCoordinator,
    state: AuthUiState,
    scope: CoroutineScope,
    onBack: () -> Unit,
    onMethods: () -> Unit,
    onDevices: () -> Unit,
    google: GoogleCredentialProvider,
    activity: android.app.Activity,
) {
    var deletionStep by remember { mutableIntStateOf(0) }
    var deletionPassword by remember { mutableStateOf("") }
    LaunchedEffect(state.failure?.problem) {
        if (state.failure?.problem == AuthProblem.REAUTH_REQUIRED && deletionStep == 2) deletionStep = 1
    }
    var confirmGlobalLogout by remember { mutableStateOf(false) }
    var now by remember { mutableLongStateOf(android.os.SystemClock.elapsedRealtime()) }
    LaunchedEffect(state.verificationCooldownUntil) {
        now = android.os.SystemClock.elapsedRealtime()
        while (now < state.verificationCooldownUntil) {
            delay(1000)
            now = android.os.SystemClock.elapsedRealtime()
        }
    }
    val cooldown = ((state.verificationCooldownUntil - now + 999) / 1000).coerceAtLeast(0)
    val context = LocalContext.current
    AuthPage {
        TextButton(
            onClick = onBack,
            enabled = !state.busy,
            modifier = Modifier.testTag("auth-account-back"),
        ) {
            Text(stringResource(R.string.back))
        }
        Text(stringResource(R.string.auth_account), style = MaterialTheme.typography.headlineLarge)
        if (state.offline)
            Text(
                stringResource(R.string.auth_offline_account),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        AuthMessages(state, auth::dismissMessage)
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    state.profile?.displayName.orEmpty(),
                    style = MaterialTheme.typography.titleLarge,
                )
                SelectionContainer {
                    Text(
                        state.identity?.email
                            ?: state.profile?.email
                            ?: stringResource(R.string.auth_no_email)
                    )
                }
                Text(
                    stringResource(
                        if (state.identity?.emailVerified == true) R.string.auth_verified
                        else R.string.auth_unverified
                    ),
                    modifier = Modifier.testTag("auth-verification-status"),
                )
                if (state.identity?.emailVerified != true) {
                    Text(
                        stringResource(R.string.auth_optional_verification),
                        style = MaterialTheme.typography.bodySmall,
                    )
                    OutlinedButton(
                        onClick = { scope.launch { auth.requestVerification() } },
                        enabled = !state.busy && cooldown == 0L && state.identity?.email != null,
                        modifier = Modifier.testTag("auth-verify-email"),
                    ) {
                        Text(
                            if (cooldown > 0) stringResource(R.string.auth_retry_seconds, cooldown)
                            else stringResource(R.string.auth_send_verification)
                        )
                    }
                    TextButton(
                        onClick = { scope.launch { auth.refreshAccount() } },
                        enabled = !state.busy,
                        modifier = Modifier.testTag("auth-check-verification"),
                    ) {
                        Text(stringResource(R.string.auth_check_verification))
                    }
                }
            }
        }
        OutlinedButton(
            onClick = onMethods,
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth().testTag("auth-linked-methods"),
        ) {
            Text(stringResource(R.string.auth_login_methods))
        }
        OutlinedButton(
            onClick = onDevices,
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth().testTag("auth-devices"),
        ) {
            Text(stringResource(R.string.auth_devices))
        }
        TextButton(
            onClick = { scope.launch { auth.refreshAccount() } },
            enabled = !state.busy,
            modifier = Modifier.testTag("auth-refresh-account"),
        ) {
            Text(stringResource(R.string.auth_refresh_account))
        }
        val accessMessage =
            when {
                state.offline || state.access == null -> R.string.auth_processing_unknown
                state.access.allowed -> R.string.auth_processing_allowed
                state.access.reason == "EMAIL_VERIFICATION_REQUIRED" ->
                    R.string.auth_processing_verification
                state.access.reason == "APP_UPDATE_REQUIRED" -> R.string.auth_processing_update
                state.access.reason == "DEVICE_SYNC_REQUIRED" -> R.string.auth_processing_device
                else -> R.string.auth_processing_unavailable
            }
        Text(stringResource(accessMessage), style = MaterialTheme.typography.bodySmall)
        state.policy?.let { policy ->
            val platform = policy.platforms.android
            if (platform.minimumBuild != null && BuildConfig.VERSION_CODE < platform.minimumBuild) {
                val update =
                    platform.downloadUrl?.takeIf { value ->
                        runCatching {
                                URI(value).let {
                                    it.scheme == "https" &&
                                        !it.host.isNullOrBlank() &&
                                        it.rawUserInfo == null
                                }
                            }
                            .getOrDefault(false)
                    }
                if (update != null)
                    TextButton(
                        onClick = {
                            runCatching {
                                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(update)))
                            }
                        }
                    ) {
                        Text(stringResource(R.string.auth_open_update))
                    }
            }
        }
        TextButton(onClick = { deletionStep = 1; auth.dismissMessage() }, enabled = !state.busy) {
            Text(stringResource(R.string.account_delete), color = MaterialTheme.colorScheme.error)
        }
        AccountPublicLinks()
        HorizontalDivider()
        Button(
            onClick = { auth.signOut() },
            modifier = Modifier.fillMaxWidth().testTag("auth-sign-out"),
        ) {
            Text(stringResource(R.string.auth_sign_out))
        }
        TextButton(
            onClick = { confirmGlobalLogout = true },
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth().testTag("auth-logout-all"),
        ) {
            Text(stringResource(R.string.auth_logout_all))
        }
    }
    if (deletionStep > 0) AlertDialog(
        onDismissRequest = { if (!state.busy) { deletionStep = 0; deletionPassword = "" } },
        title = { Text(stringResource(R.string.account_delete)) },
        text = { Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(if (deletionStep == 1) R.string.account_delete_explanation else R.string.account_delete_final))
            AuthMessages(state, auth::dismissMessage)
            if (deletionStep == 1 && PASSWORD_PROVIDER in state.identity?.providers.orEmpty())
                OutlinedTextField(value = deletionPassword, onValueChange = { deletionPassword = it },
                    label = { Text(stringResource(R.string.auth_password)) }, singleLine = true,
                    visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation())
        } },
        confirmButton = { TextButton(enabled = !state.busy, onClick = {
            if (deletionStep == 1) scope.launch {
                val password = deletionPassword
                deletionPassword = ""
                auth.prepareAccountDeletion(password, { google.credential(activity) }) { deletionStep = 2 }
            } else scope.launch { auth.deleteAccount() }
        }) { Text(stringResource(if (deletionStep == 1) R.string.auth_confirm else R.string.account_delete)) } },
        dismissButton = { TextButton(enabled = !state.busy, onClick = { deletionStep = 0; deletionPassword = "" }) {
            Text(stringResource(R.string.auth_cancel))
        } },
    )
    if (confirmGlobalLogout)
        AlertDialog(
            onDismissRequest = { confirmGlobalLogout = false },
            title = { Text(stringResource(R.string.auth_logout_all)) },
            text = { Text(stringResource(R.string.auth_logout_all_description)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmGlobalLogout = false
                        scope.launch { auth.logoutAll() }
                    },
                    modifier = Modifier.testTag("auth-confirm-logout-all"),
                ) {
                    Text(stringResource(R.string.auth_confirm))
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmGlobalLogout = false }) {
                    Text(stringResource(R.string.auth_cancel))
                }
            },
        )
}

@Composable
internal fun AccountPublicLinks() {
    val context = LocalContext.current
    listOf(BuildConfig.PRIVACY_URL to R.string.account_privacy, BuildConfig.DELETION_URL to R.string.account_deletion_help).forEach { (url, label) ->
        if (url.isNotBlank()) TextButton(onClick = {
            runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
        }) { Text(stringResource(label)) }
    }
}
