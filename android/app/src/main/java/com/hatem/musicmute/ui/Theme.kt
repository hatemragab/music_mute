package com.hatem.musicmute.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val LightColors =
    lightColorScheme(
        primary = Color(0xFF236859),
        onPrimary = Color.White,
        primaryContainer = Color(0xFFD0EBDD),
        onPrimaryContainer = Color(0xFF153E34),
        secondary = Color(0xFF53685E),
        secondaryContainer = Color(0xFFE1EADF),
        background = Color(0xFFF7F8F4),
        onBackground = Color(0xFF202C27),
        surface = Color(0xFFF7F8F4),
        onSurface = Color(0xFF202C27),
        surfaceContainerLow = Color(0xFFFFFFFF),
        surfaceContainer = Color(0xFFEEF1E9),
        surfaceVariant = Color(0xFFE5EAE2),
        onSurfaceVariant = Color(0xFF546158),
        outline = Color(0xFF748177),
        outlineVariant = Color(0xFFD4DCD1),
    )

private val DarkColors =
    darkColorScheme(
        primary = Color(0xFF9FD8BD),
        onPrimary = Color(0xFF06382A),
        primaryContainer = Color(0xFF234B3C),
        onPrimaryContainer = Color(0xFFC4EDD8),
        secondary = Color(0xFFBDCDC0),
        secondaryContainer = Color(0xFF374A3F),
        background = Color(0xFF121A17),
        onBackground = Color(0xFFE1E9E0),
        surface = Color(0xFF121A17),
        onSurface = Color(0xFFE1E9E0),
        surfaceContainerLow = Color(0xFF1C2520),
        surfaceContainer = Color(0xFF222E27),
        surfaceVariant = Color(0xFF344139),
        onSurfaceVariant = Color(0xFFB7C5B9),
        outline = Color(0xFF85968A),
        outlineVariant = Color(0xFF3C4A40),
    )

@Composable
fun VocalTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (dark) DarkColors else LightColors,
        typography =
            Typography(
                headlineLarge =
                    TextStyle(
                        fontFamily = FontFamily.SansSerif,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 36.sp,
                        lineHeight = 44.sp,
                    ),
                headlineMedium =
                    TextStyle(
                        fontFamily = FontFamily.SansSerif,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 28.sp,
                        lineHeight = 36.sp,
                    ),
                titleLarge =
                    TextStyle(
                        fontFamily = FontFamily.SansSerif,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 22.sp,
                        lineHeight = 30.sp,
                    ),
            ),
        shapes =
            Shapes(
                small = RoundedCornerShape(12.dp),
                medium = RoundedCornerShape(20.dp),
                large = RoundedCornerShape(28.dp),
            ),
        content = content,
    )
}
