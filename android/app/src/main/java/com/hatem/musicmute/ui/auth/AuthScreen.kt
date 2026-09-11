package com.hatem.musicmute.ui.auth

import android.app.Activity
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Headphones
import androidx.compose.material3.*
import androidx.compose.runtime.*
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
    var mode by remember { mutableStateOf(FormMode.LOGIN) }
    var email by remember { mutableStateOf("") }
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

    AuthPage {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = onToggleLanguage, enabled = !state.busy) {
                Text(stringResource(R.string.auth_language))
            }
        }
        Surface(
            color = MaterialTheme.colorScheme.primaryContainer,
            shape = MaterialTheme.shapes.extraLarge,
            modifier = Modifier.size(68.dp),
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(
                    Icons.Outlined.Headphones,
                    null,
                    Modifier.size(34.dp),
                    tint = MaterialTheme.colorScheme.onPrimaryContainer,
                )
            }
        }
        Text(
            stringResource(R.string.app_name),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.primary,
        )
        Text(
            stringResource(
                when (mode) {
                    FormMode.LOGIN -> R.string.auth_welcome
                    FormMode.REGISTER -> R.string.auth_create_title
                    FormMode.RESET -> R.string.auth_reset_title
                }
            ),
            style = MaterialTheme.typography.headlineLarge,
            modifier = Modifier.testTag("auth-title"),
        )
        Text(
            stringResource(
                when (mode) {
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
        AccountPublicLinks()
        OutlinedTextField(
            email,
            { email = it },
            Modifier.fillMaxWidth().testTag("auth-email").semantics {
                contentType = ContentType.EmailAddress
            },
            enabled = !state.busy,
            singleLine = true,
            label = { Text(stringResource(R.string.auth_email)) },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
        )
        if (mode != FormMode.RESET)
            PasswordField(
                password,
                { password = it },
                R.string.auth_password,
                "auth-password",
                !state.busy,
                mode == FormMode.REGISTER,
            )
        if (mode == FormMode.REGISTER) {
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
        Button(
            onClick = {
                keyboard?.hide()
                scope.launch {
                    if (mode == FormMode.RESET) auth.requestPasswordReset(email)
                    else auth.signInEmail(email, password, mode == FormMode.REGISTER)
                    password = ""
                    confirmation = ""
                }
            },
            modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("auth-submit"),
            enabled =
                enabled &&
                    validAuthEmail(email.trim()) &&
                    (if (mode == FormMode.RESET) cooldown == 0L
                    else
                        password.isNotEmpty() &&
                            (mode != FormMode.REGISTER || password == confirmation)),
        ) {
            Text(
                if (mode == FormMode.RESET && cooldown > 0)
                    stringResource(R.string.auth_retry_seconds, cooldown)
                else
                    stringResource(
                        when (mode) {
                            FormMode.LOGIN -> R.string.auth_sign_in
                            FormMode.REGISTER -> R.string.auth_create_account
                            FormMode.RESET -> R.string.auth_send_reset
                        }
                    )
            )
        }
        if (mode != FormMode.RESET) {
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
        if (mode == FormMode.LOGIN) {
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
    }
}
