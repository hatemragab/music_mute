package com.hatem.musicmute.ui.auth

import androidx.activity.compose.BackHandler
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import com.hatem.musicmute.ui.design.*
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.BuildConfig
import com.hatem.musicmute.R
import com.hatem.musicmute.auth.*
import java.net.URI
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun AccountScreen(
    auth: AuthSessionCoordinator,
    state: AuthUiState,
    scope: CoroutineScope,
    onBack: () -> Unit,
    onMethods: () -> Unit,
    onDevices: () -> Unit,
    google: GoogleCredentialProvider,
    activity: android.app.Activity,
) {
    var deletionStep by remember(state.identity?.uid) { mutableIntStateOf(0) }
    var deletionPassword by remember(state.identity?.uid) { mutableStateOf("") }
    LaunchedEffect(state.failure?.problem) {
        if (state.failure?.problem == AuthProblem.REAUTH_REQUIRED && deletionStep == 2) deletionStep = 1
    }
    var confirmGlobalLogout by remember { mutableStateOf(false) }
    var verify by remember { mutableStateOf(false) }
    LaunchedEffect(state.identity?.emailVerified) {
        if (state.identity?.emailVerified == true) verify = false
    }
    fun cancelDeletion() { if (!state.busy) { deletionStep = 0; deletionPassword = "" } }
    BackHandler(deletionStep > 0) { cancelDeletion() }
    var now by remember { mutableLongStateOf(android.os.SystemClock.elapsedRealtime()) }
    LaunchedEffect(state.verificationCooldownUntil) {
        now = android.os.SystemClock.elapsedRealtime()
        while (now < state.verificationCooldownUntil) {
            delay(1000)
            now = android.os.SystemClock.elapsedRealtime()
        }
    }
    val cooldown = ((state.verificationCooldownUntil - now + 999) / 1000).coerceAtLeast(0)
    val context = LocalContext.current
    if (deletionStep > 0) {
        AccountDeletionReviewScreen(state, deletionPassword, { deletionPassword = it }, ::cancelDeletion, {
            val password = deletionPassword
            deletionPassword = ""
            scope.launch { auth.prepareAccountDeletion(password, { google.credential(activity) }) { deletionStep = 2 } }
        }, auth::dismissMessage)
        if (deletionStep == 2) AccountDeletionDialog(state, ::cancelDeletion,
            { scope.launch { auth.deleteAccount() } }, auth::dismissMessage)
        return
    }
    AuthPage {
        AccountHeader(stringResource(R.string.creative_account_profile), onBack, !state.busy, showWave = false)
        AuthMessages(state, auth::dismissMessage)
        if (state.pendingProfileName != null) {
            Text(stringResource(R.string.creative_account_name_pending))
            TextButton(onClick = { scope.launch { auth.retryProfileName() } }, enabled = !state.busy) {
                Text(stringResource(R.string.retry))
            }
        }
        CreativeCard(contentPadding = 16.dp, contentGap = 8.dp, shape = RoundedCornerShape(14.dp)) {
            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                AccountSymbol(Icons.Outlined.Person, Modifier.size(48.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    val name = state.identity?.displayName?.takeIf { it.isNotBlank() } ?: state.profile?.displayName?.takeIf { it.isNotBlank() }
                    name?.let { Text(it, style = MaterialTheme.typography.titleMedium) }
                    SelectionContainer { Text(state.identity?.email ?: state.profile?.email ?: stringResource(R.string.auth_no_email), style = MaterialTheme.typography.bodySmall) }
                    Text(stringResource(if (state.identity?.emailVerified == true) R.string.auth_verified else R.string.auth_unverified),
                        style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary, modifier = Modifier.testTag("auth-verification-status"))
                    if (state.identity?.emailVerified != true) TextButton(onClick = { verify = true }, enabled = !state.busy) {
                        Text(stringResource(R.string.creative_account_verify))
                    }
                }
            }
            CreativeWave(Modifier.fillMaxWidth().height(28.dp))
        }
        val accessMessage =
            when {
                state.offline || state.access == null -> R.string.auth_processing_unknown
                state.access.allowed -> R.string.auth_processing_allowed
                state.access.reason == "EMAIL_VERIFICATION_REQUIRED" ->
                    R.string.auth_processing_verification
                state.access.reason == "APP_UPDATE_REQUIRED" -> R.string.auth_processing_update
                state.access.reason == "DEVICE_SYNC_REQUIRED" -> R.string.auth_processing_device
                else -> R.string.auth_processing_unavailable
            }
        CreativeCard(contentPadding = 12.dp, contentGap = 8.dp, shape = RoundedCornerShape(12.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (state.offline) Text(stringResource(R.string.auth_offline_account),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(stringResource(accessMessage), style = MaterialTheme.typography.bodySmall)
                }
                OutlinedButton(onClick = { scope.launch { auth.refreshAccount() } },
                    enabled = !state.busy, modifier = Modifier.testTag("auth-refresh-account"),
                    shape = RoundedCornerShape(10.dp), contentPadding = PaddingValues(horizontal = 10.dp, vertical = 6.dp)) {
                    Icon(Icons.Outlined.Refresh, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text(stringResource(R.string.auth_refresh_account), style = MaterialTheme.typography.labelMedium)
                }
            }
            state.policy?.let { policy ->
                val platform = policy.platforms.android
                if (platform.minimumBuild != null && BuildConfig.VERSION_CODE < platform.minimumBuild) {
                    val update =
                        platform.downloadUrl?.takeIf { value ->
                            runCatching {
                                    URI(value).let {
                                        it.scheme == "https" &&
                                            !it.host.isNullOrBlank() &&
                                            it.rawUserInfo == null
                                    }
                                }
                                .getOrDefault(false)
                        }
                    if (update != null)
                        TextButton(
                            onClick = {
                                runCatching {
                                    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(update)))
                                }
                            }
                        ) {
                            Text(stringResource(R.string.auth_open_update))
                        }
                }
            }
        }
        Text(stringResource(R.string.creative_account_section), style = MaterialTheme.typography.labelMedium)
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ProfileActionTile(stringResource(R.string.auth_login_methods), Icons.Outlined.Key,
                Modifier.weight(1f).widthIn(min = 140.dp).testTag("auth-linked-methods"), !state.busy, onMethods)
            ProfileActionTile(stringResource(R.string.auth_devices), Icons.Outlined.Devices,
                Modifier.weight(1f).widthIn(min = 140.dp).testTag("auth-devices"), !state.busy, onDevices)
        }
        Text(stringResource(R.string.creative_account_session), style = MaterialTheme.typography.labelMedium)
        AccountActionRow(stringResource(R.string.auth_sign_out), Icons.Outlined.Logout, Modifier.testTag("auth-sign-out"), !state.busy, onClick = auth::signOut)
        AccountActionRow(stringResource(R.string.auth_logout_all), Icons.Outlined.People, Modifier.testTag("auth-logout-all"), !state.busy, onClick = { confirmGlobalLogout = true })
        HorizontalDivider()
        AccountActionRow(stringResource(R.string.account_delete), Icons.Outlined.DeleteOutline, enabled = !state.busy, destructive = true,
            onClick = { deletionStep = 1; auth.dismissMessage() })
        AccountPublicLinks()
    }
    if (verify) EmailVerificationSheet(state, state.identity?.email ?: state.profile?.email.orEmpty(), cooldown,
        { if (!state.busy) verify = false }, { scope.launch { auth.requestVerification() } },
        { scope.launch { auth.refreshAccount() } }, auth::dismissMessage)
    if (confirmGlobalLogout) SignOutAllSheet(state, { if (!state.busy) confirmGlobalLogout = false },
        { scope.launch { auth.logoutAll() } }, auth::dismissMessage)

}

@Composable
internal fun AccountPublicLinks() {
    val context = LocalContext.current
    listOf(BuildConfig.PRIVACY_URL to R.string.account_privacy, BuildConfig.DELETION_URL to R.string.account_deletion_help).forEach { (url, label) ->
        if (url.isNotBlank()) TextButton(onClick = {
            runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
        }) { Text(stringResource(label)) }
    }
}

@Composable
private fun ProfileActionTile(
    title: String, icon: ImageVector, modifier: Modifier, enabled: Boolean, onClick: () -> Unit,
) {
    Surface(onClick = onClick, enabled = enabled, modifier = modifier,
        shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Column(Modifier.heightIn(min = 80.dp).padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(icon, null, Modifier.size(24.dp))
            Text(title, style = MaterialTheme.typography.labelMedium)
        }
    }
}
