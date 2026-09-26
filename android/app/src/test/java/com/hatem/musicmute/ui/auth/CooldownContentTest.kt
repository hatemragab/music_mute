package com.hatem.musicmute.ui.auth

import org.junit.Assert.assertEquals
import org.junit.Test

class CooldownContentTest {
    @Test fun resendRemainsDisabledUntilTheMonotonicDeadline() {
        assertEquals(2L, cooldownSeconds(2_001, 1_000))
        assertEquals(1L, cooldownSeconds(2_001, 1_001))
        assertEquals(1L, cooldownSeconds(2_001, 2_000))
        assertEquals(0L, cooldownSeconds(2_001, 2_001))
    }

    @Test fun expiredOrClearedCooldownIsImmediatelyAvailable() {
        assertEquals(0L, cooldownSeconds(2_001, 10_000))
        assertEquals(0L, cooldownSeconds(0, 10_000))
    }
}
