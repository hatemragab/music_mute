package com.hatem.musicmute.processing

import android.app.Activity
import android.app.Instrumentation
import android.net.Uri
import android.os.Bundle
import java.io.File
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
        val report = Bundle()
        try {
            runBlocking {
                val uri = Uri.parse(requireNotNull(sourceUri) { "Pass -e sourceUri with a granted media URI" })
                val engine = AudioPreparationEngine(targetContext)
                val inspection = engine.inspect(uri)
                report.putString("inspection", inspection.toString())
                engine.prepare(uri, output, ProcessingMediaPolicy.LEGACY)
                val result = inspectProcessingAudio(output)
                check(result.hasAudio && !result.hasVideo)
                check(ProcessingMediaPolicy.LEGACY.acceptsPrepared(output.length(), result.durationSeconds))
                check(kotlin.math.abs(result.durationSeconds - inspection.audio.durationSeconds) < 0.25) {
                    "Preparation changed the audio duration"
                }
                report.putString("result", "PASS: audio-only output, ${output.length()} bytes, ${result.durationSeconds} seconds")
            }
            finish(Activity.RESULT_OK, report)
        } catch (error: Exception) {
            report.putString("failure", error.stackTraceToString())
            finish(Activity.RESULT_CANCELED, report)
        } finally {
            output.delete()
        }
    }
}
