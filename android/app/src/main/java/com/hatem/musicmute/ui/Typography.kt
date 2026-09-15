package com.hatem.musicmute.ui

import androidx.compose.material3.Typography
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.hatem.musicmute.R

@OptIn(ExperimentalTextApi::class)
private val musicFont = FontFamily(
    listOf(400, 500, 600, 700).map { weight ->
        Font(R.font.noto_sans_arabic, weight = FontWeight(weight),
            variationSettings = FontVariation.Settings(FontVariation.weight(weight)))
    }
)

internal val musicTypography: Typography = Typography().let { base ->
    Typography(
        displayLarge = base.displayLarge.compact(),
        displayMedium = base.displayMedium.compact(),
        displaySmall = base.displaySmall.compact(),
        headlineLarge = base.headlineLarge.compact().copy(
            fontWeight = FontWeight.SemiBold, fontSize = 36.sp, lineHeight = 42.sp),
        headlineMedium = base.headlineMedium.compact().copy(
            fontWeight = FontWeight.SemiBold, fontSize = 28.sp, lineHeight = 34.sp),
        headlineSmall = base.headlineSmall.compact(),
        titleLarge = base.titleLarge.compact().copy(
            fontWeight = FontWeight.SemiBold, fontSize = 21.sp, lineHeight = 27.sp),
        titleMedium = base.titleMedium.compact().copy(fontSize = 15.sp, lineHeight = 20.sp),
        titleSmall = base.titleSmall.compact().copy(lineHeight = 18.sp),
        bodyLarge = base.bodyLarge.compact().copy(fontSize = 15.sp, lineHeight = 21.sp),
        bodyMedium = base.bodyMedium.compact().copy(lineHeight = 19.sp),
        bodySmall = base.bodySmall.compact(),
        labelLarge = base.labelLarge.compact().copy(fontSize = 13.sp, lineHeight = 18.sp),
        labelMedium = base.labelMedium.compact(),
        labelSmall = base.labelSmall.compact(),
    )
}

/** Remove outer font/line padding without clipping Arabic glyphs or fixing text height. */
private fun TextStyle.compact(): TextStyle = copy(
    fontFamily = musicFont,
    platformStyle = PlatformTextStyle(includeFontPadding = false),
    lineHeightStyle = LineHeightStyle(
        alignment = LineHeightStyle.Alignment.Center,
        trim = LineHeightStyle.Trim.Both,
    ),
)
