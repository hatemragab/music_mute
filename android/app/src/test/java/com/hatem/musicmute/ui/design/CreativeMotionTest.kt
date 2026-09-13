package com.hatem.musicmute.ui.design

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CreativeMotionTest {
    @Test
    fun decorativeMotionRequiresVisibleForegroundAndEnabledSystemMotion() {
        assertTrue(CreativeMotion.shouldAnimate(true, true, 1f))
        assertFalse(CreativeMotion.shouldAnimate(false, true, 1f))
        assertFalse(CreativeMotion.shouldAnimate(true, false, 1f))
        assertFalse(CreativeMotion.shouldAnimate(true, true, 0f))
        assertFalse(CreativeMotion.shouldAnimate(true, true, Float.NaN))
    }
}
