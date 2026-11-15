package com.hatem.musicmute.ui.auth

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import com.hatem.musicmute.R
import com.hatem.musicmute.auth.*
import com.hatem.musicmute.ui.design.*
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

@Composable
internal fun DevicesScreen(
    auth: AuthSessionCoordinator,
    state: AuthUiState,
    scope: CoroutineScope,
    onBack: () -> Unit,
) {
    var pendingRemoval by remember { mutableStateOf<RegisteredDevice?>(null) }
    pendingRemoval?.let { device ->
        AlertDialog(
            onDismissRequest = { pendingRemoval = null },
            title = { Text(stringResource(R.string.device_history_remove_title)) },
            text = { Text(stringResource(R.string.device_history_remove_body)) },
            confirmButton = {
                TextButton(
                    enabled = !state.busy,
                    onClick = {
                        pendingRemoval = null
                        scope.launch { auth.removeDeviceHistory(device.installationId) }
                    },
                ) { Text(stringResource(R.string.device_history_remove)) }
            },
            dismissButton = {
                TextButton(onClick = { pendingRemoval = null }) {
                    Text(stringResource(R.string.auth_cancel))
                }
            },
        )
    }
    LaunchedEffect(Unit) { auth.loadDevices() }
    AuthPage {
        AccountHeader(stringResource(R.string.auth_devices), onBack, !state.busy)
        Text(stringResource(R.string.auth_devices_description))
        AuthMessages(state, auth::dismissMessage)
        if (state.devicesLoaded && state.devices.isEmpty())
            Text(stringResource(R.string.auth_devices_empty))
        if (state.offline) CreativeFeedback(stringResource(R.string.auth_offline_account))
        listOf(true, false).forEach { current ->
            val group = state.devices.filter {
                (it.installationId == state.installationId) == current
            }
            if (group.isNotEmpty()) {
                Text(
                    stringResource(if (current) R.string.auth_this_device else R.string.device_history_title),
                    style = MaterialTheme.typography.titleMedium,
                )
                if (!current) Text(
                    stringResource(R.string.device_history_description),
                    style = MaterialTheme.typography.bodySmall,
                )
                CreativeCard {
                    group.forEachIndexed { index, device ->
                        if (index > 0) HorizontalDivider()
                        Column(
                            Modifier.fillMaxWidth().testTag("auth-device-${device.installationId}"),
                            verticalArrangement = Arrangement.spacedBy(CreativeTokens.CompactGap),
                        ) {
                            Text(
                                device.deviceModel ?: if (device.platform == "ios") "iOS" else "Android",
                                style = MaterialTheme.typography.titleMedium,
                            )
                            if (current) Text(
                                stringResource(R.string.auth_this_device),
                                color = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.testTag("auth-current-device"),
                            )
                            Text(stringResource(R.string.auth_device_version, device.appVersion, device.buildNumber))
                            Text(stringResource(R.string.auth_device_os, device.platform, device.osVersion))
                            val seen = runCatching {
                                DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM)
                                    .withZone(ZoneId.systemDefault())
                                    .format(Instant.parse(device.lastSeenAt))
                            }.getOrDefault(device.lastSeenAt)
                            Text(
                                stringResource(R.string.auth_device_seen, seen),
                                style = MaterialTheme.typography.bodySmall,
                            )
                            if (!current) {
                                Text(
                                    stringResource(
                                        if (device.sessionStatus == "signed_out") R.string.device_history_signed_out
                                        else R.string.device_history_unknown
                                    ),
                                    style = MaterialTheme.typography.bodySmall,
                                )
                                TextButton(
                                    enabled = !state.busy,
                                    onClick = { pendingRemoval = device },
                                    modifier = Modifier.testTag("auth-remove-device-${device.installationId}"),
                                ) { Text(stringResource(R.string.device_history_remove)) }
                            }
                        }
                    }
                }
            }
        }
        if (state.nextDeviceCursor != null)
            OutlinedButton(
                onClick = { scope.launch { auth.loadDevices(true) } },
                enabled = !state.busy,
                modifier = Modifier.testTag("auth-devices-more"),
            ) {
                Text(stringResource(R.string.auth_load_more))
            }
        TextButton(
            onClick = { scope.launch { auth.loadDevices() } },
            enabled = !state.busy,
            modifier = Modifier.testTag("auth-devices-refresh"),
        ) {
            Text(stringResource(R.string.auth_refresh_account))
        }
    }
}
