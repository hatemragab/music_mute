package com.hatem.musicmute.ui.design

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AccentPaletteTest {
    @Test
    fun parsesOnlyRgbInputAndMakesItOpaque() {
        assertEquals(0xFFFF814A.toInt(), AccentPalette.parse(" #ff814a "))
        assertEquals(0xFF000000.toInt(), AccentPalette.parse("000000"))
        listOf("", "#123", "#GG0000", "FFFFFFFF", "12 456").forEach {
            assertNull(AccentPalette.parse(it))
        }
    }

    @Test
    fun extremeAndSaturatedAccentsHaveReadableThemeRoles() {
        val accents = listOf(0, 0xFFFFFF, 0xFF0000, 0x00FF00, 0x0000FF, 0xFF814A)
        for (value in accents) {
            val primary = AccentPalette.readableAccent(value)
            assertTrue(AccentPalette.contrast(primary, AccentPalette.SURFACE) >= 4.5)
            assertTrue(AccentPalette.contrast(primary, AccentPalette.foreground(primary)) >= 4.5)
            assertEquals(255, primary ushr 24)
        }
    }
}
