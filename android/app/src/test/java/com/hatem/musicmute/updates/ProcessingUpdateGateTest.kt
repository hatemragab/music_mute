package com.hatem.musicmute.updates

import com.hatem.musicmute.processing.CreateReservation
import com.hatem.musicmute.processing.DownloadGrant
import com.hatem.musicmute.processing.Job
import com.hatem.musicmute.processing.JobMutation
import com.hatem.musicmute.processing.JobPage
import com.hatem.musicmute.processing.JobsApi
import com.hatem.musicmute.processing.JobsProblem
import com.hatem.musicmute.processing.ProcessingOperation
import com.hatem.musicmute.processing.ProcessingPhase
import com.hatem.musicmute.processing.ProcessingRepository
import com.hatem.musicmute.processing.ProcessingRunResult
import com.hatem.musicmute.processing.ProcessingScheduler
import com.hatem.musicmute.processing.ProcessingSession
import com.hatem.musicmute.processing.ProcessingStore
import com.hatem.musicmute.processing.UploadGrant
import java.util.UUID
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class ProcessingUpdateGateTest {
    private class Scheduler : ProcessingScheduler {
        val cancelled = mutableListOf<String>()
        override suspend fun enqueue(ownerUid: String, operationId: String, epoch: Long) = Unit
        override suspend fun cancel(ownerUid: String, operationId: String) { cancelled += operationId }
        override suspend fun cancelOwner(ownerUid: String) = Unit
    }

    private class Api : JobsApi {
        var cloudCancels = 0
        var cloudDeletes = 0
        override suspend fun create(requestId: String, input: com.hatem.musicmute.processing.InputDeclaration): CreateReservation = error("unused")
        override suspend fun renewUpload(id: String): UploadGrant = error("unused")
        override suspend fun confirmUpload(id: String): JobMutation = error("unused")
        override suspend fun list(cursor: String?, status: String?): JobPage = JobPage(emptyList())
        override suspend fun detail(id: String): Job = error("unused")
        override suspend fun cancel(id: String): JobMutation { cloudCancels++; error("must not cancel cloud work") }
        override suspend fun retry(id: String, requestId: String): JobMutation = error("unused")
        override suspend fun download(id: String, artifact: String): DownloadGrant = error("unused")
        override suspend fun delete(id: String) { cloudDeletes++; error("must not delete cloud work") }
    }

    @Test
    fun requiredUpdatePausesLocalTransferWithoutCancellingCloudJobOrDeletingInput() = runTest {
        val root = kotlin.io.path.createTempDirectory("processing-update-").toFile()
        val store = ProcessingStore(root, backgroundScope)
        val scheduler = Scheduler()
        val api = Api()
        var blocked = false
        val repository =
            ProcessingRepository(
                store,
                root,
                api,
                { ProcessingSession("owner", 7) },
                scheduler,
                updateBlocked = { blocked },
            )
        val operationId = UUID.randomUUID().toString()
        val original =
            ProcessingOperation(
                operationId = operationId,
                ownerUid = "owner",
                requestId = operationId,
                jobId = "68c000000000000000000001",
                stagedRelativePath = "owned/input.mp3",
                phase = ProcessingPhase.UPLOADING,
                runId = "active-run",
            )
        store.put("owner", original)

        blocked = true
        repository.pauseForUpdate()

        val paused = store.get("owner", operationId)!!
        assertEquals(ProcessingPhase.WAITING, paused.phase)
        assertNull(paused.runId)
        assertEquals(original.jobId, paused.jobId)
        assertEquals(original.stagedRelativePath, paused.stagedRelativePath)
        assertFalse(paused.cancellationRequested)
        assertEquals(listOf(operationId), scheduler.cancelled)
        assertEquals(0, api.cloudCancels)
        assertEquals(0, api.cloudDeletes)
        assertEquals(ProcessingRunResult.PAUSED, repository.runUpload("owner", operationId, 7))
        assertEquals(JobsProblem.APP_UPDATE_REQUIRED, store.get("owner", operationId)?.problem)
    }
}
