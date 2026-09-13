package com.hatem.musicmute.ui.design

import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

/** Pure sRGB color policy, shared by persistence, the picker and Compose theme. */
object AccentPalette {
    const val DEFAULT: Int = 0xFFFF814A.toInt()
    const val BACKGROUND: Int = 0xFF101115.toInt()
    const val SURFACE: Int = 0xFF191B21.toInt()

    fun opaque(argb: Int): Int = argb or 0xFF000000.toInt()

    fun parse(value: String): Int? {
        val rgb = value.trim().removePrefix("#")
        if (!rgb.matches(Regex("[a-fA-F0-9]{6}"))) return null
        return rgb.toIntOrNull(16)?.let(::opaque)
    }

    fun foreground(background: Int): Int =
        if (contrast(background, 0xFF000000.toInt()) >= contrast(background, 0xFFFFFFFF.toInt()))
            0xFF000000.toInt() else 0xFFFFFFFF.toInt()

    /** Retain the hue while lifting dark selections for readable text/control roles. */
    fun readableAccent(argb: Int): Int {
        val color = opaque(argb)
        for (step in 0..100) {
            val candidate = blend(color, 0xFFFFFFFF.toInt(), step / 100.0)
            if (contrast(candidate, SURFACE) >= 4.5) return candidate
        }
        return 0xFFFFFFFF.toInt()
    }

    fun blend(from: Int, to: Int, fraction: Double): Int {
        val amount = fraction.coerceIn(0.0, 1.0)
        fun channel(shift: Int): Int {
            val first = (from ushr shift) and 255
            val last = (to ushr shift) and 255
            return (first + (last - first) * amount).roundToInt()
        }
        return opaque((channel(16) shl 16) or (channel(8) shl 8) or channel(0))
    }

    fun contrast(first: Int, second: Int): Double {
        val a = luminance(first)
        val b = luminance(second)
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    private fun luminance(color: Int): Double {
        fun linear(shift: Int): Double {
            val component = ((color ushr shift) and 255) / 255.0
            return if (component <= 0.04045) component / 12.92
            else ((component + 0.055) / 1.055).pow(2.4)
        }
        return linear(16) * 0.2126 + linear(8) * 0.7152 + linear(0) * 0.0722
    }
}
