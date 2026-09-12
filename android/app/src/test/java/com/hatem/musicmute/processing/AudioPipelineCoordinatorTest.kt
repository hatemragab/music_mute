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
    private class Sources : PipelineSourceScheduler {
        val enqueued = mutableListOf<Triple<String, String, String>>()
        val cancelled = mutableListOf<String>()
        val paused = mutableListOf<String>()
        var fail = false
        override suspend fun enqueue(ownerUid: String, operationId: String, url: String, epoch: Long) {
            if (fail) throw java.io.IOException("lost enqueue")
            enqueued += Triple(ownerUid, operationId, url)
        }
        override suspend fun cancel(ownerUid: String, operationId: String) { cancelled += operationId }
        override suspend fun pause(ownerUid: String, operationId: String) { paused += operationId }
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

    @Test fun callbackIdentityDeduplicatesButASecondSubmissionCreatesIndependentWork() = runTest {
        val fixture = fixture()
        val firstId = UUID.randomUUID().toString()
        val secondId = UUID.randomUUID().toString()
        val first = fixture.coordinator.acceptUrl(firstId, "https://youtu.be/abc12345678")
        val duplicate = fixture.coordinator.acceptUrl(firstId, "https://youtu.be/abc12345678")
        val second = fixture.coordinator.acceptUrl(secondId, "https://youtu.be/abc12345678")
        assertEquals(first, duplicate)
        assertNotEquals(first.operationId, second.operationId)
        assertEquals(2, fixture.sources.enqueued.size)
        assertEquals(first.operationId, first.requestId)
        assertEquals(SourceKind.URL, first.sourceKind)
        assertEquals("https://www.youtube.com/watch?v=abc12345678", first.sourceUrl)
        assertEquals(
            "https://www.youtube.com/watch?v=abc12345678",
            fixture.sources.enqueued.first().third,
        )
        assertEquals(ProcessingPhase.DOWNLOADING_SOURCE, first.phase)
    }

    @Test fun invalidUrlDoesNotPersistAndImportWaitsForExplicitCloudConsent() = runTest {
        val fixture = fixture()
        val invalidId = UUID.randomUUID().toString()
        assertTrue(runCatching { fixture.coordinator.acceptUrl(invalidId, "https://example.com/nope") }.isFailure)
        assertNull(fixture.store.get("owner", invalidId))
        assertTrue(fixture.sources.enqueued.isEmpty())

        val importId = UUID.randomUUID().toString()
        val operation = fixture.coordinator.acceptImport(importId, "meeting.mp3") {
            ByteArrayInputStream(byteArrayOf(1, 2, 3))
        }
        assertEquals("meeting", operation.displayName)
        assertEquals("meeting", operation.sourceTitle)
        assertEquals(SourceKind.FILE, operation.sourceKind)
        assertEquals(ProcessingPhase.PAUSED, fixture.store.get("owner", importId)!!.phase)
        assertTrue(fixture.uploads.enqueued.isEmpty())
    }

    @Test fun longImportNameKeepsSupportedExtensionAfterTitleBounding() = runTest {
        val fixture = fixture()
        val id = UUID.randomUUID().toString()
        val operation = fixture.coordinator.acceptImport(id, "صصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصصص.mp3") {
            ByteArrayInputStream(byteArrayOf(1, 2, 3))
        }
        assertEquals("mp3", operation.input?.extension)
        assertEquals(200, operation.sourceTitle.codePointCount(0, operation.sourceTitle.length))
        assertEquals(ProcessingPhase.PAUSED, operation.phase)
    }

    @Test fun completedUrlKeepsExtractedTitleAndHandsSameDurableOperationToUpload() = runTest {
        val fixture = fixture()
        val id = UUID.randomUUID().toString()
        fixture.coordinator.acceptUrl(id, "https://www.youtube.com/watch?v=abc12345678")
        val downloaded = File(fixture.root, "download.mp3").apply { writeBytes(byteArrayOf(4, 5, 6)) }
        val operation = fixture.coordinator.completeUrlDownload("owner", id, 7, "Original title", downloaded)
        assertEquals(id, operation.operationId)
        assertEquals("Original title", operation.sourceTitle)
        assertEquals("Original title", operation.displayName)
        assertTrue(fixture.uploads.enqueued.isEmpty())
    }

    @Test fun lostSourceEnqueueIsPersistedAndRecoveredWithoutASecondIntent() = runTest {
        val fixture = fixture()
        val id = UUID.randomUUID().toString()
        fixture.sources.fail = true
        assertTrue(runCatching {
            fixture.coordinator.acceptUrl(id, "https://youtu.be/abc12345678")
        }.isFailure)
        assertEquals(ProcessingPhase.SOURCE_QUEUED, fixture.store.get("owner", id)!!.phase)
        fixture.sources.fail = false
        fixture.coordinator.resumePendingSources()
        assertEquals(listOf(id), fixture.sources.enqueued.map { it.second })
        assertEquals(id, fixture.store.get("owner", id)!!.requestId)
    }

    @Test fun retryBeforePreparationReschedulesSourceInsteadOfUpload() = runTest {
        val fixture = fixture()
        val id = UUID.randomUUID().toString()
        fixture.coordinator.acceptUrl(id, "https://youtu.be/abc12345678")
        fixture.store.update("owner", id) {
            it.copy(
                phase = ProcessingPhase.PAUSED,
                localProblem = ProcessingLocalProblem.RETRY_EXHAUSTED,
                transientRetryCount = 3,
            )
        }
        fixture.sources.enqueued.clear()
        fixture.coordinator.retry(id)
        val retried = fixture.store.get("owner", id)!!
        assertEquals(ProcessingPhase.SOURCE_QUEUED, retried.phase)
        assertEquals(0, retried.transientRetryCount)
        assertEquals(listOf(id), fixture.sources.enqueued.map { it.second })
        assertTrue(fixture.uploads.enqueued.isEmpty())
    }

    @Test fun appUpdatePauseRetainsUrlIntentAndDoesNotTurnItIntoUserCancellation() = runTest {
        val fixture = fixture()
        val id = UUID.randomUUID().toString()
        fixture.coordinator.acceptUrl(id, "https://youtu.be/abc12345678")

        fixture.coordinator.pauseForUpdate()

        val retained = fixture.store.get("owner", id)!!
        assertEquals(listOf(id), fixture.sources.paused)
        assertEquals(ProcessingPhase.SOURCE_QUEUED, retained.phase)
        assertEquals(JobsProblem.APP_UPDATE_REQUIRED, retained.problem)
        assertFalse(retained.cancellationRequested)
        assertEquals("https://www.youtube.com/watch?v=abc12345678", retained.sourceUrl)
    }

    @Test fun reviewSurvivesResumeAndWorkerUntilExplicitRightsConfirmation() = runTest {
        val fixture = fixture()
        val id = UUID.randomUUID().toString()
        fixture.coordinator.acceptImport(id, "meeting.mp3") { ByteArrayInputStream(byteArrayOf(1, 2, 3)) }
        fixture.repository.resumePending()
        fixture.repository.resume(id)
        assertEquals(ProcessingRunResult.PAUSED, fixture.repository.runUpload("owner", id, 7))
        assertTrue(fixture.uploads.enqueued.isEmpty())
        assertTrue(runCatching { fixture.repository.confirmCloudProcessing(id, false) }.isFailure)
        assertTrue(fixture.store.get("owner", id)!!.awaitingCloudConsent)
        assertEquals(AudioTaskStage.REVIEW, audioTaskPresentations(listOf(fixture.store.get("owner", id)!!), emptyList(), 0).single().stage)
        fixture.repository.confirmCloudProcessing(id, true)
        assertFalse(fixture.store.get("owner", id)!!.awaitingCloudConsent)
        assertEquals(listOf(id), fixture.uploads.enqueued)
    }

    @Test fun cancellingReviewRemovesPrivateStagingWithoutCreatingACloudJob() = runTest {
        val fixture = fixture()
        val id = UUID.randomUUID().toString()
        fixture.coordinator.acceptImport(id, "meeting.mp3") { ByteArrayInputStream(byteArrayOf(1, 2, 3)) }
        fixture.repository.deleteOperation(id)
        assertNull(fixture.store.get("owner", id))
        assertFalse(File(processingOwnerDirectory(File(fixture.root, "staging"), "owner"), id).exists())
        assertTrue(fixture.uploads.enqueued.isEmpty())
    }

    private data class Fixture(
        val root: File,
        val store: ProcessingStore,
        val uploads: UploadScheduler,
        val sources: Sources,
        val coordinator: AudioPipelineCoordinator,
        val repository: ProcessingRepository,
    )

    private fun fixture(): Fixture {
        val root = kotlin.io.path.createTempDirectory("audio-pipeline-").toFile()
        val store = ProcessingStore(File(root, "metadata"))
        val uploads = UploadScheduler()
        val repository = ProcessingRepository(store, File(root, "staging"), Api(),
            { ProcessingSession("owner", 7) }, uploads, FormUploader { _, _, _, _ -> Unit })
        val preparer = AudioInputPreparer(File(root, "staging"), inspect = {
            AudioInspection(2.0, true, false, "audio/mpeg")
        })
        val sources = Sources()
        return Fixture(root, store, uploads, sources,
            AudioPipelineCoordinator(repository, preparer, { ProcessingSession("owner", 7) }, sources), repository)
    }
}
