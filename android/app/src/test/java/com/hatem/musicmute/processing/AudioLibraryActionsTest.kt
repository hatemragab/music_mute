package com.hatem.musicmute.processing

import org.junit.Assert.assertEquals
import org.junit.Test

class AudioLibraryActionsTest {
    @Test fun exportNamesAreSafeMp3NamesWithoutChangingTheDisplayTitle() {
        assertEquals("My _ interview.mp3", processedAudioExportName(" My / interview. "))
        assertEquals("MusicMute voice.mp3", processedAudioExportName("../.."))
        assertEquals("لقاء صوتي.mp3", processedAudioExportName("لقاء صوتي"))
    }
}
