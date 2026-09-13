package com.hatem.musicmute.ui.design

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp

/** The same restrained transition for screens outside the main NavHost. */
@Composable
fun <T> CreativeNavigation(
    target: T,
    direction: (T, T) -> Int,
    content: @Composable (T) -> Unit,
) {
    val enabled = rememberCreativeMotionEnabled()
    val distance = with(LocalDensity.current) { 16.dp.roundToPx() } *
        if (LocalLayoutDirection.current == LayoutDirection.Rtl) -1 else 1
    AnimatedContent(
        targetState = target,
        modifier = Modifier.fillMaxSize(),
        transitionSpec = {
            val offset = if (direction(initialState, targetState) < 0) -distance else distance
            (CreativeMotion.enter(enabled, offset) togetherWith CreativeMotion.exit(enabled, offset)).using(null)
        },
        label = "creative-navigation",
        content = { content(it) },
    )
}
