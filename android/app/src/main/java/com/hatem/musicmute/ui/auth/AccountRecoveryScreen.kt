package com.hatem.musicmute.ui.auth

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Restore
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import com.hatem.musicmute.R
import com.hatem.musicmute.auth.AuthSessionCoordinator
import com.hatem.musicmute.auth.AuthUiState
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

@Composable
internal fun AccountRecoveryScreen(
    auth: AuthSessionCoordinator,
    state: AuthUiState,
    scope: CoroutineScope,
) {
    val recovery = state.accountRecovery
    val request = recovery?.request
    var reason by remember { mutableStateOf("") }
    LaunchedEffect(request?.status) {
        while (isActive && request?.status == "pending") {
            delay(15_000)
            if (!state.busy) auth.refreshAccountRecovery()
        }
    }
    AuthPage {
        Icon(
            Icons.Outlined.Restore,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
        )
        Text(
            stringResource(R.string.account_recovery_title),
            style = MaterialTheme.typography.headlineMedium,
        )
        Text(stringResource(R.string.account_recovery_description))
        recovery?.deletion?.recoverUntil?.let { deadline ->
            Text(
                stringResource(
                    R.string.account_recovery_deadline,
                    runCatching {
                            DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM)
                                .withZone(ZoneId.systemDefault())
                                .format(Instant.parse(deadline))
                        }
                        .getOrDefault(deadline),
                ),
                style = MaterialTheme.typography.titleMedium,
            )
        }
        when {
            recovery?.deletion?.recoveryAvailable == false || request?.status == "expired" ->
                Text(stringResource(R.string.auth_error_recovery_expired))
            request?.status == "pending" ->
                Text(stringResource(R.string.account_recovery_pending))
            request?.status == "rejected" -> {
                Text(stringResource(R.string.account_recovery_rejected))
                request.reviewReason?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
            else -> {
                OutlinedTextField(
                    value = reason,
                    onValueChange = { if (it.length <= 500) reason = it },
                    modifier = Modifier.fillMaxWidth().testTag("account-recovery-reason"),
                    label = { Text(stringResource(R.string.account_recovery_reason)) },
                    supportingText = { Text(stringResource(R.string.account_recovery_optional)) },
                    minLines = 3,
                    enabled = !state.busy && recovery?.deletion?.recoveryAvailable == true,
                )
                Button(
                    onClick = { scope.launch { auth.requestAccountRecovery(reason) } },
                    modifier = Modifier.fillMaxWidth().testTag("account-recovery-submit"),
                    enabled = !state.busy && recovery?.deletion?.recoveryAvailable == true,
                ) {
                    Text(stringResource(R.string.account_recovery_send))
                }
            }
        }
        AuthMessages(state, auth::dismissMessage)
        TextButton(
            onClick = { scope.launch { auth.refreshAccountRecovery() } },
            modifier = Modifier.fillMaxWidth().testTag("account-recovery-refresh"),
            enabled = !state.busy,
        ) {
            Text(stringResource(R.string.account_recovery_refresh))
        }
        TextButton(
            onClick = { auth.signOut() },
            modifier = Modifier.fillMaxWidth().testTag("account-recovery-sign-out"),
            enabled = !state.busy,
        ) {
            Text(stringResource(R.string.auth_sign_out))
        }
    }
}
