package com.hatem.musicmute.playback

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.os.SystemClock
import androidx.core.content.FileProvider
import com.hatem.musicmute.library.LibraryKey
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.math.abs
import kotlin.math.max

/** Streaming PCM16 decoding. Never materializes an audio file as a PCM array. */
private suspend fun decodePcm(file: File, range: AudioRange? = null,
    consume: (ByteBuffer, Long, Int, Int) -> Unit) {
    val extractor = MediaExtractor()
    var codec: MediaCodec? = null
    try {
        extractor.setDataSource(file.absolutePath)
        val track = (0 until extractor.trackCount).firstOrNull {
            extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
        } ?: error("Audio track unavailable")
        extractor.selectTrack(track)
        val format = extractor.getTrackFormat(track)
        require(format.getLong(MediaFormat.KEY_DURATION) in 1..10_800_000_000L)
        if (range != null) extractor.seekTo(range.startMs * 1000, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
        val decoder = MediaCodec.createDecoderByType(requireNotNull(format.getString(MediaFormat.KEY_MIME)))
        codec = decoder
        decoder.configure(format, null, null, 0)
        decoder.start()
        var rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        var channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
        var inputEnded = false
        val info = MediaCodec.BufferInfo()
        val started = SystemClock.elapsedRealtime()
        while (true) {
            currentCoroutineContext().ensureActive()
            check(SystemClock.elapsedRealtime() - started < 120_000) { "Audio analysis timed out" }
            if (!inputEnded) {
                val index = decoder.dequeueInputBuffer(10_000)
                if (index >= 0) {
                    val buffer = requireNotNull(decoder.getInputBuffer(index))
                    val count = extractor.readSampleData(buffer, 0)
                    if (count < 0) {
                        decoder.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                        inputEnded = true
                    } else {
                        decoder.queueInputBuffer(index, 0, count, extractor.sampleTime, 0)
                        extractor.advance()
                    }
                }
            }
            val out = decoder.dequeueOutputBuffer(info, 10_000)
            if (out == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                val output = decoder.outputFormat
                rate = output.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                channels = output.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                require(!output.containsKey(MediaFormat.KEY_PCM_ENCODING) ||
                    output.getInteger(MediaFormat.KEY_PCM_ENCODING) == AudioFormat.ENCODING_PCM_16BIT)
                require(rate in 8000..192000 && channels in 1..8)
            } else if (out >= 0) {
                try {
                    if (info.size > 0) {
                        val buffer = requireNotNull(decoder.getOutputBuffer(out))
                        buffer.position(info.offset); buffer.limit(info.offset + info.size)
                        consume(buffer.slice().order(ByteOrder.LITTLE_ENDIAN), info.presentationTimeUs, rate, channels)
                    }
                } finally { decoder.releaseOutputBuffer(out, false) }
                if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0 ||
                    (range != null && info.presentationTimeUs >= range.endMs * 1000)) break
            }
        }
    } finally {
        codec?.release()
        extractor.release()
    }
}

class LocalAudioTools(private val context: Context) {
    private val gate = Mutex()
    private val root = File(context.cacheDir, "listening")
    private fun owner(key: LibraryKey) = File(root, listeningKey(key.ownerUid))

