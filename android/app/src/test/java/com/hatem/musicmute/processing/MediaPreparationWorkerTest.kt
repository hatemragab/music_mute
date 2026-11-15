package com.hatem.musicmute.processing

import java.io.File
import java.util.UUID
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

/** JVM proof of durable dispatch and cancellation, not Android WorkManager runtime proof. */
class MediaPreparationWorkerTest {
    private class Scheduler : ProcessingScheduler, MediaPreparationScheduler, PipelineSourceScheduler {
        val scheduled = mutableListOf<String>()
        val cancelled = mutableListOf<String>()
        override suspend fun enqueue(ownerUid: String, operationId: String, epoch: Long) { scheduled += operationId }
        override suspend fun enqueue(ownerUid: String, operationId: String, url: String, epoch: Long) = error("Unexpected URL")
        override suspend fun cancel(ownerUid: String, operationId: String) { cancelled += operationId }
        override suspend fun cancelOwner(ownerUid: String) { cancelled += ownerUid }
    }
    private class Api : JobsApi {
        override suspend fun create(requestId: String, input: InputDeclaration): CreateReservation = error("Preparation must not reserve")
        override suspend fun renewUpload(id: String): UploadGrant = error("unused")
        override suspend fun confirmUpload(id: String): JobMutation = error("unused")
        override suspend fun list(cursor: String?, status: String?) = JobPage(emptyList())
        override suspend fun detail(id: String): Job = error("unused")
        override suspend fun cancel(id: String): JobMutation = error("unused")
        override suspend fun retry(id: String, requestId: String): JobMutation = error("unused")
        override suspend fun download(id: String, artifact: String): DownloadGrant = error("unused")
    }
    @Test fun duplicateDocumentDeliveryAndRestartRetainOneOperationAndCancellation() = runTest {
        val root = kotlin.io.path.createTempDirectory("media-dispatch-").toFile()
        val store = ProcessingStore(File(root, "metadata"), backgroundScope)
        val scheduler = Scheduler()
        val owner = { ProcessingSession("owner", 1) }
        val repository = ProcessingRepository(store, File(root, "staging"), Api(), owner, scheduler)
        val preparer = AudioInputPreparer(File(root, "staging")) { error("Dispatch must not inspect on UI coroutine") }
        fun coordinator() = AudioPipelineCoordinator(repository, preparer, owner, scheduler, preparationScheduler = scheduler)
        val id = UUID.randomUUID().toString()
        val first = coordinator().acceptDocument(id, "meeting.mp4", "content://provider/document/1")
        val duplicate = coordinator().acceptDocument(UUID.randomUUID().toString(), "meeting.mp4", "content://provider/document/1")
        assertEquals(first.operationId, duplicate.operationId)
        assertEquals(listOf(id), scheduler.scheduled)
        assertEquals("content://provider/document/1", store.get("owner", id)?.sourceUri)
        coordinator().resumePendingSources()
        assertEquals(listOf(id, id), scheduler.scheduled)
        coordinator().cancel(id)
        assertTrue(store.get("owner", id)!!.cancellationRequested)
        assertTrue(scheduler.cancelled.contains(id))
        scheduler.scheduled.clear()
        coordinator().resumePendingSources()
        assertTrue(scheduler.scheduled.isEmpty())
    }
}
