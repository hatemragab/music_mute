package com.hatem.musicmute.ui.auth

import android.app.Activity
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.auth.*
import com.hatem.musicmute.ui.design.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

private enum class MethodAction { LINK_PASSWORD, LINK_GOOGLE, UNLINK_PASSWORD, UNLINK_GOOGLE }

@Composable
internal fun LinkedMethodsScreen(
    auth: AuthSessionCoordinator, state: AuthUiState, google: GoogleCredentialProvider,
    activity: Activity, scope: CoroutineScope, onBack: () -> Unit,
) {
    val providers = state.identity?.providers.orEmpty()
    var pending by remember(state.identity?.uid) { mutableStateOf<MethodAction?>(null) }
    var password by remember(state.identity?.uid) { mutableStateOf("") }
    var confirmation by remember(state.identity?.uid) { mutableStateOf("") }
    fun dismiss() { if (!state.busy) { pending = null; password = ""; confirmation = "" } }
    fun choose(action: MethodAction) { password = ""; confirmation = ""; pending = action; auth.dismissMessage() }
    BackHandler(pending != null) { dismiss() }
    val action = pending
    val unlink = action == MethodAction.UNLINK_PASSWORD || action == MethodAction.UNLINK_GOOGLE
    val newPassword = action == MethodAction.LINK_PASSWORD
    val passwordRequired = newPassword || (PASSWORD_PROVIDER in providers && action != MethodAction.UNLINK_PASSWORD)
    val actionForm: @Composable ColumnScope.() -> Unit = {
        AccountSymbol(Icons.Outlined.Lock, Modifier.align(Alignment.CenterHorizontally))
        Text(stringResource(if (newPassword) R.string.creative_account_add_password else if (unlink) R.string.auth_unlink else R.string.creative_account_confirm_identity),
            style = MaterialTheme.typography.headlineSmall)
        Text(stringResource(if (unlink) R.string.auth_unlink_description else R.string.auth_reauthenticate_description))
        Text(state.identity?.email.orEmpty(), color = MaterialTheme.colorScheme.onSurfaceVariant)
        AuthMessages(state, auth::dismissMessage)
        if (newPassword) Text(stringResource(R.string.auth_link_password_email))
        if (passwordRequired) PasswordField(password, { password = it },
            if (newPassword) R.string.auth_new_password else R.string.auth_current_password,
            "auth-method-password", !state.busy, newPassword)
        if (newPassword) {
            PasswordField(confirmation, { confirmation = it }, R.string.auth_confirm_password, "auth-method-confirm", !state.busy, true)
            Text(stringResource(R.string.auth_password_help), style = MaterialTheme.typography.bodySmall)
            if (confirmation.isNotEmpty() && password != confirmation) CreativeFeedback(stringResource(R.string.auth_password_mismatch), error = true)
        }
        if (!passwordRequired || newPassword) Text(stringResource(R.string.auth_google_reauth))
        CreativePrimaryButton(onClick = {
            val value = password
            password = ""; confirmation = ""
            scope.launch {
                when (action) {
                    MethodAction.LINK_PASSWORD -> auth.linkPassword(value) { google.credential(activity) }
                    MethodAction.LINK_GOOGLE -> auth.linkGoogle(value) { google.credential(activity) }
                    MethodAction.UNLINK_PASSWORD -> auth.unlink(PASSWORD_PROVIDER, value) { google.credential(activity) }
                    MethodAction.UNLINK_GOOGLE -> auth.unlink(GOOGLE_PROVIDER, value) { google.credential(activity) }
                    null -> Unit
                }
                if (auth.state.value.failure == null) pending = null
            }
        }, modifier = Modifier.fillMaxWidth().testTag("auth-confirm-method"),
            busy = state.busy, enabled = (!passwordRequired || password.isNotEmpty()) && (!newPassword || password == confirmation)) {
            Text(stringResource(if (unlink) R.string.auth_unlink else R.string.auth_confirm))
        }
        OutlinedButton(::dismiss, Modifier.fillMaxWidth(), enabled = !state.busy) { Text(stringResource(R.string.auth_cancel)) }
    }
    if (action != null && !unlink) {
        AuthPage {
            AccountHeader(stringResource(if (newPassword) R.string.creative_account_add_password else R.string.creative_account_confirm_identity), ::dismiss, !state.busy)
            CreativeCard(content = actionForm)
        }
    } else {
        AuthPage {
            AccountHeader(stringResource(R.string.auth_login_methods), onBack, !state.busy)
            Text(stringResource(R.string.auth_methods_description), style = MaterialTheme.typography.titleLarge)
            AuthMessages(state, auth::dismissMessage)
            CreativeCard {
                listOf(PASSWORD_PROVIDER, GOOGLE_PROVIDER, APPLE_PROVIDER).filter { it != APPLE_PROVIDER || it in providers }.forEachIndexed { index, provider ->
                    if (index > 0) HorizontalDivider()
                    Column(verticalArrangement = Arrangement.spacedBy(CreativeTokens.CompactGap)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(CreativeTokens.CompactGap)) {
                        Icon(Icons.Outlined.Key, null, tint = MaterialTheme.colorScheme.primary)
                        Column(Modifier.weight(1f)) {
                            Text(providerLabel(provider), style = MaterialTheme.typography.titleMedium)
                            Text(stringResource(if (provider in providers) R.string.auth_connected else R.string.auth_not_connected),
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                        if (provider != APPLE_PROVIDER) {
                            val connected = provider in providers
                            TextButton(onClick = { choose(when {
                                provider == PASSWORD_PROVIDER && connected -> MethodAction.UNLINK_PASSWORD
                                provider == PASSWORD_PROVIDER -> MethodAction.LINK_PASSWORD
                                connected -> MethodAction.UNLINK_GOOGLE
                                else -> MethodAction.LINK_GOOGLE
                            }) }, enabled = !state.busy && (if (connected) canUnlink(providers, provider) else provider != PASSWORD_PROVIDER || state.identity?.email != null),
                                modifier = Modifier.testTag(if (connected) { if (provider == PASSWORD_PROVIDER) "auth-unlink-password" else "auth-unlink-google" } else { if (provider == PASSWORD_PROVIDER) "auth-link-password" else "auth-link-google" })) {
                                Text(stringResource(if (connected) R.string.auth_unlink else R.string.auth_link_method))
                            }
                        }
                    }
                    if (provider == APPLE_PROVIDER) Text(stringResource(R.string.auth_manage_apple_ios), style = MaterialTheme.typography.bodySmall)
                }
            }
            Text(stringResource(R.string.auth_keep_login_method), color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedButton(onClick = { scope.launch { auth.refreshAccount() } }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.auth_refresh_account)) }
        }
        if (unlink) CreativeSheet(::dismiss, dismissible = !state.busy) {
            CreativeWave(Modifier.fillMaxWidth())
            Text(stringResource(R.string.creative_account_disconnect, providerLabel(if (action == MethodAction.UNLINK_PASSWORD) PASSWORD_PROVIDER else GOOGLE_PROVIDER)), style = MaterialTheme.typography.titleLarge)
            actionForm()
        }
    }
}
