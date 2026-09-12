package com.hatem.musicmute.updates

import androidx.compose.runtime.Composable

@Suppress("UNUSED_PARAMETER")
@Composable
internal fun platformUpdatePrompt(
    state: UpdateUiState,
    install: UpdateInstallState,
    installer: UpdateInstaller,
    onUpdate: () -> Unit,
    onLater: () -> Unit,
): Boolean = false
