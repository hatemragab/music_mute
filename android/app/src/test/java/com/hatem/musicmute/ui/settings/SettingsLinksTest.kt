package com.hatem.musicmute.ui.settings

import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsLinksTest {
    @Test
    fun platformLinksMatchReviewedProductDestinations() {
        assertTrue(isTrustedMusicMutePlatformUrl(MUSICMUTE_WEB_APP_URL))
        assertTrue(isTrustedMusicMutePlatformUrl(MUSICMUTE_MACOS_DOWNLOADS_URL))
    }

    @Test
    fun onlyAvailablePlatformsCanBeOpened() {
        assertEquals(MUSICMUTE_WEB_APP_URL, availableMusicMutePlatformUrl(MUSICMUTE_WEB_APP_URL))
        assertEquals(MUSICMUTE_WEB_APP_URL, availableMusicMutePlatformUrl("https://app.music-mute.com/"))
        assertNull(availableMusicMutePlatformUrl(MUSICMUTE_MACOS_DOWNLOADS_URL))
        assertNull(availableMusicMutePlatformUrl("https://MUSIC-MUTE.COM/#downloads"))
        assertNull(availableMusicMutePlatformUrl("https://music-mute.com/#other"))
        assertNull(availableMusicMutePlatformUrl("https://app.music-mute.com.evil.example"))
    }

    @Test
    fun platformLinksRejectUnsafeOrSpeculativeDestinations() {
        listOf(
            "http://app.music-mute.com",
            "https://app.music-mute.com.evil.example",
            "https://user@app.music-mute.com",
            "https://app.music-mute.com/?campaign=mobile",
            "https://music-mute.com/#other",
            "https://music-mute.com/MusicMute.dmg#downloads",
        ).forEach { assertFalse(it, isTrustedMusicMutePlatformUrl(it)) }
    }
}
