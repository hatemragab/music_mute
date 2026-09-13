package com.hatem.musicmute.processing

import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

/** Bounded complete decode for expanded inputs. The worker independently verifies media again. */
suspend fun validateDecodedProcessingAudio(file: File, policy: ProcessingMediaPolicy) = withContext(Dispatchers.IO) {
    if (policy.version != 2) return@withContext
    val extractor = MediaExtractor()
    var decoder: MediaCodec? = null
    var started = false
    val deadline = System.nanoTime() + (policy.maxPreparationSeconds ?: 120).coerceAtMost(3600) * 1_000_000_000
    try {
        extractor.setDataSource(file.absolutePath)
        val inspection = inspectMediaSource(extractor)
        if (inspection.hasVideo || inspection.audioTrackCount != 1) throw InputPreparationException(InputPreparationError.INVALID_AUDIO)
        val track = inspection.audio
        val format = extractor.getTrackFormat(track.id)
        val delay = if (android.os.Build.VERSION.SDK_INT >= 30 && format.containsKey(MediaFormat.KEY_ENCODER_DELAY)) format.getInteger(MediaFormat.KEY_ENCODER_DELAY).coerceAtLeast(0) else 0
        val padding = if (android.os.Build.VERSION.SDK_INT >= 30 && format.containsKey(MediaFormat.KEY_ENCODER_PADDING)) format.getInteger(MediaFormat.KEY_ENCODER_PADDING).coerceAtLeast(0) else 0
        if (track.channels !in 1..8 || track.sampleRate !in 8000..192000) throw InputPreparationException(InputPreparationError.UNSUPPORTED)
        format.setInteger(MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
        extractor.selectTrack(track.id)
        val codec = MediaCodec.createDecoderByType(track.mime)
        decoder = codec
        codec.configure(format, null, null, 0); codec.start(); started = true
        var inputEnded = false
        var outputEnded = false
        var frames = 0L
        val info = MediaCodec.BufferInfo()
        while (!outputEnded) {
            currentCoroutineContext().ensureActive()
            if (System.nanoTime() >= deadline) throw InputPreparationException(InputPreparationError.PREPARATION_TIMEOUT)
            if (!inputEnded) {
                val index = codec.dequeueInputBuffer(1000)
                if (index >= 0) {
                    val buffer = requireNotNull(codec.getInputBuffer(index))
                    val size = extractor.readSampleData(buffer, 0)
                    if (size < 0) {
                        codec.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inputEnded = true
                    } else {
                        if (extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_ENCRYPTED != 0) throw InputPreparationException(InputPreparationError.UNSUPPORTED)
                        codec.queueInputBuffer(index, 0, size, extractor.sampleTime, 0); extractor.advance()
                    }
                }
            }
            val index = codec.dequeueOutputBuffer(info, 1000)
            if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                val actual = codec.outputFormat
                if (actual.getInteger(MediaFormat.KEY_CHANNEL_COUNT) != track.channels || actual.getInteger(MediaFormat.KEY_SAMPLE_RATE) != track.sampleRate ||
                    (actual.containsKey(MediaFormat.KEY_PCM_ENCODING) && actual.getInteger(MediaFormat.KEY_PCM_ENCODING) != AudioFormat.ENCODING_PCM_16BIT))
                    throw InputPreparationException(InputPreparationError.UNSUPPORTED)
            } else if (index >= 0) {
                frames += info.size / (track.channels * 2)
                codec.releaseOutputBuffer(index, false)
                val duration = (frames - delay.toLong() - padding).coerceAtLeast(0).toDouble() / track.sampleRate
                if (duration > policy.maxDurationSeconds) throw InputPreparationException(InputPreparationError.TOO_LONG)
                outputEnded = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
            }
        }
        if (frames <= 0) throw InputPreparationException(InputPreparationError.NO_AUDIO)
    } catch (error: InputPreparationException) { throw error }
    catch (error: kotlinx.coroutines.CancellationException) { throw error }
    catch (_: Exception) { throw InputPreparationException(InputPreparationError.INVALID_AUDIO) }
    finally {
        decoder?.let { runCatching { if (started) it.stop() }; it.release() }
        extractor.release()
    }
}
