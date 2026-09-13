package com.hatem.musicmute.ui.design

import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

object CreativeMotion {
    const val WAVE_MS = 12_000
    const val SHEET_OPEN_MS = 340
    const val SHEET_CLOSE_MS = 300
    const val NAVIGATION_MS = 230
    const val STAR_MS = 300
    const val PRESS_MS = 120
    const val PRESSED_SCALE = 0.975f
    val Ease = CubicBezierEasing(0.22f, 1f, 0.36f, 1f)

    fun shouldAnimate(visible: Boolean, foreground: Boolean, systemScale: Float): Boolean =
        visible && foreground && systemScale.isFinite() && systemScale > 0f

    fun enter(enabled: Boolean, offsetPx: Int): EnterTransition = if (!enabled) EnterTransition.None else
        fadeIn(tween(NAVIGATION_MS)) + slideInHorizontally(tween(NAVIGATION_MS, easing = Ease)) { offsetPx }

    fun exit(enabled: Boolean, offsetPx: Int): ExitTransition = if (!enabled) ExitTransition.None else
        fadeOut(tween(NAVIGATION_MS)) + slideOutHorizontally(tween(NAVIGATION_MS, easing = Ease)) { -offsetPx }
}

private val LocalCreativeMotionEnabled = staticCompositionLocalOf<Boolean?> { null }

@Composable
fun CreativeMotionProvider(content: @Composable () -> Unit) {
    val enabled = observeCreativeMotionEnabled()
    CompositionLocalProvider(LocalCreativeMotionEnabled provides enabled, content = content)
}

/** Share the host observer across all controls, rather than registering one per button. */
@Composable
fun rememberCreativeMotionEnabled(visible: Boolean = true): Boolean {
    val inherited = LocalCreativeMotionEnabled.current
    return visible && (inherited ?: observeCreativeMotionEnabled())
}

/** Observe settings as well as lifecycle so turning off animations takes effect immediately. */
@Composable
private fun observeCreativeMotionEnabled(): Boolean {
    val resolver = LocalContext.current.contentResolver
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var foreground by remember(lifecycle) {
        mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))
    }
    fun readScale() = Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    var scale by remember(resolver) { mutableFloatStateOf(readScale()) }
    DisposableEffect(lifecycle, resolver) {
        val listener = LifecycleEventObserver { _, _ ->
            foreground = lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
        }
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) { scale = readScale() }
        }
        lifecycle.addObserver(listener)
        resolver.registerContentObserver(
            Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), false, observer,
        )
        onDispose {
            lifecycle.removeObserver(listener)
            resolver.unregisterContentObserver(observer)
        }
    }
    return CreativeMotion.shouldAnimate(true, foreground, scale)
}
