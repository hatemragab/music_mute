package com.hatem.musicmute.ui.library

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.hatem.musicmute.R
import com.hatem.musicmute.ui.design.*

@Composable
fun DeleteAudioSheet(title: String, busy: Boolean, onDismiss: () -> Unit, onDelete: () -> Unit, message: String? = null) {
    CreativeSheet(onDismiss, dismissible = !busy) {
        Text(stringResource(R.string.creative_library_delete_title), style = MaterialTheme.typography.headlineSmall)
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text(stringResource(R.string.creative_library_delete_body), color = MaterialTheme.colorScheme.onSurfaceVariant)
        message?.let { CreativeFeedback(it, error = true) }
        CreativePrimaryButton(onDelete, Modifier.fillMaxWidth(), busy = busy, destructive = true) { Text(stringResource(R.string.creative_library_delete)) }
        OutlinedButton(onDismiss, Modifier.fillMaxWidth(), enabled = !busy) { Text(stringResource(R.string.auth_cancel)) }
    }
}
