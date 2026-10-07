package com.hatem.musicmute.processing

import java.io.File
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class ProcessingStoreTest {
    @Test fun unknownPersistedPhaseStopsRecoveryWithoutLosingTheJob() {
        val operation = kotlinx.serialization.json.Json.decodeFromString<ProcessingOperation>(
            """{"operationId":"operation","ownerUid":"owner","requestId":"request","jobId":"job","phase":"UNSUPPORTED_PHASE"}""")
        assertEquals(ProcessingPhase.PAUSED, operation.phase)
        assertEquals("job", operation.jobId)
    }

    @Test fun confirmationProbeDoesNotTurnPartialUploadFailureIntoCompletedUpload() = runTest {
        val root = kotlin.io.path.createTempDirectory("processing-probe-").toFile()
        val store = ProcessingStore(root, backgroundScope)
        val operation = ProcessingOperation("operation", "owner", "request", jobId = "job",
            input = InputDeclaration("mp3", "audio/mpeg", 1000, 30.0, "hash"),
            phase = ProcessingPhase.RESERVING, serverStatus = "awaiting_upload")
        store.put("owner", operation)
        store.update("owner", "operation") { it.copy(phase = ProcessingPhase.CONFIRMING) }
        val probe = audioTaskPresentations(store.operations("owner").first(), emptyList(), 0).single()
        assertEquals(AudioTaskStage.UPLOADING_INPUT, probe.stage)
        store.update("owner", "operation") { it.copy(phase = ProcessingPhase.UPLOADING, uploadedBytes = 200) }
        store.update("owner", "operation") { it.copy(phase = ProcessingPhase.PAUSED) }
        val steps = audioTaskTimeline(audioTaskPresentations(store.operations("owner").first(), emptyList(), 0).single())
        assertEquals(AudioStepState.FAILED, steps.single { it.stage == AudioTaskStage.UPLOADING_INPUT }.state)
        assertEquals(AudioStepState.PENDING, steps.single { it.stage == AudioTaskStage.CONFIRMING_UPLOAD }.state)
    }



    @Test fun ownerSnapshotsAndIntentsStayIsolated() = runTest {
        val root=kotlin.io.path.createTempDirectory("processing-store-").toFile()
        val store=ProcessingStore(root,backgroundScope)
        val op=ProcessingOperation(UUID.randomUUID().toString(),"a",UUID.randomUUID().toString(),InputDeclaration("mp3","audio/mpeg",3,1.0,"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),"input.mp3","clip.mp3")
        store.put("a",op)
        assertEquals(op,store.get("a",op.operationId))
        assertTrue(store.operations("b").first().isEmpty())
        assertTrue(runCatching { store.put("b",op) }.isFailure)
    }

    @Test fun corruptionNeverSilentlyReplacesReservationIdentity() = runTest {
        val root=kotlin.io.path.createTempDirectory("processing-corrupt-").toFile()
        val file=File(processingOwnerDirectory(root,"a"),"processing.json")
        requireNotNull(file.parentFile).mkdirs(); file.writeText("{broken")
        val store=ProcessingStore(root,backgroundScope)
        assertTrue(runCatching { store.operations("a").first() }.isFailure)
        assertEquals("{broken",file.readText())
    }
    @Test fun terminalSnapshotRemovesOnlyTheConfirmedCloudOperation() = runTest {
        val store = ProcessingStore(kotlin.io.path.createTempDirectory("processing-retire-").toFile(), backgroundScope)
        val done = ProcessingOperation("done", "owner", "done-request", jobId = "ready-job",
            phase = ProcessingPhase.COMPLETE, serverStatus = "queued")
        val failed = ProcessingOperation("failed", "owner", "failed-request", jobId = "failed-job",
            phase = ProcessingPhase.COMPLETE, serverStatus = "processing")
        val uploading = ProcessingOperation("uploading", "owner", "upload-request", jobId = "queued-job",
            phase = ProcessingPhase.UPLOADING, serverStatus = "awaiting_upload")
        val unseen = ProcessingOperation("unseen", "owner", "unseen-request", jobId = "old-job",
            phase = ProcessingPhase.COMPLETE, serverStatus = "queued")
        listOf(done, failed, uploading, unseen).forEach { store.put("owner", it) }
        store.retireConfirmedTerminalOperations("owner", listOf(
            storedJob("ready-job", "ready"),
            storedJob("failed-job", "failed"),
            storedJob("queued-job", "queued"),
            storedJob("cancelled-job", "cancelled"),
        ))
        assertEquals(setOf("uploading", "unseen"), store.operations("owner").first().map { it.operationId }.toSet())
        store.retireConfirmedTerminalOperations("owner", emptyList())
        assertEquals(setOf("uploading", "unseen"), store.operations("owner").first().map { it.operationId }.toSet())
    }

    @Test fun reopeningRetainsTheExactReservationAndStagedPath() = runTest {
        val root=kotlin.io.path.createTempDirectory("processing-reopen-").toFile()
        val firstJob=SupervisorJob()
        val first=ProcessingStore(root,CoroutineScope(firstJob + Dispatchers.IO))
        val operation=ProcessingOperation(UUID.randomUUID().toString(),"a",UUID.randomUUID().toString(),InputDeclaration("mp3","audio/mpeg",3,1.0,"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),"owned/input.mp3","clip.mp3",phase=ProcessingPhase.UPLOADING)
        first.put("a",operation)
        firstJob.cancelAndJoin()
        val reopened=ProcessingStore(root,backgroundScope)
        assertEquals(operation,reopened.get("a",operation.operationId))
    }

    private fun storedJob(id: String, status: String) = Job(
        id, status, Instant.EPOCH, Instant.EPOCH, JobInput("mp3", 32, 12.0), false, status == "ready",
    )

}
