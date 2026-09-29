package com.hatem.musicmute.playback

import android.content.Context
import android.content.Intent
import android.net.Uri
import com.hatem.musicmute.MainActivity
import com.hatem.musicmute.library.LibraryKey
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.sin

/** Synthetic Android-framework regression checks. Run only on an authorized Android target. */
internal suspend fun checkListeningFeatures(context: Context) {
    check(MainActivity.incomingAudio(Intent(Intent.ACTION_SEND).setType("audio/wav")
        .putExtra(Intent.EXTRA_STREAM, Uri.parse("file:///private.wav"))) == null)
    val content = Uri.parse("content://fixture/audio")
    check(MainActivity.incomingAudio(Intent(Intent.ACTION_SEND).setType("audio/wav").putExtra(Intent.EXTRA_STREAM, content)) == content)
    check(MainActivity.incomingAudio(Intent(Intent.ACTION_SEND_MULTIPLE).setType("audio/wav").putExtra(Intent.EXTRA_STREAM, content)) == null)
    check(MainActivity.entryPendingIntent(context, "IMPORT_AUDIO") != MainActivity.entryPendingIntent(context, "IMPORT_LINK"))
    check(MainActivity.entryPendingIntent(context, "LIBRARY") != MainActivity.playerPendingIntent(context))
    val source = File.createTempFile("waveform-fixture", ".wav", context.cacheDir)
    val owner = "listening-fixture-${java.util.UUID.randomUUID()}"
    val tools = LocalAudioTools(context)
    try {
        val samples = 16_000 * 2
        val wav = ByteBuffer.allocate(44 + samples * 2).order(ByteOrder.LITTLE_ENDIAN)
        wav.put("RIFF".toByteArray()).putInt(samples * 2 + 36).put("WAVEfmt ".toByteArray())
            .putInt(16).putShort(1).putShort(1).putInt(16_000).putInt(32_000).putShort(2).putShort(16)
            .put("data".toByteArray()).putInt(samples * 2)
        repeat(samples) { i -> wav.putShort(if (i < 16_000) 0 else (sin(i * 2 * Math.PI * 440 / 16_000) * 16_000).toInt().toShort()) }
        source.writeBytes(wav.array())
        val key = LibraryKey(owner, "fixture")
        val peaks = tools.waveform(key, false, source, 2000)
        check(peaks.size == 240 && peaks.all { it.isFinite() && it in 0f..1f })
        check(peaks.take(100).all { it < 0.01f } && peaks.takeLast(100).any { it > 0.4f })
        check(tools.waveform(key, false, source, 2000) == peaks)
        val share = tools.clip(key, source, AudioRange(1000, 1600), 2000)
        check(share.type == "audio/wav" && share.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
        @Suppress("DEPRECATION") val uri = requireNotNull(share.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
        val bytes = requireNotNull(context.contentResolver.openInputStream(uri)).use { it.readBytes() }
        check(String(bytes, 0, 4) == "RIFF")
        val header = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        check(header.getInt(40) in 19_000..19_400) // 600 ms PCM16 mono, 16 kHz.
        check(bytes.size == header.getInt(40) + 44)
    } finally { source.delete(); tools.clear(owner) }
}
