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
    fun explicitRenameWinsOverAnOlderCachedPageWithTheSameTimestamp() = runTest {
        val store = ProcessingStore(kotlin.io.path.createTempDirectory().toFile(), backgroundScope)
        val original = job("renamed")
        store.saveSnapshots("owner", listOf(original))
        store.updateLibraryJob("owner", original.copy(displayName = "Updated title"))
        store.saveSnapshots("owner", listOf(original))
        assertEquals("Updated title", store.library("owner").first().single().job.displayName)
    }

    @Test
    fun twoConcurrentStarTogglesCancelEachOtherWithoutWaitingForUiEmission() = runTest {
        val store = ProcessingStore(kotlin.io.path.createTempDirectory().toFile(), backgroundScope)
        store.saveSnapshots("owner", listOf(job("starred")))
        coroutineScope { repeat(2) { launch { store.toggleLibraryStar("owner", "starred") } } }
        assertFalse(store.library("owner").first().single().starred)
    }

    @Test
    fun completedCatalogSurvivesFirstPageRefreshAndKeepsLocalChoices() = runTest {
        val store = ProcessingStore(kotlin.io.path.createTempDirectory().toFile(), backgroundScope)
        store.saveSnapshots("owner", listOf(job("old"), job("running", "processing")))
        store.updateLibraryFlags("owner", "old", starred = true, hidden = true)
        store.saveSnapshots("owner", listOf(job("new")))
        val entries = store.library("owner").first()
        assertEquals(setOf("old", "new"), entries.map { it.job.id }.toSet())
        assertTrue(entries.single { it.job.id == "old" }.starred)
        assertTrue(entries.single { it.job.id == "old" }.hidden)
        assertTrue(store.library("other").first().isEmpty())
    }

    @Test
    fun confirmedDeletionCannotBeResurrectedByAnOlderSnapshot() = runTest {
        val store = ProcessingStore(kotlin.io.path.createTempDirectory().toFile(), backgroundScope)
        store.saveSnapshots("owner", listOf(job("removed")))
        store.removeLibraryJob("owner", "removed")
        store.saveSnapshots("owner", listOf(job("removed")))
        assertTrue(store.library("owner").first().isEmpty())
    }

    @Test
    fun catalogAndStarSurviveStoreRecreation() = runTest {
        val root = kotlin.io.path.createTempDirectory().toFile()
        val firstJob = SupervisorJob()
        val store = ProcessingStore(root, CoroutineScope(firstJob + Dispatchers.IO))
        store.saveSnapshots("owner", listOf(job("persisted")))
        store.updateLibraryFlags("owner", "persisted", starred = true)
        firstJob.cancelAndJoin()
        val reopened = ProcessingStore(root, backgroundScope)
        assertTrue(reopened.library("owner").first().single().starred)
    }
}
