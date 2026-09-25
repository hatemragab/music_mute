package com.hatem.musicmute.ui.importing

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.hatem.musicmute.R
import com.hatem.musicmute.ui.design.CreativeConsentRow
import com.hatem.musicmute.ui.design.CreativeHeader
import com.hatem.musicmute.ui.design.CreativePrimaryButton
import com.hatem.musicmute.ui.design.CreativeSheet

@Composable
fun UrlImportConfirmationSheet(url: String, busy: Boolean, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    var rights by remember(url) { mutableStateOf(false) }
    CreativeSheet(onDismiss, dismissible = !busy) {
        CreativeHeader(stringResource(R.string.url_import_title))
        Text(url, style = MaterialTheme.typography.bodySmall)
        Text(stringResource(R.string.url_import_rights_disclosure))
        CreativeConsentRow(rights, { rights = it }, stringResource(R.string.audio_rights_confirmation), enabled = !busy)
        CreativePrimaryButton(onConfirm, Modifier.fillMaxWidth(), enabled = rights && !busy, busy = busy) {
            Text(stringResource(R.string.url_import_action))
        }
        OutlinedButton(onDismiss, Modifier.fillMaxWidth(), enabled = !busy) {
            Text(stringResource(R.string.back))
        }
    }
}
