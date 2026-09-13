package com.hatem.musicmute.ui.importing

import android.text.format.Formatter
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import com.hatem.musicmute.R
import com.hatem.musicmute.ui.design.*
import com.hatem.musicmute.ui.formatElapsed

@Composable
fun ImportReviewSheet(
    title: String,
    bytes: Long?,
    durationMs: Long?,
    busy: Boolean,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
    error: String? = null,
) {
    // Consent is deliberately not restored after process recreation.
    var rights by remember(title) { mutableStateOf(false) }
    CreativeSheet(onDismiss, dismissible = !busy) {
        CreativeHeader(stringResource(R.string.audio_review_title))
        Text(title, style = MaterialTheme.typography.titleLarge)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(CreativeTokens.ContentGap)) {
            durationMs?.let { Text(formatElapsed(it)) }
            bytes?.let { Text(Formatter.formatShortFileSize(LocalContext.current, it)) }
        }
        HorizontalDivider()
        Text(stringResource(R.string.audio_cloud_disclosure))
        CreativeConsentRow(rights, { rights = it }, stringResource(R.string.audio_rights_confirmation), enabled = !busy)
        error?.let { CreativeFeedback(it, error = true) }
        CreativePrimaryButton(onConfirm, Modifier.fillMaxWidth(), enabled = rights, busy = busy) {
            Text(stringResource(R.string.audio_remove_music))
        }
        OutlinedButton(onDismiss, Modifier.fillMaxWidth(), enabled = !busy) { Text(stringResource(R.string.auth_cancel)) }
    }
}