    suspend fun waveform(key: LibraryKey, original: Boolean, file: File, durationMs: Long): List<Float> =
        withContext(Dispatchers.IO) { gate.withLock {
            require(durationMs > 0)
            val directory = File(owner(key), "peaks").apply { mkdirs() }
            prune(directory, 40, 8_000_000)
            val cache = File(directory, listeningKey("${key.jobId}:$original:${file.length()}:${file.lastModified()}") + ".peaks")
            if (cache.isFile && cache.length() == 240L * 4) {
                val bytes = ByteBuffer.wrap(cache.readBytes()).order(ByteOrder.LITTLE_ENDIAN)
                val result = List(240) { bytes.float }
                if (result.all { it.isFinite() && it in 0f..1f }) return@withLock result
            }
            val peaks = FloatArray(240)
            decodePcm(file) { pcm, timeUs, rate, channels ->
                var frame = 0L
                while (pcm.remaining() >= channels * 2) {
                    val bin = (((timeUs / 1000.0 + frame * 1000.0 / rate) / durationMs) * peaks.size).toInt()
                    var peak = 0f
                    repeat(channels) { peak = max(peak, abs(pcm.short.toInt()) / 32768f) }
                    if (bin in peaks.indices) peaks[bin] = max(peaks[bin], peak)
                    frame++
                }
            }
            currentCoroutineContext().ensureActive()
            val bytes = ByteBuffer.allocate(peaks.size * 4).order(ByteOrder.LITTLE_ENDIAN)
            peaks.forEach(bytes::putFloat)
            val temp = File(directory, cache.name + ".tmp")
            temp.writeBytes(bytes.array())
            check(temp.renameTo(cache))
            peaks.toList()
        } }

    suspend fun clip(key: LibraryKey, file: File, range: AudioRange, durationMs: Long): Intent =
        withContext(Dispatchers.IO) { gate.withLock {
            require(clipRangeValid(range, durationMs))
            val directory = File(owner(key), "clips").apply { mkdirs() }
            prune(directory, 4, 128_000_000)
            val output = File(directory, "voice-${java.util.UUID.randomUUID()}.wav")
            try {
                RandomAccessFile(output, "rw").use { wav ->
                    wav.write(ByteArray(44))
                    var sampleRate = 0
                    var channelCount = 0
                    decodePcm(file, range) { pcm, timeUs, rate, channels ->
                        if (sampleRate != 0) require(sampleRate == rate && channelCount == channels)
                        sampleRate = rate; channelCount = channels
                        val frames = pcm.remaining() / (channels * 2)
                        val from = kotlin.math.ceil((range.startMs * 1000 - timeUs) * rate / 1_000_000.0).toInt().coerceIn(0, frames)
                        val until = kotlin.math.ceil((range.endMs * 1000 - timeUs) * rate / 1_000_000.0).toInt().coerceIn(from, frames)
                        if (until > from) {
                            val bytes = ByteArray((until - from) * channels * 2)
                            pcm.position(from * channels * 2); pcm.get(bytes)
                            check(wav.length() + bytes.size <= 64_000_000) { "Clip too large" }
                            wav.write(bytes)
                        }
                    }
                    check(wav.length() > 44 && sampleRate > 0)
                    val size = (wav.length() - 44).toInt()
                    val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
                    header.put("RIFF".toByteArray()).putInt(size + 36).put("WAVEfmt ".toByteArray())
                        .putInt(16).putShort(1).putShort(channelCount.toShort()).putInt(sampleRate)
                        .putInt(sampleRate * channelCount * 2).putShort((channelCount * 2).toShort())
                        .putShort(16).put("data".toByteArray()).putInt(size)
                    wav.seek(0); wav.write(header.array())
                }
                currentCoroutineContext().ensureActive()
                val uri = FileProvider.getUriForFile(context, "${context.packageName}.processed-audio", output)
                Intent(Intent.ACTION_SEND).apply {
                    type = "audio/wav"
                    putExtra(Intent.EXTRA_STREAM, uri)
                    clipData = ClipData.newUri(context.contentResolver, "Voice clip", uri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
            } catch (error: Exception) { output.delete(); throw error }
        } }

    suspend fun clear(ownerUid: String) = withContext(Dispatchers.IO) {
        gate.withLock { File(root, listeningKey(ownerUid)).deleteRecursively() }
    }

    private fun prune(directory: File, count: Int, bytes: Long) {
        val files = directory.listFiles()?.sortedByDescending { it.lastModified() }.orEmpty()
        var total = 0L
        files.forEachIndexed { index, file ->
            total += file.length()
            if (index >= count || total > bytes || System.currentTimeMillis() - file.lastModified() > 86_400_000) file.delete()
        }
    }
}
