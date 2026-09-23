package com.hatem.musicmute.processing

import android.content.Context
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import java.io.File
import java.nio.ByteBuffer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

internal fun decodedAudioSampleRate(sourceChannels: Int, channels: Int, sampleRate: Int, pcm16Bit: Boolean): Int {
    if (channels != sourceChannels || channels !in 1..2 || sampleRate !in 8000..96000 || !pcm16Bit)
        throw InputPreparationException(InputPreparationError.UNSUPPORTED)
    return sampleRate
}

internal fun selectedAudioSampleAvailable(sampleTimeUs: Long): Boolean = sampleTimeUs != -1L

/** Direct provider access: never makes a private copy of the original video. */
class AudioPreparationEngine(private val context: Context) {
    suspend fun inspect(uri: Uri): MediaSourceInspection = withContext(Dispatchers.IO) {
        val extractor = MediaExtractor()
        try { extractor.setDataSource(context, uri, null); inspectMediaSource(extractor) }
        catch (error: SecurityException) { throw error }
        catch (error: java.io.FileNotFoundException) { throw error }
        catch (error: InputPreparationException) { throw error }
        catch (_: Exception) { throw InputPreparationException(InputPreparationError.UNSUPPORTED) }
        finally { extractor.release() }
    }

    suspend fun prepare(uri: Uri, output: File, policy: ProcessingMediaPolicy): File = withContext(Dispatchers.IO) {
        if (!policy.localPreparationReady) throw InputPreparationException(InputPreparationError.UNSUPPORTED)
        val sourceLimit = requireNotNull(policy.maxLocalSourceBytes)
        val descriptor = context.contentResolver.openAssetFileDescriptor(uri, "r")
            ?: throw InputPreparationException(InputPreparationError.STORAGE)
        descriptor.use { asset ->
            // Unknown provider length cannot safely authorize expanded video processing.
            val bytes = asset.length.takeIf { it >= 0 } ?: asset.parcelFileDescriptor.statSize
            if (bytes <= 0 || bytes > sourceLimit) throw InputPreparationException(InputPreparationError.TOO_LARGE)
            output.parentFile?.mkdirs()
            if ((output.parentFile?.usableSpace ?: 0) < policy.maxPreparedAudioBytes * 2 + 16 * 1024 * 1024)
                throw InputPreparationException(InputPreparationError.STORAGE)
            val deadline = System.nanoTime() + requireNotNull(policy.maxPreparationSeconds).coerceAtMost(3600) * 1_000_000_000
            suspend fun checkBounds() {
                currentCoroutineContext().ensureActive()
                if (System.nanoTime() >= deadline) throw InputPreparationException(InputPreparationError.PREPARATION_TIMEOUT)
                if (output.length() > policy.maxPreparedAudioBytes) throw InputPreparationException(InputPreparationError.TOO_LARGE)
            }
            fun extractor() = MediaExtractor().apply { setDataSource(asset.fileDescriptor, asset.startOffset, bytes) }
            val source = extractor()
            try {
                val inspection = inspectMediaSource(source)
                if (!policy.acceptsDuration(inspection.audio.durationSeconds)) throw InputPreparationException(InputPreparationError.TOO_LONG)
                source.selectTrack(inspection.audio.id)
                // AAC priming can give the first valid sample a negative timestamp.
                // MediaExtractor uses exactly -1 for end of stream.
                if (!selectedAudioSampleAvailable(source.sampleTime))
                    throw InputPreparationException(InputPreparationError.DEFAULT_TRACK_UNAVAILABLE)
                val compatible = inspection.audio.mime == "audio/mp4a-latm"
                // A selected track may be much smaller than the source video. Try lossless
                // extraction first; only a bounded failed-size attempt triggers encoding.
                val route = audioPreparationRoute(inspection.hasVideo || inspection.audioTrackCount > 1,
                    compatible, true, inspection.audio.channels, inspection.audio.bitRate)
                try {
                    if (route == AudioPreparationRoute.CONVERT) transcode(source, inspection, output, ::checkBounds)
                    else remux(source, inspection, output, ::checkBounds)
                } catch (error: InputPreparationException) {
                    if (error.reason != InputPreparationError.TOO_LARGE || inspection.audio.channels !in 1..2 || route == AudioPreparationRoute.CONVERT) throw error
                    output.delete()
                    source.seekTo(0, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
                    transcode(source, inspection, output, ::checkBounds)
                }
                checkBounds()
                val result = inspectProcessingAudio(output)
                if (result.hasVideo || !result.hasAudio || !policy.acceptsPrepared(output.length(), result.durationSeconds))
                    throw InputPreparationException(InputPreparationError.INVALID_AUDIO)
                output
            } catch (error: Exception) {
                output.delete()
                throw error
            } finally { source.release() }
        }
    }

    private suspend fun remux(source: MediaExtractor, inspection: MediaSourceInspection, output: File, check: suspend () -> Unit) {
        val muxer = MediaMuxer(output.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        var started = false
        try {
            val track = muxer.addTrack(source.getTrackFormat(inspection.audio.id))
            muxer.start(); started = true
            val buffer = ByteBuffer.allocateDirect(1024 * 1024)
            val info = MediaCodec.BufferInfo()
            var samples = 0
            while (true) {
                check()
                buffer.clear()
                val count = source.readSampleData(buffer, 0)
                if (count < 0) break
                if (count > buffer.capacity() || source.sampleFlags and MediaExtractor.SAMPLE_FLAG_ENCRYPTED != 0)
                    throw InputPreparationException(InputPreparationError.UNSUPPORTED)
                info.set(0, count, source.sampleTime, if (source.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
                muxer.writeSampleData(track, buffer, info)
                samples++
                source.advance()
            }
            if (samples == 0) throw InputPreparationException(InputPreparationError.NO_AUDIO)
        } finally {
            try { if (started) muxer.stop() } finally { muxer.release() }
        }
    }

    private suspend fun transcode(source: MediaExtractor, inspection: MediaSourceInspection, output: File, check: suspend () -> Unit) {
        val selected = inspection.audio
        if (selected.channels !in 1..2 || selected.sampleRate !in 8000..96000 || selected.mime in setOf("audio/eac3-joc", "audio/ac4"))
            throw InputPreparationException(InputPreparationError.UNSUPPORTED)
        val decoder = MediaCodec.createDecoderByType(selected.mime)
        val encoder = MediaCodec.createEncoderByType("audio/mp4a-latm")
        val muxer = MediaMuxer(output.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        var decoderStarted = false
        var encoderStarted = false
        var muxerStarted = false
        try {
            val decodeFormat = source.getTrackFormat(selected.id).apply { setInteger(MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_16BIT) }
            decoder.configure(decodeFormat, null, null, 0); decoder.start(); decoderStarted = true
            var outputSampleRate = 0
            var inputEnded = false
            var decodeEnded = false
            var encodeEnded = false
            var pendingIndex = -1
            var pending: ByteBuffer? = null
            var pendingTime = 0L
            var pendingEnd = false
            var pcmBytes = 0L
            var track = -1
            val decodedInfo = MediaCodec.BufferInfo()
            val encodedInfo = MediaCodec.BufferInfo()
            while (!encodeEnded) {
                check()
                if (!inputEnded) {
                    val index = decoder.dequeueInputBuffer(0)
                    if (index >= 0) {
                        val input = requireNotNull(decoder.getInputBuffer(index))
                        val count = source.readSampleData(input, 0)
                        if (count < 0) {
                            decoder.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inputEnded = true
                        } else {
                            if (source.sampleFlags and MediaExtractor.SAMPLE_FLAG_ENCRYPTED != 0) throw InputPreparationException(InputPreparationError.UNSUPPORTED)
                            decoder.queueInputBuffer(index, 0, count, source.sampleTime, 0); source.advance()
                        }
                    }
                }
                if (!decodeEnded && pendingIndex < 0) {
                    val index = decoder.dequeueOutputBuffer(decodedInfo, 1000)
                    if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        val actual = decoder.outputFormat
                        val sampleRate = decodedAudioSampleRate(selected.channels,
                            actual.getInteger(MediaFormat.KEY_CHANNEL_COUNT), actual.getInteger(MediaFormat.KEY_SAMPLE_RATE),
                            !actual.containsKey(MediaFormat.KEY_PCM_ENCODING) || actual.getInteger(MediaFormat.KEY_PCM_ENCODING) == AudioFormat.ENCODING_PCM_16BIT)
                        if (encoderStarted && sampleRate != outputSampleRate)
                            throw InputPreparationException(InputPreparationError.UNSUPPORTED)
                        if (!encoderStarted) {
                            // Opus can report its original input rate in the container but decode at 48 kHz.
                            // Encode the actual PCM rate so pitch, duration and timestamps stay correct.
                            outputSampleRate = sampleRate
                            val encodeFormat = MediaFormat.createAudioFormat("audio/mp4a-latm", outputSampleRate, selected.channels).apply {
                                setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                                setInteger(MediaFormat.KEY_BIT_RATE, minOf(selected.bitRate ?: 160_000, 160_000))
                                setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 64 * 1024)
                            }
                            encoder.configure(encodeFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                            encoder.start(); encoderStarted = true
                        }
                    } else if (index >= 0) {
                        pendingIndex = index
                        pending = requireNotNull(decoder.getOutputBuffer(index)).apply {
                            position(decodedInfo.offset); limit(decodedInfo.offset + decodedInfo.size)
                        }
                        pendingTime = decodedInfo.presentationTimeUs
                        pendingEnd = decodedInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                    }
                }
                if (pendingIndex >= 0) {
                    if (!encoderStarted) throw InputPreparationException(InputPreparationError.INVALID_AUDIO)
                    val index = encoder.dequeueInputBuffer(1000)
                    if (index >= 0) {
                        val input = requireNotNull(encoder.getInputBuffer(index)).apply { clear() }
                        val pcm = requireNotNull(pending)
                        val count = minOf(input.remaining(), pcm.remaining())
                        val originalLimit = pcm.limit()
                        pcm.limit(pcm.position() + count); input.put(pcm); pcm.limit(originalLimit)
                        val end = !pcm.hasRemaining() && pendingEnd
                        encoder.queueInputBuffer(index, 0, count, pendingTime, if (end) MediaCodec.BUFFER_FLAG_END_OF_STREAM else 0)
                        pcmBytes += count
                        pendingTime += count.toLong() * 1_000_000 / (outputSampleRate * selected.channels * 2)
                        if (!pcm.hasRemaining()) {
                            decoder.releaseOutputBuffer(pendingIndex, false); pendingIndex = -1; pending = null
                            decodeEnded = end
                        }
                    }
                }
                var index = if (encoderStarted) encoder.dequeueOutputBuffer(encodedInfo, 1000) else MediaCodec.INFO_TRY_AGAIN_LATER
                while (index != MediaCodec.INFO_TRY_AGAIN_LATER) {
                    check()
                    if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        if (muxerStarted) throw InputPreparationException(InputPreparationError.INVALID_AUDIO)
                        track = muxer.addTrack(encoder.outputFormat); muxer.start(); muxerStarted = true
                    } else if (index >= 0) {
                        val data = requireNotNull(encoder.getOutputBuffer(index))
                        if (encodedInfo.size > 0 && encodedInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
                            if (!muxerStarted) throw InputPreparationException(InputPreparationError.INVALID_AUDIO)
                            data.position(encodedInfo.offset); data.limit(encodedInfo.offset + encodedInfo.size)
                            muxer.writeSampleData(track, data, encodedInfo)
                        }
                        encodeEnded = encodedInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                        encoder.releaseOutputBuffer(index, false)
                    }
                    index = encoder.dequeueOutputBuffer(encodedInfo, 0)
                }
            }
            if (pcmBytes == 0L) throw InputPreparationException(InputPreparationError.NO_AUDIO)
        } finally {
            runCatching { if (decoderStarted) decoder.stop() }; decoder.release()
            runCatching { if (encoderStarted) encoder.stop() }; encoder.release()
            try { if (muxerStarted) muxer.stop() } finally { muxer.release() }
        }
    }
}
