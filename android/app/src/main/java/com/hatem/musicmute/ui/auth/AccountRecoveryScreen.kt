package com.hatem.musicmute.ui.auth

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.*
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.compose.runtime.rememberUpdatedState
import com.hatem.musicmute.ui.design.*
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
    var reason by androidx.compose.runtime.saveable.rememberSaveable(state.identity?.uid) { mutableStateOf("") }
    val lifecycleOwner = LocalLifecycleOwner.current
    val latestState by rememberUpdatedState(state)
    LaunchedEffect(request?.status, lifecycleOwner) {
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (isActive && request?.status == "pending") {
                delay(15_000)
                if (!latestState.busy) auth.refreshAccountRecovery()
            }
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
        CreativeWave(Modifier.fillMaxWidth())
        recovery?.deletion?.recoverUntil?.let { deadline ->
            CreativeCard { Text(
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
            ) }
        }
        when {
            recovery?.deletion?.recoveryAvailable == false || request?.status == "expired" ->
                Text(stringResource(R.string.auth_error_recovery_expired))
            request?.status == "pending" -> {
                Text(stringResource(R.string.account_recovery_pending))
                CreativeCard {
                    listOf(R.string.creative_account_submitted, R.string.creative_account_review, R.string.creative_account_decision_pending).forEachIndexed { index, title ->
                        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                            // Pending does not prove that an administrator has started reviewing.
                            Text(if (index == 0) "✓" else "○", color = if (index == 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                            Column { Text(stringResource(title), style = MaterialTheme.typography.titleMedium)
                                if (index > 0) Text(stringResource(R.string.creative_account_no_decision), style = MaterialTheme.typography.bodySmall) }
                        }
                    }
                }
            }
            request?.status == "rejected" -> {
                Text(stringResource(R.string.account_recovery_rejected))
                request.reviewReason?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
            request != null -> {
                // A decided or unfamiliar request must not become a second submission form.
                CreativeFeedback(stringResource(R.string.account_recovery_refresh))
            }
            else -> {
                CreativeCard {
                OutlinedTextField(
                    value = reason,
                    onValueChange = { if (it.length <= 500) reason = it },
                    modifier = Modifier.fillMaxWidth().testTag("account-recovery-reason"),
                    label = { Text(stringResource(R.string.account_recovery_reason)) },
                    supportingText = { Text(stringResource(R.string.creative_account_reason_count, reason.length)) },
                    minLines = 3,
                    enabled = !state.busy && recovery?.deletion?.recoveryAvailable == true,
                )
                CreativePrimaryButton(
                    onClick = { scope.launch { auth.requestAccountRecovery(reason) } },
                    modifier = Modifier.fillMaxWidth().testTag("account-recovery-submit"),
                    enabled = !state.busy && recovery?.deletion?.recoveryAvailable == true,
                ) {
                    Text(stringResource(R.string.account_recovery_send))
                }
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
