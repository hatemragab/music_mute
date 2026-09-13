package com.hatem.musicmute.processing

import org.junit.Assert.*
import org.junit.Test

class MediaSourceInspectorTest {
    private fun track(id: Int, default: Boolean = false, usable: Boolean = true) =
        SourceAudioTrack(id, default, usable, 10.0, "audio/mp4a-latm", 2, 48000)
    @Test fun selectedDefaultNeedNotBeFirst() { assertEquals(2, selectDefaultAudioTrack(listOf(track(0), track(2, true))).id) }
    @Test fun soleTrackIsSelected() { assertEquals(0, selectDefaultAudioTrack(listOf(track(0))).id) }
    @Test(expected = InputPreparationException::class) fun ambiguousTracksReject() { selectDefaultAudioTrack(listOf(track(0), track(1))) }
    @Test(expected = InputPreparationException::class) fun unusableDefaultDoesNotSwitchLanguage() { selectDefaultAudioTrack(listOf(track(0), track(1, true, false))) }
}
