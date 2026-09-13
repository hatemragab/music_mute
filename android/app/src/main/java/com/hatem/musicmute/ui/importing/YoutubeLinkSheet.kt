package com.hatem.musicmute.ui.importing

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import com.hatem.musicmute.R
import com.hatem.musicmute.ui.design.*

@Composable
fun YoutubeLinkSheet(
    url: String,
    invalidUrl: Boolean,
    busy: Boolean,
    onUrl: (String) -> Unit,
    onPaste: () -> Unit,
    onContinue: () -> Unit,
    onDismiss: () -> Unit,
) {
    CreativeSheet(onDismiss) {
        CreativeHeader(stringResource(R.string.creative_jobs_bring_audio), stringResource(R.string.creative_jobs_youtube_subtitle))
        CreativeTextField(url, onUrl, stringResource(R.string.link_label), enabled = !busy,
            error = if (invalidUrl) stringResource(R.string.invalid_url) else null,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
        TextButton(onPaste, enabled = !busy) { Text(stringResource(R.string.paste)) }
        Text(stringResource(R.string.youtube_rights_disclosure), color = MaterialTheme.colorScheme.onSurfaceVariant)
        CreativePrimaryButton(onContinue, Modifier.fillMaxWidth(), enabled = url.isNotBlank(), busy = busy) { Text(stringResource(R.string.creative_jobs_continue)) }
        OutlinedButton(onDismiss, Modifier.fillMaxWidth(), enabled = !busy) { Text(stringResource(R.string.auth_cancel)) }
    }
}
