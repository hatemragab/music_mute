package com.hatem.musicmute.ui.auth

import android.app.Activity
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Headphones
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.auth.*
import com.hatem.musicmute.ui.design.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private enum class FormMode {
    LOGIN,
    REGISTER,
    RESET,
}

@Composable
internal fun AuthScreen(
    auth: AuthSessionCoordinator,
    state: AuthUiState,
    google: GoogleCredentialProvider,
    activity: Activity,
    scope: CoroutineScope,
    onToggleLanguage: () -> Unit,
) {
    var mode by rememberSaveable { mutableStateOf(FormMode.LOGIN) }
    var email by rememberSaveable { mutableStateOf("") }
    var fullName by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirmation by remember { mutableStateOf("") }
    val keyboard = LocalSoftwareKeyboardController.current
    var now by remember { mutableLongStateOf(android.os.SystemClock.elapsedRealtime()) }
    LaunchedEffect(state.resetCooldownUntil) {
        now = android.os.SystemClock.elapsedRealtime()
        while (now < state.resetCooldownUntil) {
            delay(1000)
            now = android.os.SystemClock.elapsedRealtime()
        }
    }
    val cooldown =
        if (state.resetEmail == email.trim())
            ((state.resetCooldownUntil - now + 999) / 1000).coerceAtLeast(0)
        else 0
    val enabled = !state.busy && auth.configured()
    fun switch(next: FormMode) {
        mode = next
        password = ""
        confirmation = ""
        auth.dismissMessage()
    }
    BackHandler(mode != FormMode.LOGIN) { if (!state.busy) switch(FormMode.LOGIN) }

    CreativeNavigation(mode, direction = { from, to -> to.ordinal - from.ordinal }) { visibleMode ->
    AuthPage {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = onToggleLanguage, enabled = !state.busy) {
                Text(stringResource(R.string.auth_language))
            }
        }
        Text(
            stringResource(R.string.app_name),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.primary,
        )
        Text(
            stringResource(
                when (visibleMode) {
                    FormMode.LOGIN -> R.string.creative_account_login_hero
                    FormMode.REGISTER -> R.string.creative_account_register_hero
                    FormMode.RESET -> R.string.creative_account_reset_hero
                }
            ),
            style = MaterialTheme.typography.headlineLarge,
            modifier = Modifier.testTag("auth-title"),
        )
        CreativeWave(Modifier.fillMaxWidth().height(88.dp))
        CreativeCard {
        Text(stringResource(when (visibleMode) {
            FormMode.LOGIN -> R.string.auth_sign_in
            FormMode.REGISTER -> R.string.auth_create_account
            FormMode.RESET -> R.string.auth_reset_title
        }), style = MaterialTheme.typography.titleLarge)
        Text(
            stringResource(
                when (visibleMode) {
                    FormMode.LOGIN -> R.string.auth_login_description
                    FormMode.REGISTER -> R.string.auth_register_description
                    FormMode.RESET -> R.string.auth_reset_description
                }
            ),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (!auth.configured())
            Text(
                stringResource(R.string.auth_error_configuration),
                color = MaterialTheme.colorScheme.error,
            )
        AuthMessages(state, auth::dismissMessage)
        if (visibleMode == FormMode.REGISTER) {
            CreativeTextField(
                fullName, { fullName = it },
                label = stringResource(R.string.creative_account_full_name),
                modifier = Modifier.fillMaxWidth().testTag("auth-full-name").semantics { contentType = ContentType.PersonFullName },
                enabled = !state.busy, singleLine = true,
                error = if (fullName.isNotEmpty() && runCatching { validatedFullName(fullName) }.isFailure) stringResource(R.string.auth_error_input) else null,
            )
        }
        CreativeTextField(
            email,
            { email = it },
            label = stringResource(R.string.auth_email),
            modifier = Modifier.fillMaxWidth().testTag("auth-email").semantics {
                contentType = ContentType.EmailAddress
            },
            enabled = !state.busy,
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
        )
        if (visibleMode != FormMode.RESET)
            PasswordField(
                password,
                { password = it },
                R.string.auth_password,
                "auth-password",
                !state.busy,
                visibleMode == FormMode.REGISTER,
            )
        if (visibleMode == FormMode.REGISTER) {
            PasswordField(
                confirmation,
                { confirmation = it },
                R.string.auth_confirm_password,
                "auth-confirm-password",
                !state.busy,
                true,
            )
            if (confirmation.isNotEmpty() && password != confirmation)
                Text(
                    stringResource(R.string.auth_password_mismatch),
                    color = MaterialTheme.colorScheme.error,
                )
            Text(
                stringResource(R.string.auth_password_help),
                style = MaterialTheme.typography.bodySmall,
            )
        }
        CreativePrimaryButton(
            onClick = {
                keyboard?.hide()
                scope.launch {
                    if (visibleMode == FormMode.RESET) auth.requestPasswordReset(email)
                    else auth.signInEmail(email, password, visibleMode == FormMode.REGISTER, fullName)
                    password = ""
                    confirmation = ""
                }
            },
            modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("auth-submit"),
            busy = state.busy,
            enabled =
                enabled &&
                    validAuthEmail(email.trim()) &&
                    (if (visibleMode == FormMode.RESET) cooldown == 0L
                    else
                        password.isNotEmpty() &&
                            (visibleMode != FormMode.REGISTER ||
                                (password == confirmation && runCatching { validatedFullName(fullName) }.isSuccess))),
        ) {
            Text(
                if (visibleMode == FormMode.RESET && cooldown > 0)
                    stringResource(R.string.auth_retry_seconds, cooldown)
                else
                    stringResource(
                        when (visibleMode) {
                            FormMode.LOGIN -> R.string.auth_sign_in
                            FormMode.REGISTER -> R.string.auth_create_account
                            FormMode.RESET -> R.string.auth_send_reset
                        }
                    )
            )
        }
        if (visibleMode != FormMode.RESET) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                Text(
                    stringResource(R.string.auth_or),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            OutlinedButton(
                onClick = {
                    keyboard?.hide()
                    scope.launch { auth.signInSocial { google.credential(activity) } }
                },
                enabled = enabled,
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("auth-google"),
            ) {
                Icon(
                    painterResource(R.drawable.google_g),
                    null,
                    Modifier.size(20.dp),
                    tint = androidx.compose.ui.graphics.Color.Unspecified,
                )
                Spacer(Modifier.width(12.dp))
                Text(stringResource(R.string.auth_continue_google))
            }
        }
        if (visibleMode == FormMode.LOGIN) {
            TextButton(
                onClick = { switch(FormMode.RESET) },
                enabled = !state.busy,
                modifier = Modifier.testTag("auth-forgot"),
            ) {
                Text(stringResource(R.string.auth_forgot_password))
            }
            TextButton(
                onClick = { switch(FormMode.REGISTER) },
                enabled = !state.busy,
                modifier = Modifier.testTag("auth-register"),
            ) {
                Text(stringResource(R.string.auth_new_account))
            }
        } else
            TextButton(
                onClick = { switch(FormMode.LOGIN) },
                enabled = !state.busy,
                modifier = Modifier.testTag("auth-back-login"),
            ) {
                Text(stringResource(R.string.auth_back_login))
            }
        AccountPublicLinks()
        }
    }
    }
}
