package com.hatem.musicmute.library

import com.hatem.musicmute.processing.Job
import com.hatem.musicmute.processing.JobInput
import com.hatem.musicmute.processing.ProcessingStore
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class LibraryStoreTest {
    private fun job(id: String, status: String = "ready") = Job(
        id, status, Instant.EPOCH, Instant.EPOCH, JobInput("mp3", 32, 12.0),
        false, status == "ready", displayName = id,
    )

    @Test
    fun legacyHistoryIsRemovedWhileLibraryAndPendingImportsSurvive() = runTest {
        val root = kotlin.io.path.createTempDirectory().toFile()
        val pending = com.hatem.musicmute.processing.UrlImportRecord("owner", "https://youtube.com/watch?v=test", "request")
        val document = com.hatem.musicmute.processing.ProcessingDocument(
            snapshots = listOf(job("ready"), job("running", "processing"), job("failed", "failed")),
            urlImports = listOf(pending),
            library = listOf(StoredLibraryTrack(job("saved"), starred = true)),
        )
        val file = java.io.File(com.hatem.musicmute.processing.processingOwnerDirectory(root, "owner"), "processing.json")
        file.parentFile!!.mkdirs()
        file.writeText(kotlinx.serialization.json.Json.encodeToString(com.hatem.musicmute.processing.ProcessingDocument.serializer(), document))
        val store = ProcessingStore(root, backgroundScope)
        assertEquals(setOf("ready", "saved"), store.library("owner").first().map { it.job.id }.toSet())
        assertEquals(listOf(pending), store.urlImports("owner").first())
        val migrated = kotlinx.serialization.json.Json.decodeFromString(com.hatem.musicmute.processing.ProcessingDocument.serializer(), file.readText())
        assertTrue(migrated.snapshots.isEmpty())
        assertTrue(migrated.library.single { it.job.id == "saved" }.starred)
        store.updateLibraryJobs("owner", listOf(job("new-running", "processing")))
        val updated = kotlinx.serialization.json.Json.decodeFromString(com.hatem.musicmute.processing.ProcessingDocument.serializer(), file.readText())
        assertTrue(updated.snapshots.isEmpty())
        assertEquals(setOf("ready", "saved"), updated.library.map { it.job.id }.toSet())
    }

    @Test
    fun explicitRenameWinsOverAnOlderCachedPageWithTheSameTimestamp() = runTest {
        val store = ProcessingStore(kotlin.io.path.createTempDirectory().toFile(), backgroundScope)
        val original = job("renamed")
        store.updateLibraryJobs("owner", listOf(original))
        store.updateLibraryJob("owner", original.copy(displayName = "Updated title"))
        store.updateLibraryJobs("owner", listOf(original))
        assertEquals("Updated title", store.library("owner").first().single().job.displayName)
    }

    @Test
    fun renamingALibraryTrackPreservesFlagsAndOtherAccounts() = runTest {
        val root = kotlin.io.path.createTempDirectory().toFile()
        val storeJob = SupervisorJob()
        val store = ProcessingStore(root, CoroutineScope(storeJob + Dispatchers.IO))
        val original = job("shared-id")
        store.updateLibraryJobs("owner", listOf(original))
        store.updateLibraryJobs("other", listOf(original))
        store.updateLibraryFlags("owner", original.id, starred = true, hidden = true)

        store.updateLibraryJob("owner", original.copy(displayName = "Renamed audio"))

        val renamed = store.library("owner").first().single()
        assertEquals("Renamed audio", renamed.job.displayName)
        assertTrue(renamed.starred)
        assertTrue(renamed.hidden)
        assertEquals(original, store.library("other").first().single().job)
        storeJob.cancelAndJoin()
        val reopened = ProcessingStore(root, backgroundScope).library("owner").first().single()
        assertEquals(renamed, reopened)
    }

    @Test
    fun twoConcurrentStarTogglesCancelEachOtherWithoutWaitingForUiEmission() = runTest {
        val store = ProcessingStore(kotlin.io.path.createTempDirectory().toFile(), backgroundScope)
        store.updateLibraryJobs("owner", listOf(job("starred")))
        coroutineScope { repeat(2) { launch { store.toggleLibraryStar("owner", "starred") } } }
        assertFalse(store.library("owner").first().single().starred)
    }

    @Test
    fun completedCatalogSurvivesFirstPageRefreshAndKeepsLocalChoices() = runTest {
        val store = ProcessingStore(kotlin.io.path.createTempDirectory().toFile(), backgroundScope)
        store.updateLibraryJobs("owner", listOf(job("old"), job("running", "processing")))
        store.updateLibraryFlags("owner", "old", starred = true, hidden = true)
        store.updateLibraryJobs("owner", listOf(job("new")))
        val entries = store.library("owner").first()
        assertEquals(setOf("old", "new"), entries.map { it.job.id }.toSet())
        assertTrue(entries.single { it.job.id == "old" }.starred)
        assertTrue(entries.single { it.job.id == "old" }.hidden)
        assertTrue(store.library("other").first().isEmpty())
    }

    @Test
    fun confirmedDeletionCannotBeResurrectedByAnOlderSnapshot() = runTest {
        val store = ProcessingStore(kotlin.io.path.createTempDirectory().toFile(), backgroundScope)
        store.updateLibraryJobs("owner", listOf(job("removed")))
        store.removeLibraryJob("owner", "removed")
        store.updateLibraryJobs("owner", listOf(job("removed")))
        assertTrue(store.library("owner").first().isEmpty())
    }

    @Test
    fun catalogAndStarSurviveStoreRecreation() = runTest {
        val root = kotlin.io.path.createTempDirectory().toFile()
        val firstJob = SupervisorJob()
        val store = ProcessingStore(root, CoroutineScope(firstJob + Dispatchers.IO))
        store.updateLibraryJobs("owner", listOf(job("persisted")))
        store.updateLibraryFlags("owner", "persisted", starred = true)
        firstJob.cancelAndJoin()
        val reopened = ProcessingStore(root, backgroundScope)
        assertTrue(reopened.library("owner").first().single().starred)
    }
}
