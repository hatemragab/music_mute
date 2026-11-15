package com.hatem.musicmute.processing

import android.app.Activity
import android.app.Instrumentation
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import java.io.File
import java.util.UUID
import kotlinx.coroutines.runBlocking

/** Opt-in native preparation check against a URI already granted to the installed app. */
class MediaPreparationTestRunner : Instrumentation() {
    private var sourceUri: String? = null

    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        sourceUri = arguments?.getString("sourceUri")
        start()
    }

    override fun onStart() {
        val output = File(targetContext.cacheDir, "native-preparation-test.m4a")
        val staging = File(targetContext.cacheDir, "native-preparation-staging")
        val report = Bundle()
        try {
            runBlocking {
                val uri = Uri.parse(requireNotNull(sourceUri) { "Pass -e sourceUri with a granted media URI" })
                val engine = AudioPreparationEngine(targetContext)
                val inspection = engine.inspect(uri)
                val started = SystemClock.elapsedRealtime()
                engine.prepare(uri, output, ProcessingMediaPolicy.STANDARD)
                val engineMillis = SystemClock.elapsedRealtime() - started
                val result = inspectProcessingAudio(output)
                check(result.hasAudio && !result.hasVideo)
                check(ProcessingMediaPolicy.STANDARD.acceptsPrepared(output.length(), result.durationSeconds))
                check(kotlin.math.abs(result.durationSeconds - inspection.audio.durationSeconds) < 0.25) {
                    "Preparation changed the audio duration"
                }
                val preparer = AudioInputPreparer(staging,
                    validateDecoded = ::validateDecodedProcessingAudio,
                    inspect = ::inspectProcessingAudio)
                val staged = preparer.prepare("test-owner", "prepared.m4a", UUID.randomUUID().toString(),
                    ProcessingMediaPolicy.STANDARD, if (inspection.hasVideo) "video_file" else "audio_file",
                    validateFullDecode = false) { output.inputStream() }
                check(staged.declaration.bytes == output.length())
                report.putString("result", "PASS: audio-only output, ${output.length()} bytes, ${result.durationSeconds} seconds; engine ${engineMillis} ms, staging ${SystemClock.elapsedRealtime() - started - engineMillis} ms")
            }
            finish(Activity.RESULT_OK, report)
        } catch (error: Exception) {
            report.putString("failure", error.stackTraceToString())
            finish(Activity.RESULT_CANCELED, report)
        } finally {
            output.delete()
            staging.deleteRecursively()
        }
    }
}
