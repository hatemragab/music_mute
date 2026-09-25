package com.hatem.musicmute.processing

import java.io.File
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

}
