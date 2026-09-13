package com.hatem.musicmute.ui.auth

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.auth.*
import com.hatem.musicmute.ui.design.*
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion

@Composable
internal fun AuthPage(content: @Composable ColumnScope.() -> Unit) {
    Surface(Modifier.fillMaxSize()) {
        CreativePage(Modifier.safeDrawingPadding(), content = content)
    }
}

@Composable
internal fun PasswordField(
    value: String,
    onValueChange: (String) -> Unit,
    label: Int,
    tag: String,
    enabled: Boolean = true,
    newPassword: Boolean = false,
) {
    var visible by remember { mutableStateOf(false) }
    CreativeTextField(
        value,
        onValueChange,
        label = stringResource(label),
        modifier = Modifier.fillMaxWidth().testTag(tag).semantics {
            contentType = if (newPassword) ContentType.NewPassword else ContentType.Password
        },
        enabled = enabled,
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        visualTransformation =
            if (visible) VisualTransformation.None else PasswordVisualTransformation(),
        trailingIcon = {
            IconButton(onClick = { visible = !visible }, enabled = enabled) {
                Icon(
                    if (visible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                    stringResource(
                        if (visible) R.string.auth_hide_password else R.string.auth_show_password
                    ),
                )
            }
        },
    )
}

@Composable
internal fun AuthMessages(state: AuthUiState, dismiss: () -> Unit) {
    if (state.deletionUnconfirmed) Text(stringResource(R.string.account_deletion_unconfirmed))
    state.failure?.let { failure ->
        Card(
            colors =
                CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
            modifier = Modifier.fillMaxWidth().testTag("auth-error").semantics { liveRegion = LiveRegionMode.Polite },
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    stringResource(failure.problem.messageResource()),
                    color = MaterialTheme.colorScheme.onErrorContainer,
                )
                TextButton(onClick = dismiss) { Text(stringResource(R.string.auth_dismiss)) }
            }
        }
    }
    state.notice?.let { notice ->
        Card(
            colors =
                CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.secondaryContainer
                ),
            modifier = Modifier.fillMaxWidth().testTag("auth-notice").semantics { liveRegion = LiveRegionMode.Polite },
        ) {
            Text(
                stringResource(
                    when (notice) {
                        AuthNotice.VERIFICATION_SENT -> R.string.auth_verification_sent
                        AuthNotice.ALREADY_VERIFIED -> R.string.auth_already_verified
                        AuthNotice.PASSWORD_RESET_SENT -> R.string.auth_reset_sent
                        AuthNotice.METHOD_LINKED -> R.string.auth_method_linked
                        AuthNotice.METHOD_UNLINKED -> R.string.auth_method_unlinked
                        AuthNotice.PROFILE_UPDATED -> R.string.auth_profile_updated
                        AuthNotice.DELETION_ACCEPTED -> R.string.account_deletion_accepted
                    }
                ),
                Modifier.padding(16.dp),
            )
        }
    }
    if (state.profileSyncPending)
        Text(
            stringResource(R.string.auth_sync_pending),
            color = MaterialTheme.colorScheme.error,
            modifier = Modifier.testTag("auth-sync-pending"),
        )
    if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth().testTag("auth-progress"))
}

private fun AuthProblem.messageResource(): Int =
    when (this) {
        AuthProblem.INVALID_INPUT -> R.string.auth_error_input
        AuthProblem.INVALID_CREDENTIALS -> R.string.auth_error_credentials
        AuthProblem.EMAIL_IN_USE -> R.string.auth_error_email_in_use
        AuthProblem.CREDENTIAL_IN_USE -> R.string.auth_error_link_conflict
        AuthProblem.WEAK_PASSWORD -> R.string.auth_error_weak_password
        AuthProblem.REAUTH_REQUIRED -> R.string.auth_error_reauth
        AuthProblem.ACCOUNT_MISMATCH -> R.string.auth_error_account_mismatch
        AuthProblem.UNAUTHENTICATED -> R.string.auth_error_session_expired
        AuthProblem.ACCOUNT_DISABLED -> R.string.auth_error_disabled
        AuthProblem.ACCOUNT_DELETION_PENDING -> R.string.auth_error_deletion_pending
        AuthProblem.ACCOUNT_RECOVERY_EXPIRED -> R.string.auth_error_recovery_expired
        AuthProblem.RATE_LIMITED -> R.string.auth_error_rate
        AuthProblem.OFFLINE -> R.string.auth_error_offline
        AuthProblem.SERVICE_UNAVAILABLE -> R.string.auth_error_service
        AuthProblem.CONFIGURATION -> R.string.auth_error_configuration
        AuthProblem.STORAGE -> R.string.auth_error_storage
        AuthProblem.LAST_METHOD -> R.string.auth_error_last_method
        AuthProblem.EMAIL_UNAVAILABLE -> R.string.auth_error_email_unavailable
        AuthProblem.CANCELLED -> R.string.auth_cancel
        AuthProblem.PROFILE_SYNC_REQUIRED -> R.string.auth_error_profile_sync
        AuthProblem.DEVICE_CONFLICT -> R.string.auth_error_device_conflict
        AuthProblem.GLOBAL_LOGOUT_UNCONFIRMED -> R.string.auth_error_global_logout
    }

@Composable
internal fun providerLabel(provider: String): String =
    stringResource(
        when (provider) {
            PASSWORD_PROVIDER -> R.string.auth_email_password
            GOOGLE_PROVIDER -> R.string.auth_google
            APPLE_PROVIDER -> R.string.auth_apple
            else -> R.string.auth_other_provider
        }
    )
