package com.hatem.musicmute.ui

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.ui.design.AccentPalette
import com.hatem.musicmute.ui.design.CreativeMotionProvider

private fun creativeColors(accentArgb: Int): androidx.compose.material3.ColorScheme {
    val primary = AccentPalette.readableAccent(accentArgb)
    val container = AccentPalette.blend(AccentPalette.SURFACE, primary, 0.16)
    return darkColorScheme(
        primary = Color(primary),
        onPrimary = Color(AccentPalette.foreground(primary)),
        primaryContainer = Color(container),
        onPrimaryContainer = Color(AccentPalette.foreground(container)),
        secondary = Color(0xFFCBC6D4),
        secondaryContainer = Color(0xFF303039),
        background = Color(AccentPalette.BACKGROUND),
        onBackground = Color(0xFFF2F0F5),
        surface = Color(AccentPalette.BACKGROUND),
        onSurface = Color(0xFFF2F0F5),
        surfaceContainerLow = Color(AccentPalette.SURFACE),
        surfaceContainerLowest = Color(0xFF0C0D10),
        surfaceContainer = Color(0xFF202229),
        surfaceContainerHigh = Color(0xFF25272E),
        surfaceContainerHighest = Color(0xFF2B2D35),
        surfaceDim = Color(AccentPalette.BACKGROUND),
        surfaceBright = Color(0xFF34363F),
        surfaceVariant = Color(0xFF292B34),
        onSurfaceVariant = Color(0xFFB9B8C3),
        outline = Color(0xFF8F8E9C),
        outlineVariant = Color(0xFF3A3C47),
    )
}

@Composable
fun VocalTheme(accentArgb: Int = AccentPalette.DEFAULT, content: @Composable () -> Unit) {
    val colors = remember(accentArgb) { creativeColors(accentArgb) }
    MaterialTheme(
        colorScheme = colors,
        typography = musicTypography,
        shapes =
            Shapes(
                small = RoundedCornerShape(12.dp),
                medium = RoundedCornerShape(20.dp),
                large = RoundedCornerShape(28.dp),
            ),
        content = { CreativeMotionProvider(content) },
    )
}
