package com.hatem.musicmute.processing

import org.junit.Assert.*
import org.junit.Test

class AudioPreparationEngineTest {
    @Test fun negativeAacPrimingTimestampIsStillAnAvailableSample() {
        assertTrue(selectedAudioSampleAvailable(-23_219))
        assertTrue(selectedAudioSampleAvailable(0))
        assertFalse(selectedAudioSampleAvailable(-1))
    }
    @Test fun opusUsesActualDecoderSampleRate() {
        assertEquals(48000, decodedAudioSampleRate(2, 2, 48000, true))
    }
    @Test(expected = InputPreparationException::class) fun decoderCannotSilentlyDownmix() {
        decodedAudioSampleRate(2, 1, 48000, true)
    }
    @Test(expected = InputPreparationException::class) fun decoderMustProducePcm16() {
        decodedAudioSampleRate(2, 2, 48000, false)
    }
    @Test fun routingPreservesAudioAndExtractsVideo() {
        assertEquals(AudioPreparationRoute.COPY, audioPreparationRoute(false, true, true, 2, 128_000))
        assertEquals(AudioPreparationRoute.REMUX, audioPreparationRoute(true, true, true, 2, 160_000))
        assertEquals(AudioPreparationRoute.CONVERT, audioPreparationRoute(false, true, true, 2, 192_000))
        assertEquals(AudioPreparationRoute.CONVERT, audioPreparationRoute(false, true, true, 2, null))
        assertEquals(AudioPreparationRoute.CONVERT, audioPreparationRoute(true, false, true, 2, 128_000))
        assertEquals(AudioPreparationRoute.CONVERT, audioPreparationRoute(false, true, false, 2, 128_000))
    }
    @Test fun compactCompressedAudioWithoutBitrateAvoidsTranscoding() {
        val track = SourceAudioTrack(0, true, true, 60.0, "audio/mpeg", 2, 44100)
        val input = MediaSourceInspection(track, false, 1)
        val policy = ProcessingMediaPolicy.STANDARD
        assertTrue(canCopyProcessingAudio(input, "mp3", 900_000, policy))
        assertTrue(canCopyProcessingAudio(input, "m4a", 900_000, policy))
        assertFalse(canCopyProcessingAudio(input, "wav", 900_000, policy))
        assertFalse(canCopyProcessingAudio(input, "mp3", 2_000_000, policy))
        assertFalse(canCopyProcessingAudio(input, "mp3", null, policy))
        assertFalse(canCopyProcessingAudio(input.copy(hasVideo = true), "mp4", 900_000, policy))
        assertFalse(canCopyProcessingAudio(input.copy(audioTrackCount = 2), "mp3", 900_000, policy))
        assertFalse(canCopyProcessingAudio(input.copy(audio = track.copy(bitRate = 320_000)), "mp3", 900_000, policy))
        assertFalse(canCopyProcessingAudio(input.copy(audio = track.copy(bitRate = 128_000)), "mp3", policy.maxPreparedAudioBytes + 1, policy))
    }
    @Test(expected = InputPreparationException::class) fun noSilentMultichannelDownmix() { audioPreparationRoute(true, false, true, 6, 160_000) }
}
