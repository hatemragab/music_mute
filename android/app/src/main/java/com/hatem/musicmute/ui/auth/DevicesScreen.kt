package com.hatem.musicmute.ui.auth

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
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
    LaunchedEffect(Unit) { auth.loadDevices() }
    AuthPage {
        AccountHeader(stringResource(R.string.auth_devices), onBack, !state.busy)
        Text(stringResource(R.string.auth_devices_description))
        AuthMessages(state, auth::dismissMessage)
        if (state.devicesLoaded && state.devices.isEmpty())
            Text(stringResource(R.string.auth_devices_empty))
        if (state.offline) CreativeFeedback(stringResource(R.string.auth_offline_account))
        listOf(true, false).forEach { current ->
        val group = state.devices.filter { (it.installationId == state.installationId) == current }
        if (group.isNotEmpty()) {
        Text(stringResource(if (current) R.string.auth_this_device else R.string.creative_account_other_devices), style = MaterialTheme.typography.titleMedium)
        CreativeCard {
        group.forEachIndexed { index, device ->
            if (index > 0) HorizontalDivider()
            Box(Modifier.fillMaxWidth().testTag("auth-device-${device.installationId}")) {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        device.deviceModel ?: if (device.platform == "ios") "iOS" else "Android",
                        style = MaterialTheme.typography.titleMedium,
                    )
                    if (device.installationId == state.installationId)
                        Text(
                            stringResource(R.string.auth_this_device),
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.testTag("auth-current-device"),
                        )
                    Text(
                        stringResource(
                            R.string.auth_device_version,
                            device.appVersion,
                            device.buildNumber,
                        )
                    )
                    Text(stringResource(R.string.auth_device_os, device.platform, device.osVersion))
                    val seen = runCatching {
                        DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM)
                            .withZone(ZoneId.systemDefault())
                            .format(Instant.parse(device.lastSeenAt))
                    }
                        .getOrDefault(device.lastSeenAt)
                    Text(
                        stringResource(R.string.auth_device_seen, seen),
                        style = MaterialTheme.typography.bodySmall,
                    )
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
