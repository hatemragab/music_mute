package com.hatem.musicmute.ui.auth

import android.app.Activity
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.hatem.musicmute.R
import com.hatem.musicmute.auth.*
import kotlinx.coroutines.launch

private enum class AccountPage {
    HOME,
    ACCOUNT,
    METHODS,
    DEVICES,
}

@Composable
fun AuthGate(
    auth: AuthSessionCoordinator,
    google: GoogleCredentialProvider,
    activity: Activity,
    onToggleLanguage: () -> Unit,
    content: @Composable (() -> Unit) -> Unit,
) {
    val state by auth.state.collectAsStateWithLifecycle()
    // This scope survives transitions from login to bootstrap and into the app.
    val scope = rememberCoroutineScope()
    var page by remember { mutableStateOf(AccountPage.HOME) }
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner, auth) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_START) scope.launch { auth.foreground() }
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(state.phase) {
        if (state.phase != AuthPhase.AUTHENTICATED) page = AccountPage.HOME
    }
    Box(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) {
        when (state.phase) {
            AuthPhase.RESTORING ->
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.testTag("auth-restoring"))
                }
            AuthPhase.SIGNED_OUT ->
                AuthScreen(auth, state, google, activity, scope, onToggleLanguage)
            AuthPhase.BOOTSTRAP_REQUIRED ->
                AuthPage {
                    Text(
                        stringResource(R.string.auth_connecting_title),
                        style = MaterialTheme.typography.headlineMedium,
                    )
                    Text(stringResource(R.string.auth_connecting_description))
                    AuthMessages(state, auth::dismissMessage)
                    Button(
                        onClick = {
                            scope.launch {
                                if (state.identity == null) auth.restore()
                                else auth.retryBootstrap()
                            }
                        },
                        enabled = !state.busy,
                        modifier = Modifier.fillMaxWidth().testTag("auth-retry-bootstrap"),
                    ) {
                        Text(stringResource(R.string.retry))
                    }
                    TextButton(
                        onClick = { auth.signOut() },
                        modifier = Modifier.testTag("auth-sign-out"),
                    ) {
                        Text(stringResource(R.string.auth_sign_out))
                    }
                }
            AuthPhase.RECOVERY_REQUIRED ->
                AccountRecoveryScreen(auth = auth, state = state, scope = scope)
            AuthPhase.AUTHENTICATED ->
                key(state.identity?.uid) {
                    val savedPages = rememberSaveableStateHolder()
                    BackHandler(enabled = page != AccountPage.HOME) {
                        if (!state.busy)
                            page =
                                if (page == AccountPage.ACCOUNT) AccountPage.HOME
                                else AccountPage.ACCOUNT
                    }
                    when (page) {
                        AccountPage.HOME ->
                            savedPages.SaveableStateProvider("local-app") {
                                content { page = AccountPage.ACCOUNT }
                            }
                        AccountPage.ACCOUNT ->
                            AccountScreen(
                                auth,
                                state,
                                scope,
                                onBack = { page = AccountPage.HOME },
                                onMethods = { page = AccountPage.METHODS },
                                onDevices = { page = AccountPage.DEVICES },
                                google = google, activity = activity,
                            )
                        AccountPage.METHODS ->
                            LinkedMethodsScreen(auth, state, google, activity, scope) {
                                page = AccountPage.ACCOUNT
                            }
                        AccountPage.DEVICES ->
                            DevicesScreen(auth, state, scope) { page = AccountPage.ACCOUNT }
                    }
                }
        }
    }
}
