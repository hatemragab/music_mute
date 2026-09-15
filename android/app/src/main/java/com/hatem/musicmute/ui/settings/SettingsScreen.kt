package com.hatem.musicmute.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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
    displayName: String? = null,
) {
    var showUsage by rememberSaveable { mutableStateOf(false) }
    var showLanguage by rememberSaveable { mutableStateOf(false) }
    val firstName = displayName?.trim()?.split(Regex("\\s+"))?.firstOrNull()?.takeIf { it.isNotBlank() }
        ?: stringResource(R.string.creative_settings_profile)
    val preferencesEnabled = !state.preferencesLoading && !state.preferencesError
    CreativePage {
        Column {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.settings), Modifier.weight(1f), style = MaterialTheme.typography.headlineLarge)
                Box(Modifier.size(54.dp).clip(CircleShape)
                    .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.12f))
                    .clickable(onClick = onProfile).padding(5.dp), contentAlignment = Alignment.Center) {
                    Text(firstName, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary,
                        textAlign = TextAlign.Center, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            CreativeWave(Modifier.fillMaxWidth().height(70.dp).alpha(0.8f))
        }
        SettingsGroup {
            SettingsItem(stringResource(R.string.creative_settings_account_security), onProfile,
                modifier = Modifier.testTag("auth-open-account"))
        }
        SettingsGroup {
            SettingsItem(stringResource(R.string.creative_settings_usage), { showUsage = true },
                modifier = Modifier.testTag("settings-usage"))
        }
        if (state.preferencesLoading) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (state.preferencesError) CreativeFeedback(stringResource(R.string.preferences_error), error = true,
            actionLabel = stringResource(R.string.retry), onAction = onRetry)
        SettingsSection(stringResource(R.string.creative_settings_preferences)) {
            SettingsItem(stringResource(R.string.creative_settings_accent), onAccent, enabled = preferencesEnabled) {
                Box(Modifier.size(14.dp).background(MaterialTheme.colorScheme.primary, CircleShape))
            }
            SettingsDivider()
            SettingsItem(stringResource(R.string.language), { showLanguage = true }, enabled = preferencesEnabled) {
                Text(stringResource(languageLabel(state.preferences.language)), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        SettingsSection(stringResource(R.string.creative_settings_help)) {
            SettingsItem(stringResource(R.string.creative_settings_feedback))
            SettingsDivider()
            SettingsItem(stringResource(R.string.creative_settings_support))
            SettingsDivider()
            SettingsItem(stringResource(R.string.creative_settings_sponsored))
        }
        SettingsSection(stringResource(R.string.creative_settings_legal)) {
            SettingsItem(stringResource(R.string.creative_settings_terms))
            SettingsDivider()
            SettingsItem(stringResource(R.string.creative_settings_privacy))
            SettingsDivider()
            SettingsItem(stringResource(R.string.creative_settings_about), onAbout)
        }
        Text(stringResource(R.string.creative_settings_version, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    if (showUsage) {
        CreativeSheet(onDismiss = { showUsage = false }) {
            Text(stringResource(R.string.creative_settings_usage), style = MaterialTheme.typography.headlineMedium)
            Text("∞", modifier = Modifier.fillMaxWidth(), fontSize = 64.sp, lineHeight = 72.sp,
                color = MaterialTheme.colorScheme.primary, textAlign = TextAlign.Center)
            Text(stringResource(R.string.creative_settings_usage_unlimited), style = MaterialTheme.typography.titleLarge)
            Text(stringResource(R.string.creative_settings_usage_temporary), style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            CreativePrimaryButton(onClick = { showUsage = false }, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.creative_library_close))
            }
        }
    }
    if (showLanguage) {
        CreativeSheet(onDismiss = { showLanguage = false }) {
            Text(stringResource(R.string.language), style = MaterialTheme.typography.headlineMedium)
            Column(Modifier.selectableGroup()) {
                LanguageChoice.entries.forEach { choice ->
                    Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).selectable(
                        selected = state.preferences.language == choice, enabled = preferencesEnabled, role = Role.RadioButton,
                        onClick = { onLanguage(choice); showLanguage = false }),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        RadioButton(selected = state.preferences.language == choice, onClick = null, enabled = preferencesEnabled)
                        Text(stringResource(languageLabel(choice)))
                    }
                }
            }
        }
    }
}

@Composable
private fun SettingsSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        SettingsGroup(content)
    }
}

@Composable
private fun SettingsGroup(content: @Composable ColumnScope.() -> Unit) {
    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(14.dp), color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Column(content = content)
    }
}

@Composable
private fun SettingsDivider() {
    HorizontalDivider(Modifier.padding(horizontal = 14.dp), color = MaterialTheme.colorScheme.outlineVariant)
}

@Composable
private fun SettingsItem(title: String, onClick: (() -> Unit)? = null, modifier: Modifier = Modifier,
    enabled: Boolean = true, trailing: @Composable () -> Unit = {}) {
    Row(modifier.fillMaxWidth().then(if (onClick != null) Modifier.clickable(enabled = enabled, onClick = onClick) else Modifier)
        .heightIn(min = 52.dp).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(title, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
        trailing()
        Icon(Icons.AutoMirrored.Outlined.ArrowForward, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

private fun languageLabel(choice: LanguageChoice): Int = when (choice) {
    LanguageChoice.SYSTEM -> R.string.system_default
    LanguageChoice.ENGLISH -> R.string.english
    LanguageChoice.ARABIC -> R.string.arabic
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
