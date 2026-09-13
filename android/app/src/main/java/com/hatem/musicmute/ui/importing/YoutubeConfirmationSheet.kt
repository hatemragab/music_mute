package com.hatem.musicmute.ui.importing

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.ui.design.*

@Composable
fun YoutubeConfirmationSheet(url: String, busy: Boolean, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    var rights by remember(url) { mutableStateOf(false) }
    CreativeSheet(onDismiss = { if (!busy) onDismiss() }) {
        CreativeHeader(stringResource(R.string.youtube_download_action))
        Text(url, style = MaterialTheme.typography.bodySmall)
        Text(stringResource(R.string.youtube_rights_disclosure))
        Row {
            Checkbox(rights, { rights = it }, enabled = !busy)
            Text(stringResource(R.string.audio_rights_confirmation), Modifier.padding(top = 12.dp))
        }
        CreativePrimaryButton(onConfirm, Modifier.fillMaxWidth(), enabled = rights, busy = busy) { Text(stringResource(R.string.youtube_download_action)) }
        OutlinedButton(onDismiss, Modifier.fillMaxWidth(), enabled = !busy) { Text(stringResource(R.string.back)) }
    }
}
