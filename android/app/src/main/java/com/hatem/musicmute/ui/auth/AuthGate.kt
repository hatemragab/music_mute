package com.hatem.musicmute.ui.auth

import android.app.Activity
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.hatem.musicmute.R
import com.hatem.musicmute.auth.*
import com.hatem.musicmute.ui.design.*
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
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner, auth) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_START) scope.launch { auth.foreground() }
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    Box(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) {
        when (state.phase) {
            AuthPhase.RESTORING ->
                GlowSplashScreen(Modifier.testTag("auth-restoring"))
            AuthPhase.SIGNED_OUT ->
                AuthScreen(auth, state, google, activity, scope, onToggleLanguage)
            AuthPhase.BOOTSTRAP_REQUIRED ->
                if (state.busy) {
                    GlowSplashScreen()
                } else {
                    AuthPage {
                        CreativeHeader(stringResource(R.string.app_name))
                        CreativeCard {
                            AuthMessages(state, auth::dismissMessage)
                            CreativePrimaryButton(
                                onClick = {
                                    scope.launch {
                                        if (state.identity == null) auth.restore()
                                        else auth.retryBootstrap()
                                    }
                                },
                                busy = state.busy,
                                modifier = Modifier.fillMaxWidth().testTag("auth-retry-bootstrap"),
                            ) {
                                Text(stringResource(R.string.retry))
                            }
                            TextButton(
                                onClick = { auth.signOut() },
                                enabled = !state.busy,
                                modifier = Modifier.testTag("auth-sign-out"),
                            ) {
                                Text(stringResource(R.string.auth_sign_out))
                            }
                        }
                    }
                }
            AuthPhase.RECOVERY_REQUIRED ->
                AccountRecoveryScreen(auth = auth, state = state, scope = scope)
            AuthPhase.AUTHENTICATED ->
                key(state.identity?.uid) {
                    // Consume saved navigation only after the owner is restored. A transient
                    // null identity during startup must not reset the saved destination.
                    var page by rememberSaveable { mutableStateOf(AccountPage.HOME) }
                    val savedPages = rememberSaveableStateHolder()
                    BackHandler(enabled = page != AccountPage.HOME) {
                        if (!state.busy)
                            page =
                                if (page == AccountPage.ACCOUNT) AccountPage.HOME
                                else AccountPage.ACCOUNT
                    }
                    CreativeNavigation(page, direction = { from, to -> to.ordinal - from.ordinal }) { visiblePage ->
                    when (visiblePage) {
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
}

@Composable
private fun GlowSplashScreen(modifier: Modifier = Modifier) {
    val green = Color(0xFF43C83E)
    Box(
        modifier.fillMaxSize().background(Color(0xFF0E1015)).safeDrawingPadding(),
        contentAlignment = Alignment.Center,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Canvas(Modifier.size(260.dp)) {
                drawCircle(
                    brush = Brush.radialGradient(
                        colors = listOf(green.copy(alpha = 0.22f), Color.Transparent),
                        radius = size.minDimension / 2,
                    ),
                )
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Canvas(Modifier.size(76.dp)) {
                    val heights = listOf(0.32f, 0.65f, 0.92f, 0.65f, 0.32f)
                    heights.forEachIndexed { index, fraction ->
                        val x = size.width * (0.1f + index * 0.2f)
                        val halfHeight = size.height * fraction / 2
                        drawLine(
                            color = green,
                            start = Offset(x, center.y - halfHeight),
                            end = Offset(x, center.y + halfHeight),
                            strokeWidth = 7.dp.toPx(),
                            cap = StrokeCap.Round,
                        )
                    }
                }
                Spacer(Modifier.height(24.dp))
                Text(
                    stringResource(R.string.app_name),
                    color = Color.White,
                    fontSize = 30.sp,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
        LinearProgressIndicator(
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 64.dp)
                .width(40.dp).height(3.dp),
            color = green,
            trackColor = green.copy(alpha = 0.12f),
        )
    }
}
