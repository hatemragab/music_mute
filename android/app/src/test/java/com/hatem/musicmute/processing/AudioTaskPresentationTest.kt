package com.hatem.musicmute.processing

import java.time.Instant
import org.junit.Assert.*
import org.junit.Test

class AudioTaskPresentationTest {
    @Test fun audioDurationUsesSecondsFromMediaAndIsIndependentOfProcessingTime() {
        val ready = job("ready").copy(input = JobInput("mp3", 1000, 125.75),
            timing = JobTiming(totalElapsedMs = 9_000))
        val task = audioTaskPresentations(emptyList(), listOf(ready), 99_000).single()
        assertEquals(125_750L, task.audioDurationMs)
        assertEquals(9_000L, task.totalElapsedMs)
        for (duration in listOf(Double.NaN, Double.POSITIVE_INFINITY, -1.0, 0.0)) {
            assertNull(audioTaskPresentations(emptyList(), listOf(ready.copy(
                input = ready.input.copy(durationSeconds = duration))), 0).single().audioDurationMs)
        }
    }

    @Test fun failureReasonsSurviveProjectionWithoutExposingServerDiagnostics() {
        val failed = job("failed").copy(error = JobError("INVALID_AUDIO", "private diagnostic", Instant.EPOCH))
        val task = audioTaskPresentations(emptyList(), listOf(failed), 0).single()
        assertEquals("INVALID_AUDIO", task.errorCode)
        assertEquals(com.hatem.musicmute.R.string.processing_reason_invalid,
            com.hatem.musicmute.ui.audioTaskFailureLabel(task))
        assertEquals(com.hatem.musicmute.R.string.processing_reason_upload_expired,
            com.hatem.musicmute.ui.audioTaskFailureLabel(task.copy(errorCode = "UPLOAD_EXPIRED")))
        assertEquals(com.hatem.musicmute.R.string.processing_error_failed,
            com.hatem.musicmute.ui.audioTaskFailureLabel(task.copy(errorCode = "FUTURE_ERROR")))
    }

    @Test fun localFailureAndOfflineServiceHaveSpecificMessages() {
        val operation = ProcessingOperation("operation", "owner", "request",
            phase = ProcessingPhase.PAUSED, localProblem = ProcessingLocalProblem.STORAGE)
        val task = audioTaskPresentations(listOf(operation), emptyList(), 0).single()
        assertEquals(com.hatem.musicmute.R.string.processing_error_storage,
            com.hatem.musicmute.ui.audioTaskFailureLabel(task))
        assertEquals(com.hatem.musicmute.R.string.processing_error_offline,
            com.hatem.musicmute.ui.audioTaskFailureLabel(task.copy(problem = JobsProblem.OFFLINE)))
        val recovered = audioTaskPresentations(listOf(operation.copy(jobId = "68c000000000000000000002")),
            listOf(job("ready")), 0).single()
        assertNull(com.hatem.musicmute.ui.audioTaskFailureLabel(recovered))
    }

    @Test fun finishedTaskElapsedTimeDoesNotGrowWhenReopened() {
        val operation = ProcessingOperation("operation", "owner", "request",
            jobId = "68c000000000000000000002", clientStartedAtMillis = 1_000)
        val finished = job("failed").copy(finishedAt = Instant.ofEpochMilli(6_000))
        val first = audioTaskPresentations(listOf(operation), listOf(finished), 10_000).single()
        val later = audioTaskPresentations(listOf(operation), listOf(finished), 90_000).single()
        assertEquals(5_000L, first.totalElapsedMs)
        assertEquals(first.totalElapsedMs, later.totalElapsedMs)
    }

    @Test fun terminalLocalTaskWithoutEndTimestampDoesNotInventElapsedTime() {
        val operation = ProcessingOperation("operation", "owner", "request",
            phase = ProcessingPhase.PAUSED, clientStartedAtMillis = 1_000)
        assertNull(audioTaskPresentations(listOf(operation), emptyList(), 90_000).single().totalElapsedMs)
    }

