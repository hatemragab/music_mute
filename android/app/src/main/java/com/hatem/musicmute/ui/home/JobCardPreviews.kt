package com.hatem.musicmute.ui.home

import androidx.compose.foundation.layout.*
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.processing.Job
import com.hatem.musicmute.processing.JobInput
import com.hatem.musicmute.processing.ProcessingProgress
import com.hatem.musicmute.processing.ProcessingQueue
import com.hatem.musicmute.processing.RealtimeState
import com.hatem.musicmute.processing.ServerStageTimings
import com.hatem.musicmute.processing.UrlImportRecord
import com.hatem.musicmute.processing.audioTaskPresentations
import com.hatem.musicmute.ui.VocalTheme
import java.time.Instant

@Preview(name = "Console glow and Studio pulse job states", widthDp = 390, heightDp = 1660)
@Preview(name = "Console glow Arabic states", locale = "ar", widthDp = 390, heightDp = 1660)
@Preview(name = "Console glow narrow large text", widthDp = 320, heightDp = 2440, fontScale = 1.6f)
@Preview(name = "Console glow Arabic large text", locale = "ar", widthDp = 320, heightDp = 2440, fontScale = 1.6f)
@Composable
private fun JobCardStatesPreview() = VocalTheme {
    val created = Instant.parse("2026-10-01T10:00:00Z")
    val sample = Job(
        id = "68c000000000000000000001", status = "queued", createdAt = created, updatedAt = created,
        input = JobInput("mp3", 1000, 182.0), canDownloadInput = false, canDownloadOutput = false,
        displayName = "Ava Max – My Head & My Heart", sourceKind = "url",
        serverStageTimings = ServerStageTimings(totalMs = 16_000),
        queue = ProcessingQueue("waiting", position = 1, asOf = created.toString()),
    )
    val jobs = listOf(
        sample,
        sample.copy(status = "processing", queue = null,
            processingProgress = ProcessingProgress("separation", phasePercent = 42.0)),
        sample.copy(status = "processing", queue = null),
        sample.copy(workerAvailable = false, queue = sample.queue?.copy(state = "blocked", position = null, reason = "worker_unavailable")),
        sample.copy(status = "ready", queue = null),
    )
    val failed = UrlImportRecord("preview", "https://example.com/audio", "preview-import",
        status = "failed", sourceTitle = sample.displayName, createdAtMillis = created.toEpochMilli(),
        errorCode = "IMPORT_DEPENDENCY_FAILED")
    Surface {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            jobs.forEach { job ->
                val task = audioTaskPresentations(emptyList(), listOf(job), 0).single()
                JobCard(task, false, {}, {}, job = job, connection = RealtimeState.LIVE)
            }
            for (code in listOf("IMPORT_DEPENDENCY_FAILED", "IMPORT_INVALID_AUDIO")) {
                val task = audioTaskPresentations(emptyList(), emptyList(), 0,
                    listOf(failed.copy(errorCode = code))).single()
                JobCard(task, false, {}, {})
            }
        }
    }
}
