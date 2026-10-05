package com.hatem.musicmute.ui.settings

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.LaptopMac
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Palette
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

import com.hatem.musicmute.BuildConfig
import com.hatem.musicmute.R
import com.hatem.musicmute.data.LanguageChoice
import com.hatem.musicmute.processing.ProcessingUsage
import com.hatem.musicmute.state.VocalUiState
import com.hatem.musicmute.ui.auth.AccountPublicLinks
import com.hatem.musicmute.ui.design.*
import java.net.URI
import java.util.Locale

internal const val MUSICMUTE_WEB_APP_URL = "https://app.music-mute.com"
internal const val MUSICMUTE_MACOS_DOWNLOADS_URL = "https://music-mute.com/#downloads"

internal fun isTrustedMusicMutePlatformUrl(value: String): Boolean =
    runCatching {
        val uri = URI(value)
        val host = uri.host?.lowercase(Locale.ROOT)
        val rootPath = uri.rawPath.isNullOrEmpty() || uri.rawPath == "/"
        uri.scheme.equals("https", ignoreCase = true) &&
            uri.rawUserInfo == null && uri.port == -1 && uri.rawQuery == null && rootPath &&
            when (host) {
                "app.music-mute.com" -> uri.rawFragment == null
                "music-mute.com" -> uri.rawFragment == "downloads"
                else -> false
            }
    }.getOrDefault(false)

@Composable
fun CreativeSettingsScreen(
    state: VocalUiState,
    onProfile: () -> Unit,
    onAccent: () -> Unit,
    onAbout: () -> Unit,
    onLanguage: (LanguageChoice) -> Unit,
    onRetry: () -> Unit,
    displayName: String? = null,
    usage: ProcessingUsage? = null,
) {
    var showUsage by rememberSaveable { mutableStateOf(false) }
    var showLanguage by rememberSaveable { mutableStateOf(false) }
    val context = LocalContext.current
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
            SettingsItem(stringResource(R.string.creative_settings_support), onProfile)
            SettingsDivider()
            SettingsItem(stringResource(R.string.creative_settings_about), onAbout)
        }
        if (BuildConfig.PRIVACY_URL.isNotBlank()) SettingsSection(stringResource(R.string.creative_settings_legal)) {
            SettingsItem(stringResource(R.string.creative_settings_privacy), {
                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(BuildConfig.PRIVACY_URL))) }
            })
        }
        Text(stringResource(R.string.creative_settings_version, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    if (showUsage) {
        CreativeSheet(onDismiss = { showUsage = false }) {
            Text(stringResource(R.string.creative_settings_usage), style = MaterialTheme.typography.headlineMedium)
            if (usage == null) {
                Text(stringResource(R.string.listener_usage_unavailable), style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                Text(stringResource(R.string.listener_usage_time,
                    (usage.processing.remainingSeconds / 60.0).toInt(),
                    (usage.processing.limitSeconds / 60.0).toInt()),
                    style = MaterialTheme.typography.titleLarge)
                Text(stringResource(R.string.listener_usage_uploads, usage.uploads.dailyRemainingGrants),
                    style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
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
    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainerLow,
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))) {
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
    val context = LocalContext.current
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
        Text(
            stringResource(R.string.creative_settings_other_platforms),
            modifier = Modifier.semantics { heading() },
            style = MaterialTheme.typography.titleLarge,
        )
        PlatformLinkCard(
            title = stringResource(R.string.creative_settings_web),
            description = stringResource(R.string.creative_settings_web_description),
            icon = Icons.Outlined.Language,
            modifier = Modifier.testTag("about-platform-web"),
        ) { context.openMusicMutePlatformUrl(MUSICMUTE_WEB_APP_URL) }
        PlatformLinkCard(
            title = stringResource(R.string.creative_settings_macos),
            description = stringResource(R.string.creative_settings_macos_description),
            icon = Icons.Outlined.LaptopMac,
            modifier = Modifier.testTag("about-platform-macos"),
        ) { context.openMusicMutePlatformUrl(MUSICMUTE_MACOS_DOWNLOADS_URL) }
        Text(stringResource(R.string.creative_settings_version, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        AccountPublicLinks()
    }
}

@Composable
private fun PlatformLinkCard(
    title: String,
    description: String,
    icon: ImageVector,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    CreativeCard(modifier = modifier, onClick = onClick) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(CreativeTokens.ContentGap),
        ) {
            Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(CreativeTokens.CompactGap),
            ) {
                Text(title, style = MaterialTheme.typography.titleMedium)
                Text(
                    description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Icon(
                Icons.AutoMirrored.Outlined.OpenInNew,
                contentDescription = null,
                modifier = Modifier.size(18.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

private fun android.content.Context.openMusicMutePlatformUrl(url: String) {
    if (!isTrustedMusicMutePlatformUrl(url)) return
    runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
}