    @Test fun localAndServerRowsMergeByOperationReferenceWithoutLosingNamesOrProgress() {
        val operation = ProcessingOperation(
            operationId = "c21a2eaa-7e73-4f08-89da-6ac35baa83e1", ownerUid = "owner",
            requestId = "c21a2eaa-7e73-4f08-89da-6ac35baa83e1", sourceKind = SourceKind.URL,
            sourceTitle = "Interview", displayName = "My interview", phase = ProcessingPhase.UPLOADING,
            uploadedBytes = 500, input = InputDeclaration("mp3", "audio/mpeg", 1000, 30.0, "hash"),
            clientStartedAtMillis = 1_000,
        )
        val job = Job(
            id = "68c000000000000000000002", requestId = operation.requestId,
            sourceTitle = "Interview", displayName = "My interview", sourceKind = "url",
            status = "processing", createdAt = Instant.ofEpochMilli(2_000), updatedAt = Instant.ofEpochMilli(4_000),
            input = JobInput("mp3", 1000, 30.0), canDownloadInput = true, canDownloadOutput = false,
            serverTime = Instant.ofEpochMilli(5_000), workerAvailable = true,
        )
        val tasks = audioTaskPresentations(listOf(operation), listOf(job), nowMillis = 10_000)
        assertEquals(1, tasks.size)
        assertEquals("My interview", tasks.single().displayName)
        assertEquals("Interview", tasks.single().sourceTitle)
        assertEquals("68c000000000000000000002", tasks.single().jobId)
        assertEquals(AudioTaskStage.PROCESSING, tasks.single().stage)
        assertNull(tasks.single().progressFraction)
        assertEquals(9_000L, tasks.single().totalElapsedMs)
    }

    @Test fun stagesActionsAndServerTimingsAreHonestForTerminalAndUnknownStates() {
        val ready = job("ready").copy(
            displayName = null,
            timing = JobTiming(20_000, false, 70_000, true),
            stages = JobStages(processingStartedAt = Instant.parse("2026-09-10T12:00:00Z")),
        )
        val unknown = job("future_state").copy(id = "68c000000000000000000003")
        val tasks = audioTaskPresentations(emptyList(), listOf(ready, unknown), 0)
        assertEquals(AudioTaskStage.READY, tasks[0].stage)
        assertTrue(tasks[0].canDelete)
        assertTrue(tasks[0].canPlay)
        assertEquals("Audio", tasks[0].displayName)
        assertEquals(20_000L, tasks[0].processingElapsedMs)
        assertTrue(tasks[0].totalElapsedApproximate)
        assertEquals(AudioTaskStage.UNKNOWN, tasks[1].stage)
        assertFalse(tasks[1].canDelete)
        assertNull(tasks[1].operationId)
    }

    @Test fun activeLocalTransferAndCancellationOverrideOnlyNonterminalServerState() {
        val base = ProcessingOperation(
            operationId = "c21a2eaa-7e73-4f08-89da-6ac35baa83e1",
            ownerUid = "owner",
            requestId = "c21a2eaa-7e73-4f08-89da-6ac35baa83e1",
            jobId = "68c000000000000000000002",
            input = InputDeclaration("mp3", "audio/mpeg", 1000, 30.0, "hash"),
            uploadedBytes = 500,
        )
        fun stage(operation: ProcessingOperation, status: String) =
            audioTaskPresentations(listOf(operation), listOf(job(status)), 0).single()

        val uploading = stage(base.copy(phase = ProcessingPhase.UPLOADING), "awaiting_upload")
        assertEquals(AudioTaskStage.UPLOADING_INPUT, uploading.stage)
        assertEquals(.5f, uploading.progressFraction)
        assertEquals(
            AudioTaskStage.CONFIRMING_UPLOAD,
            stage(base.copy(phase = ProcessingPhase.CONFIRMING), "awaiting_upload").stage,
        )
        assertEquals(
            AudioTaskStage.CANCELLING,
            stage(base.copy(phase = ProcessingPhase.CANCELLING), "queued").stage,
        )
        assertEquals(
            AudioTaskStage.READY,
            stage(base.copy(phase = ProcessingPhase.CANCELLING), "ready").stage,
        )
    }

    @Test fun recoveredOperationUsesPersistedServerStatusWithoutLoadedJob() {
        val operation = ProcessingOperation(
            operationId = "c21a2eaa-7e73-4f08-89da-6ac35baa83e1",
            ownerUid = "owner",
            requestId = "c21a2eaa-7e73-4f08-89da-6ac35baa83e1",
            phase = ProcessingPhase.COMPLETE,
        )
        assertEquals(
            AudioTaskStage.CANCELLED,
            audioTaskPresentations(listOf(operation.copy(serverStatus = "cancelled")), emptyList(), 0)
                .single().stage,
        )
        assertEquals(
            AudioTaskStage.QUEUED,
            audioTaskPresentations(listOf(operation.copy(serverStatus = "queued")), emptyList(), 0)
                .single().stage,
        )
    }

    private fun job(status: String) = Job(
        "68c000000000000000000002", status, Instant.EPOCH, Instant.EPOCH,
        JobInput("mp3", 1000, 30.0), true, status == "ready", workerAvailable = true,
    )
}
