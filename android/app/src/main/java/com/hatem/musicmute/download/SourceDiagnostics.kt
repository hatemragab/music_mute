package com.hatem.musicmute.download

import android.content.Context
import android.util.Log
import com.hatem.musicmute.BuildConfig
import java.io.File

internal enum class SourceHint { NONE, PO_TOKEN, JS_CHALLENGE, FORMAT_UNAVAILABLE }

internal fun sourceHint(text: String): SourceHint {
    val message = text.lowercase()
    return when {
        "po token" in message || "po_token" in message -> SourceHint.PO_TOKEN
        "challenge" in message || "javascript runtime" in message || "signature extraction" in message ||
            "nsig extraction" in message -> SourceHint.JS_CHALLENGE
        "requested format" in message -> SourceHint.FORMAT_UNAVAILABLE
        else -> SourceHint.NONE
    }
}

/** No native output, source URL, title, account ID, or exception stack is accepted. */
internal class SourceDiagnostics(context: Context) {
    private val file = File(context.noBackupFilesDir, "youtube-diagnostics.log")

    fun event(stage: String, outcome: String, startedAt: Long, version: String,
        reason: DownloadError = DownloadError.NONE, refusal: SourceRefusal = SourceRefusal.NONE,
        hint: SourceHint = SourceHint.NONE, bytes: Long = 0L) {
        val safeStage = stage.takeIf { it in setOf("initialization", "pacing", "metadata", "download", "output", "update", "attempt") } ?: "attempt"
        val safeOutcome = outcome.takeIf { it in setOf("START", "SUCCESS", "FAILED", "CANCELLED", "DEFERRED") } ?: "FAILED"
        val safeVersion = version.takeIf { it.matches(Regex("[0-9]{4}\\.[0-9]{2}\\.[0-9]{2}")) } ?: "unknown"
        val elapsed = ((System.nanoTime() - startedAt) / 1_000_000).coerceAtLeast(0)
        val line = "time=${System.currentTimeMillis()} stage=$safeStage outcome=$safeOutcome elapsed_ms=$elapsed extractor=$safeVersion category=${reason.name} refusal=${refusal.name} hint=${hint.name} bytes=${bytes.coerceAtLeast(0)}"
        Log.i("YoutubeSource", line)
        // Bounded debug-only journal remains available after logcat rotates or the process exits.
        if (BuildConfig.DEBUG) synchronized(journalLock) {
            runCatching {
                val retained = if (file.isFile) file.readLines().takeLast(99) else emptyList()
                file.writeText((retained + line).joinToString("\n", postfix = "\n"))
            }
        }
    }

    private companion object { val journalLock = Any() }
}
