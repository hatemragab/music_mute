package com.hatem.musicmute.ui.library

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.hatem.musicmute.R
import com.hatem.musicmute.ui.design.*
import com.hatem.musicmute.processing.validateDisplayName

@Composable
fun RenameAudioSheet(title: String, busy: Boolean, onDismiss: () -> Unit, onRename: (String) -> Unit, message: String? = null) {
    var value by rememberSaveable(title) { mutableStateOf(title) }
    val valid = remember(value) { runCatching { validateDisplayName(value) }.isSuccess }
    CreativeSheet(onDismiss, dismissible = !busy) {
        Text(stringResource(R.string.audio_task_rename), style = MaterialTheme.typography.headlineSmall)
        CreativeTextField(value, { value = it }, stringResource(R.string.creative_library_name), enabled = !busy,
            error = if (!valid) stringResource(R.string.creative_library_name_error) else null)
        message?.let { CreativeFeedback(it, error = true) }
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(CreativeTokens.CompactGap)) {
            TextButton(onDismiss, enabled = !busy) { Text(stringResource(R.string.auth_cancel)) }
            CreativePrimaryButton({ onRename(value.trim()) }, busy = busy, enabled = valid && value.trim() != title) {
                Text(stringResource(R.string.creative_library_save))
            }
        }
    }
}
