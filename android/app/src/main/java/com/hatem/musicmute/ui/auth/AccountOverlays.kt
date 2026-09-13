package com.hatem.musicmute.ui.auth

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import com.hatem.musicmute.R
import com.hatem.musicmute.auth.*
import com.hatem.musicmute.ui.design.*

@Composable
internal fun EmailVerificationSheet(state: AuthUiState, email: String, cooldown: Long,
    onDismiss: () -> Unit, onSend: () -> Unit, onCheck: () -> Unit, dismissMessage: () -> Unit) {
    CreativeSheet(onDismiss) {
        CreativeWave(Modifier.fillMaxWidth())
        AccountSymbol(Icons.Outlined.Email, Modifier.align(Alignment.CenterHorizontally))
        Text(stringResource(R.string.creative_account_verify), style = MaterialTheme.typography.headlineSmall)
        Text(email)
        Text(stringResource(R.string.auth_optional_verification))
        AuthMessages(state, dismissMessage)
        CreativePrimaryButton(onSend, Modifier.fillMaxWidth().testTag("auth-verify-email"),
            enabled = cooldown == 0L && state.identity?.email != null, busy = state.busy) {
            Text(if (cooldown > 0) stringResource(R.string.auth_retry_seconds, cooldown) else stringResource(R.string.auth_send_verification))
        }
        OutlinedButton(onCheck, Modifier.fillMaxWidth().testTag("auth-check-verification"), enabled = !state.busy) { Text(stringResource(R.string.auth_check_verification)) }
    }
}

@Composable
internal fun SignOutAllSheet(state: AuthUiState, onDismiss: () -> Unit, onConfirm: () -> Unit, dismissMessage: () -> Unit) {
    CreativeSheet(onDismiss) {
        CreativeWave(Modifier.fillMaxWidth())
        AccountSymbol(Icons.Outlined.Logout, Modifier.align(Alignment.CenterHorizontally))
        Text(stringResource(R.string.auth_logout_all), style = MaterialTheme.typography.headlineSmall)
        Text(stringResource(R.string.auth_logout_all_description))
        AuthMessages(state, dismissMessage)
        CreativePrimaryButton(onConfirm, Modifier.fillMaxWidth().testTag("auth-confirm-logout-all"), busy = state.busy) { Text(stringResource(R.string.auth_logout_all)) }
        OutlinedButton(onDismiss, Modifier.fillMaxWidth(), enabled = !state.busy) { Text(stringResource(R.string.auth_cancel)) }
    }
}

@Composable
internal fun AccountDeletionReviewScreen(state: AuthUiState, password: String, onPassword: (String) -> Unit,
    onCancel: () -> Unit, onContinue: () -> Unit, dismissMessage: () -> Unit) {
    AuthPage {
        AccountHeader(stringResource(R.string.account_delete), onCancel, !state.busy)
        Text(stringResource(R.string.creative_account_delete_step), color = MaterialTheme.colorScheme.onSurfaceVariant)
        listOf(Triple(R.string.creative_account_access, R.string.creative_account_delete_access, Icons.Outlined.DeleteOutline),
            Triple(R.string.creative_account_recovery, R.string.creative_account_delete_recovery, Icons.Outlined.Schedule),
            Triple(R.string.creative_account_files, R.string.creative_account_delete_files, Icons.Outlined.Description)).forEach { (title, body, icon) ->
            CreativeCard { Row(horizontalArrangement = Arrangement.spacedBy(CreativeTokens.ContentGap)) {
                Icon(icon, null, tint = MaterialTheme.colorScheme.error)
                Column(Modifier.weight(1f)) { Text(stringResource(title), style = MaterialTheme.typography.titleMedium); Text(stringResource(body)) }
            } }
        }
        AuthMessages(state, dismissMessage)
        if (PASSWORD_PROVIDER in state.identity?.providers.orEmpty())
            PasswordField(password, onPassword, R.string.auth_current_password, "auth-delete-password", !state.busy)
        else Text(stringResource(R.string.auth_google_reauth))
        CreativePrimaryButton(onContinue, Modifier.fillMaxWidth(), enabled = PASSWORD_PROVIDER !in state.identity?.providers.orEmpty() || password.isNotEmpty(),
            busy = state.busy, destructive = true) { Text(stringResource(R.string.auth_confirm)) }
        OutlinedButton(onCancel, Modifier.fillMaxWidth(), enabled = !state.busy) { Text(stringResource(R.string.auth_cancel)) }
    }
}

@Composable
internal fun AccountDeletionDialog(state: AuthUiState, onDismiss: () -> Unit, onDelete: () -> Unit, dismissMessage: () -> Unit) {
    AlertDialog(onDismissRequest = onDismiss, icon = { Icon(Icons.Outlined.WarningAmber, null, tint = MaterialTheme.colorScheme.error) },
        title = { Text(stringResource(R.string.account_delete)) },
        text = { Column { Text(stringResource(R.string.account_delete_final)); AuthMessages(state, dismissMessage) } },
        confirmButton = { CreativePrimaryButton(onDelete, busy = state.busy, destructive = true) { Text(stringResource(R.string.account_delete)) } },
        dismissButton = { TextButton(onDismiss, enabled = !state.busy) { Text(stringResource(R.string.auth_cancel)) } })
}
