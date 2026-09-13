package com.hatem.musicmute.processing

import org.junit.Assert.*
import org.junit.Test

class AudioPreparationEngineTest {
    @Test fun routingPreservesAudioAndExtractsVideo() {
        assertEquals(AudioPreparationRoute.COPY, audioPreparationRoute(false, true, true, 2))
        assertEquals(AudioPreparationRoute.REMUX, audioPreparationRoute(true, true, true, 2))
        assertEquals(AudioPreparationRoute.CONVERT, audioPreparationRoute(true, false, true, 2))
        assertEquals(AudioPreparationRoute.CONVERT, audioPreparationRoute(false, true, false, 2))
    }
    @Test(expected = InputPreparationException::class) fun noSilentMultichannelDownmix() { audioPreparationRoute(true, false, true, 6) }
}
