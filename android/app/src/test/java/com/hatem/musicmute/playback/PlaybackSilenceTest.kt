package com.hatem.musicmute.playback

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.*
import org.junit.Test

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class PlaybackSilenceTest {
    @Test fun naturalPausesRemainUnchangedAcrossSampleRatesAndChannels() {
        for (rate in listOf(16_000, 44_100, 48_000)) for (channels in 1..2) {
            for (pauseMs in listOf(100, 300, 600, 950)) {
                val input = speechWithGap(rate, channels, pauseMs)
                val result = process(input, rate, channels)
                assertArrayEquals("rate=$rate channels=$channels pause=$pauseMs", input, result.audio)
                assertEquals(0L, result.skippedFrames)
            }
        }
    }

    @Test fun longGapsAreShortenedButKeepBreathingRoomAndAllSpeech() {
        for (channels in 1..2) {
            val rate = 48_000
            val input = speechWithGap(rate, channels, 5_000)
            val result = process(input, rate, channels)
            val bytesPerFrame = channels * 2
            val speechBytes = rate / 10 * bytesPerFrame
            val keptGapMs = (result.audio.size - speechBytes * 2) * 1000L / (rate * bytesPerFrame)
            assertTrue("kept gap=$keptGapMs channels=$channels", keptGapMs in 1_000..2_001)
            assertTrue(result.skippedFrames > 0)
            assertEquals(input.size.toLong(), result.audio.size + result.skippedFrames * bytesPerFrame)
            assertArrayEquals(input.copyOfRange(0, speechBytes), result.audio.copyOfRange(0, speechBytes))
            assertArrayEquals(input.takeLast(speechBytes).toByteArray(), result.audio.takeLast(speechBytes).toByteArray())
        }
    }

    @Test fun quietSpeechAboveTheLowerThresholdIsNeverSkipped() {
        for (channels in 1..2) for (level in listOf(300, -300, 512, -512)) {
            val input = speechWithGap(48_000, channels, 5_000, level)
            val result = process(input, 48_000, channels)
            assertArrayEquals(input, result.audio)
            assertEquals(0L, result.skippedFrames)
        }
    }

    @Test fun retainedNearSilenceKeepsItsOriginalVolume() {
        val input = speechWithGap(48_000, 2, 5_000, 128)
        val result = process(input, 48_000, 2)
        val samples = ByteBuffer.wrap(result.audio).order(ByteOrder.nativeOrder()).asShortBuffer()
        while (samples.hasRemaining()) assertTrue(samples.get().toInt() in listOf(128, 8_000))
        assertTrue(result.skippedFrames > 0)
    }

    @Test fun trailingSilenceDrainsAndFlushResetsSkippedFrames() {
        val processor = gentleSilenceProcessor()
        processor.setEnabled(true)
        processor.configure(AudioProcessor.AudioFormat(48_000, 2, C.ENCODING_PCM_16BIT))
        processor.flush()
        val input = pcm(48_000, 2, 100, 8_000) + pcm(48_000, 2, 5_000, 0)
        drain(processor, input)
        assertTrue(processor.isEnded)
        assertTrue(processor.skippedFrames > 0)
        processor.flush()
        assertEquals(0L, processor.skippedFrames)
        processor.setEnabled(false)
        processor.flush()
        assertFalse(processor.isActive)
        processor.reset()
    }

    private data class Result(val audio: ByteArray, val skippedFrames: Long)

    private fun process(input: ByteArray, rate: Int, channels: Int): Result {
        val processor = gentleSilenceProcessor()
        processor.setEnabled(true)
        processor.configure(AudioProcessor.AudioFormat(rate, channels, C.ENCODING_PCM_16BIT))
        processor.flush()
        assertTrue(processor.isActive)
        return Result(drain(processor, input), processor.skippedFrames).also { processor.reset() }
    }

    private fun drain(processor: AudioProcessor, input: ByteArray): ByteArray {
        val output = ByteArrayOutputStream()
        fun readOutput() {
            val buffer = processor.output
            val bytes = ByteArray(buffer.remaining())
            buffer.get(bytes)
            output.write(bytes)
        }
        // Frame-aligned decoder-sized chunks exercise gaps crossing buffer boundaries.
        for (offset in input.indices step 4_096) {
            val chunk = ByteBuffer.allocateDirect(minOf(4_096, input.size - offset))
                .order(ByteOrder.nativeOrder())
            chunk.put(input, offset, chunk.capacity()).flip()
            var iterations = 0
            while (chunk.hasRemaining()) {
                check(++iterations < 100) { "Processor stopped consuming input" }
                processor.queueInput(chunk)
                readOutput()
            }
        }
        processor.queueEndOfStream()
        readOutput()
        assertTrue(processor.isEnded)
        return output.toByteArray()
    }

    private fun speechWithGap(rate: Int, channels: Int, pauseMs: Int, level: Int = 0): ByteArray =
        pcm(rate, channels, 100, 8_000) + pcm(rate, channels, pauseMs, level) + pcm(rate, channels, 100, 8_000)

    private fun pcm(rate: Int, channels: Int, durationMs: Int, level: Int): ByteArray {
        val samples = rate * durationMs / 1000 * channels
        val buffer = ByteBuffer.allocate(samples * 2).order(ByteOrder.nativeOrder())
        repeat(samples) { buffer.putShort(level.toShort()) }
        return buffer.array()
    }
}
