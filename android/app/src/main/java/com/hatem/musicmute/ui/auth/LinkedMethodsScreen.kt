package com.hatem.musicmute.ui.auth

import android.app.Activity
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.auth.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

private enum class MethodAction {
    LINK_PASSWORD,
    LINK_GOOGLE,
    UNLINK_PASSWORD,
    UNLINK_GOOGLE,
}

@Composable
internal fun LinkedMethodsScreen(
    auth: AuthSessionCoordinator,
    state: AuthUiState,
    google: GoogleCredentialProvider,
    activity: Activity,
    scope: CoroutineScope,
    onBack: () -> Unit,
) {
    val providers = state.identity?.providers.orEmpty()
    var pending by remember { mutableStateOf<MethodAction?>(null) }
    var password by remember { mutableStateOf("") }
    var confirmation by remember { mutableStateOf("") }
    fun choose(action: MethodAction) {
        password = ""
        confirmation = ""
        pending = action
        auth.dismissMessage()
    }
    AuthPage {
        TextButton(onClick = onBack, enabled = !state.busy) { Text(stringResource(R.string.back)) }
        Text(
            stringResource(R.string.auth_login_methods),
            style = MaterialTheme.typography.headlineLarge,
        )
        Text(stringResource(R.string.auth_methods_description))
        AuthMessages(state, auth::dismissMessage)
        listOf(PASSWORD_PROVIDER, GOOGLE_PROVIDER, APPLE_PROVIDER).forEach { provider ->
            if (provider != APPLE_PROVIDER || provider in providers)
                Card(Modifier.fillMaxWidth()) {
                    Column(
                        Modifier.padding(20.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Text(providerLabel(provider), style = MaterialTheme.typography.titleMedium)
                        Text(
                            stringResource(
                                if (provider in providers) R.string.auth_connected
                                else R.string.auth_not_connected
                            )
                        )
                        if (provider == APPLE_PROVIDER)
                            Text(
                                stringResource(R.string.auth_manage_apple_ios),
                                style = MaterialTheme.typography.bodySmall,
                            )
                        else if (provider in providers) {
                            val removable = canUnlink(providers, provider)
                            OutlinedButton(
                                onClick = {
                                    choose(
                                        if (provider == PASSWORD_PROVIDER)
                                            MethodAction.UNLINK_PASSWORD
                                        else MethodAction.UNLINK_GOOGLE
                                    )
                                },
                                enabled = !state.busy && removable,
                                modifier =
                                    Modifier.testTag(
                                        if (provider == PASSWORD_PROVIDER) "auth-unlink-password"
                                        else "auth-unlink-google"
                                    ),
                            ) {
                                Text(stringResource(R.string.auth_unlink))
                            }
                            if (!removable)
                                Text(
                                    stringResource(R.string.auth_keep_login_method),
                                    style = MaterialTheme.typography.bodySmall,
                                )
                        } else
                            OutlinedButton(
                                onClick = {
                                    choose(
                                        if (provider == PASSWORD_PROVIDER)
                                            MethodAction.LINK_PASSWORD
                                        else MethodAction.LINK_GOOGLE
                                    )
                                },
                                enabled =
                                    !state.busy &&
                                        (provider != PASSWORD_PROVIDER ||
                                            state.identity?.email != null),
                                modifier =
                                    Modifier.testTag(
                                        if (provider == PASSWORD_PROVIDER) "auth-link-password"
                                        else "auth-link-google"
                                    ),
                            ) {
                                Text(stringResource(R.string.auth_link_method))
                            }
                    }
                }
        }
        if (state.profileSyncPending)
            Button(onClick = { scope.launch { auth.refreshAccount() } }, enabled = !state.busy) {
                Text(stringResource(R.string.auth_refresh_account))
            }
    }
    pending?.let { action ->
        val newPassword = action == MethodAction.LINK_PASSWORD
        val passwordRequired =
            newPassword ||
                action == MethodAction.LINK_GOOGLE ||
                action == MethodAction.UNLINK_GOOGLE
        val unlink = action == MethodAction.UNLINK_PASSWORD || action == MethodAction.UNLINK_GOOGLE
        AlertDialog(
            onDismissRequest = {
                pending = null
                password = ""
                confirmation = ""
            },
            title = {
                Text(
                    stringResource(if (unlink) R.string.auth_unlink else R.string.auth_link_method)
                )
            },
            text = {
                Column(
                    Modifier.verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(
                        stringResource(
                            if (unlink) R.string.auth_unlink_description
                            else R.string.auth_reauthenticate_description
                        )
                    )
                    if (newPassword) {
                        Text(state.identity?.email.orEmpty())
                        Text(
                            stringResource(R.string.auth_link_password_email),
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    if (passwordRequired)
                        PasswordField(
                            password,
                            { password = it },
                            if (newPassword) R.string.auth_new_password
                            else R.string.auth_current_password,
                            "auth-method-password",
                            newPassword = newPassword,
                        )
                    if (newPassword)
                        PasswordField(
                            confirmation,
                            { confirmation = it },
                            R.string.auth_confirm_password,
                            "auth-method-confirm",
                            newPassword = true,
                        )
                    if (action == MethodAction.UNLINK_PASSWORD || newPassword)
                        Text(stringResource(R.string.auth_google_reauth))
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        val value = password
                        pending = null
                        password = ""
                        confirmation = ""
                        scope.launch {
                            when (action) {
                                MethodAction.LINK_PASSWORD ->
                                    auth.linkPassword(value) { google.credential(activity) }
                                MethodAction.LINK_GOOGLE ->
                                    auth.linkGoogle(value) { google.credential(activity) }
                                MethodAction.UNLINK_PASSWORD ->
                                    auth.unlink(PASSWORD_PROVIDER, value) {
                                        google.credential(activity)
                                    }
                                MethodAction.UNLINK_GOOGLE ->
                                    auth.unlink(GOOGLE_PROVIDER, value) {
                                        google.credential(activity)
                                    }
                            }
                        }
                    },
                    enabled =
                        (!passwordRequired || password.isNotEmpty()) &&
                            (!newPassword || password == confirmation),
                    modifier = Modifier.testTag("auth-confirm-method"),
                ) {
                    Text(stringResource(R.string.auth_confirm))
                }
            },
            dismissButton = {
                TextButton(
                    onClick = {
                        pending = null
                        password = ""
                        confirmation = ""
                    }
                ) {
                    Text(stringResource(R.string.auth_cancel))
                }
            },
        )
    }
}
