package com.hatem.musicmute.processing

import java.time.Instant
import org.junit.Assert.*
import org.junit.Test

class AudioTaskPresentationTest {
    @Test fun importBecomesOneNamedJobAndDoesNotReappearAfterDeletion() {
        val record = UrlImportRecord("owner", "https://example.com/media", "import-request",
            status = "downloading", sourceTitle = "عنوان 🎵", createdAtMillis = 100)
        val importing = audioTaskPresentations(emptyList(), emptyList(), 200, listOf(record)).single()
        assertEquals(AudioTaskStage.DOWNLOADING_SOURCE, importing.stage)
        assertEquals("عنوان 🎵", importing.displayName)
        assertFalse(importing.canCancel)
        assertNull(importing.jobId)
        val ready = job("ready").copy(sourceTitle = record.sourceTitle, displayName = record.sourceTitle)
        val uploading = record.copy(status = "uploading", jobId = ready.id)
        val uploadTask = audioTaskPresentations(emptyList(), listOf(ready.copy(status = "awaiting_upload")),
            300, listOf(uploading)).single()
        assertEquals(AudioTaskStage.UPLOADING_INPUT, uploadTask.stage)
        assertTrue(uploadTask.importOnly)
        assertFalse(uploadTask.canCancel)
        val submitted = record.copy(status = "submitted", jobId = ready.id)
        val merged = audioTaskPresentations(emptyList(), listOf(ready), 300, listOf(submitted)).single()
        assertEquals(AudioTaskStage.READY, merged.stage)
        assertEquals(record.requestId, merged.importRequestId)
        assertEquals(record.sourceTitle, merged.displayName)
        assertTrue(audioTaskPresentations(emptyList(), emptyList(), 300,
            listOf(submitted.copy(jobObserved = true))).isEmpty())
        assertTrue(audioTaskPresentations(emptyList(), emptyList(), 300,
            listOf(submitted.copy(createdAtMillis = 0))).isEmpty())
        assertEquals(AudioTaskStage.QUEUED, audioTaskPresentations(emptyList(), emptyList(), 300,
            listOf(submitted)).single().stage)
    }

    @Test fun importFailuresStayRetryableWithoutJobActions() {
        val record = UrlImportRecord("owner", "https://example.com/media", "request",
            status = "failed", errorCode = "IMPORT_UPSTREAM_REFUSED")
        val task = audioTaskPresentations(emptyList(), emptyList(), 0, listOf(record)).single()
        assertFalse(task.active)
        assertTrue(task.canRetry)
        assertFalse(task.canDelete)
        assertEquals(record.errorCode, task.errorCode)
    }

    @Test fun audioDurationUsesSecondsFromMediaAndIsIndependentOfProcessingTime() {
        val ready = job("ready").copy(input = JobInput("mp3", 1000, 125.75),
            timing = JobTiming(totalElapsedMs = 9_000))
        val task = audioTaskPresentations(emptyList(), listOf(ready), 99_000).single()
        assertEquals(125_750L, task.audioDurationMs)
        assertNull(task.totalElapsedMs)
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
        assertNull(first.totalElapsedMs)
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
        assertNull(tasks.single().totalElapsedMs)
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
            stage(base.copy(phase = ProcessingPhase.CONFIRMING, uploadedBytes = 1000), "awaiting_upload").stage,
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

    @Test fun confirmedUploadNeverReturnsToWaitingWhileHistoryStillAwaitsUpload() {
        val operation = ProcessingOperation("operation", "owner", "request",
            jobId = job("awaiting_upload").id, phase = ProcessingPhase.CONFIRMING,
            input = InputDeclaration("mp3", "audio/mpeg", 1000, 30.0, "hash"), uploadedBytes = 1000,
            serverStatus = "awaiting_upload")
        val cached = job("awaiting_upload")
        val snapshots = listOf(
            operation,
            operation.copy(serverStatus = "queued"),
            operation.copy(serverStatus = "queued", phase = ProcessingPhase.COMPLETE),
        )
        assertEquals(
            listOf(AudioTaskStage.CONFIRMING_UPLOAD, AudioTaskStage.QUEUED, AudioTaskStage.QUEUED),
            snapshots.map { audioTaskPresentations(listOf(it), listOf(cached), 0).single().stage },
        )
    }

    @Test fun reservationResponseDoesNotResetLocalPreparationToWaiting() {
        val operation = ProcessingOperation("operation", "owner", "request",
            jobId = job("awaiting_upload").id, phase = ProcessingPhase.RESERVING,
            serverStatus = "awaiting_upload")
        assertEquals(AudioTaskStage.RESERVING_JOB,
            audioTaskPresentations(listOf(operation), listOf(job("awaiting_upload")), 0).single().stage)
    }

    @Test fun zeroBytesIsZeroPercentWhenTransferSizeIsKnown() {
        val operation = ProcessingOperation("operation", "owner", "request",
            phase = ProcessingPhase.UPLOADING,
            input = InputDeclaration("mp3", "audio/mpeg", 1000, 30.0, "hash"))
        assertEquals(0f, audioTaskPresentations(listOf(operation), emptyList(), 0).single().progressFraction)
    }

    @Test fun authoritativeRecoveryAndTerminalStatesOverridePersistedSubmission() {
        val operation = ProcessingOperation("operation", "owner", "request",
            jobId = job("queued").id, phase = ProcessingPhase.COMPLETE, serverStatus = "processing")
        for ((status, expected) in listOf(
            "queued" to AudioTaskStage.QUEUED,
            "interrupted" to AudioTaskStage.INTERRUPTED,
            "cancel_requested" to AudioTaskStage.CANCELLING,
            "failed" to AudioTaskStage.FAILED,
            "cancelled" to AudioTaskStage.CANCELLED,
            "ready" to AudioTaskStage.READY,
            "future_state" to AudioTaskStage.UNKNOWN,
        )) {
            assertEquals(status, expected,
                audioTaskPresentations(listOf(operation), listOf(job(status)), 0).single().stage)
        }
    }

    private fun job(status: String) = Job(
        "68c000000000000000000002", status, Instant.EPOCH, Instant.EPOCH,
        JobInput("mp3", 1000, 30.0), true, status == "ready", workerAvailable = true,
    )
}
