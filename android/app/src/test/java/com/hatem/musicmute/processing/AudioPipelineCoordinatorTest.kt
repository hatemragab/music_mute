package com.hatem.musicmute.processing

import java.io.ByteArrayInputStream
import java.io.File
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class AudioPipelineCoordinatorTest {
    private class UploadScheduler : ProcessingScheduler {
        val enqueued = mutableListOf<String>()
        override suspend fun enqueue(ownerUid: String, operationId: String, epoch: Long) { enqueued += operationId }
        override suspend fun cancel(ownerUid: String, operationId: String) = Unit
        override suspend fun cancelOwner(ownerUid: String) = Unit
    }
    private class Api : JobsApi {
        override suspend fun create(requestId: String, input: InputDeclaration) = error("unused")
        override suspend fun renewUpload(id: String) = error("unused")
        override suspend fun confirmUpload(id: String) = error("unused")
        override suspend fun list(cursor: String?, status: String?) = JobPage(emptyList())
        override suspend fun detail(id: String) = error("unused")
        override suspend fun cancel(id: String) = error("unused")
        override suspend fun retry(id: String, requestId: String) = error("unused")
        override suspend fun download(id: String, artifact: String) = error("unused")
    }

    @Test fun importTitleRemovesOnlyTheFileExtension() = runTest {
        val fixture = fixture()
        val operation = fixture.coordinator.acceptImport(UUID.randomUUID().toString(), "Song ft. Singer.mp3") {
            ByteArrayInputStream(byteArrayOf(1, 2, 3))
        }
        assertEquals("Song ft. Singer", operation.displayName)
        assertEquals("Song ft. Singer", operation.sourceTitle)
    }

    @Test fun longImportNameKeepsSupportedExtensionAfterTitleBounding() = runTest {
        val fixture = fixture()
        val id = UUID.randomUUID().toString()
        val operation = fixture.coordinator.acceptImport(id, "صصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصص.mp3") {
            ByteArrayInputStream(byteArrayOf(1, 2, 3))
        }
        assertEquals("mp3", operation.input?.extension)
        assertEquals(200, operation.sourceTitle.codePointCount(0, operation.sourceTitle.length))
        assertEquals(ProcessingPhase.WAITING, operation.phase)
    }

    @Test fun pendingReviewIsNotAutomaticallyApprovedOnResume() = runTest {
        val fixture = fixture()
        val id = UUID.randomUUID().toString()
        fixture.coordinator.acceptImport(id, "meeting.mp3") { ByteArrayInputStream(byteArrayOf(1, 2, 3)) }
        fixture.store.update("owner", id) { it.copy(awaitingCloudConsent = true, phase = ProcessingPhase.PAUSED) }
        fixture.uploads.enqueued.clear()
        fixture.repository.resumePending()
        assertTrue(fixture.store.get("owner", id)!!.awaitingCloudConsent)
        assertTrue(fixture.uploads.enqueued.isEmpty())
    }

    @Test fun cancellingPendingReviewRemovesPrivateStagingWithoutResumingUpload() = runTest {
        val fixture = fixture()
        val id = UUID.randomUUID().toString()
        fixture.coordinator.acceptImport(id, "meeting.mp3") { ByteArrayInputStream(byteArrayOf(1, 2, 3)) }
        fixture.store.update("owner", id) { it.copy(awaitingCloudConsent = true, phase = ProcessingPhase.PAUSED) }
        fixture.uploads.enqueued.clear()
        fixture.repository.deleteOperation(id)
        fixture.repository.resumePending()
        assertNull(fixture.store.get("owner", id))
        assertFalse(File(processingOwnerDirectory(File(fixture.root, "staging"), "owner"), id).exists())
        assertTrue(fixture.uploads.enqueued.isEmpty())
    }

    private data class Fixture(
        val root: File,
        val store: ProcessingStore,
        val uploads: UploadScheduler,
        val coordinator: AudioPipelineCoordinator,
        val repository: ProcessingRepository,
    )

    private fun fixture(validateDecoded: suspend (File, ProcessingMediaPolicy) -> Unit = { _, _ -> }): Fixture {
        val root = kotlin.io.path.createTempDirectory("audio-pipeline-").toFile()
        val store = ProcessingStore(File(root, "metadata"))
        val uploads = UploadScheduler()
        val repository = ProcessingRepository(store, File(root, "staging"), Api(),
            { ProcessingSession("owner", 7) }, uploads, FormUploader { _, _, _, _ -> Unit })
        val preparer = AudioInputPreparer(File(root, "staging"), validateDecoded = validateDecoded, inspect = {
            AudioInspection(2.0, true, false, "audio/mpeg")
        })
        return Fixture(root, store, uploads,
            AudioPipelineCoordinator(repository, preparer, { ProcessingSession("owner", 7) }), repository)
    }
}
