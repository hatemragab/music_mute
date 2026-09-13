package com.hatem.musicmute.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Palette
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.BuildConfig
import com.hatem.musicmute.R
import com.hatem.musicmute.data.LanguageChoice
import com.hatem.musicmute.state.VocalUiState
import com.hatem.musicmute.ui.auth.AccountPublicLinks
import com.hatem.musicmute.ui.design.*

@Composable
fun CreativeSettingsScreen(
    state: VocalUiState,
    onProfile: () -> Unit,
    onAccent: () -> Unit,
    onAbout: () -> Unit,
    onLanguage: (LanguageChoice) -> Unit,
    onRetry: () -> Unit,
) {
    CreativePage {
        CreativeHeader(stringResource(R.string.settings))
        SettingsRow(Icons.Outlined.Person, stringResource(R.string.creative_settings_profile),
            stringResource(R.string.auth_account_description), onProfile, Modifier.testTag("auth-open-account"))
        SettingsRow(Icons.Outlined.Palette, stringResource(R.string.creative_settings_accent),
            stringResource(R.string.creative_settings_accent_description), onAccent)
        if (state.preferencesLoading) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (state.preferencesError) CreativeFeedback(stringResource(R.string.preferences_error), error = true,
            actionLabel = stringResource(R.string.retry), onAction = onRetry)
        CreativeCard {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Icon(Icons.Outlined.Language, null)
                Text(stringResource(R.string.language), style = MaterialTheme.typography.titleMedium)
            }
            Column(Modifier.selectableGroup()) {
                LanguageChoice.entries.forEachIndexed { index, choice ->
                    if (index > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f))
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 56.dp).selectable(
                            selected = state.preferences.language == choice,
                            enabled = !state.preferencesLoading && !state.preferencesError,
                            role = Role.RadioButton, onClick = { onLanguage(choice) },
                        ), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        RadioButton(selected = state.preferences.language == choice, onClick = null)
                        Text(stringResource(when (choice) {
                            LanguageChoice.SYSTEM -> R.string.system_default
                            LanguageChoice.ENGLISH -> R.string.english
                            LanguageChoice.ARABIC -> R.string.arabic
                        }))
                    }
                }
            }
        }
        SettingsRow(Icons.Outlined.Info, stringResource(R.string.about_vocal),
            stringResource(R.string.creative_settings_about_summary), onAbout)
        Text(stringResource(R.string.creative_settings_version, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun SettingsRow(icon: ImageVector, title: String, subtitle: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    CreativeCard(modifier.clickable(onClick = onClick)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Icon(icon, null, Modifier.size(28.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(title, style = MaterialTheme.typography.titleMedium)
                Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Icon(Icons.AutoMirrored.Outlined.ArrowForward, null, Modifier.size(18.dp))
        }
    }
}

@Composable
fun AboutScreen(onBack: () -> Unit) {
    CreativePage {
        TextButton(onClick = onBack) { Text(stringResource(R.string.back)) }
        CreativeHeader(stringResource(R.string.about_vocal), stringResource(R.string.creative_settings_about_summary))
        listOf(
            R.string.creative_settings_about_import,
            R.string.creative_settings_about_process,
            R.string.creative_settings_about_offline,
        ).forEachIndexed { index, description ->
            CreativeCard {
                Text("0${index + 1}", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                Text(stringResource(description), style = MaterialTheme.typography.bodyLarge)
            }
        }
        Text(stringResource(R.string.creative_settings_version, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        AccountPublicLinks()
    }
}
