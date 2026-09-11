package com.hatem.musicmute.download

import androidx.datastore.core.CorruptionException
import androidx.datastore.core.DataStoreFactory
import androidx.work.WorkInfo
import java.io.ByteArrayInputStream
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class DownloadHistoryTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun completedHistorySurvivesClosingAndReopeningTheStore() = runTest {
        val file = File(temporary.root, "history.json")
        val firstScope = CoroutineScope(backgroundScope.coroutineContext + Job())
        val store =
            HistoryStore(DataStoreFactory.create(HistorySerializer, scope = firstScope) { file })
        val record = DownloadRecord("id", "https://youtu.be/dQw4w9WgXcQ", 100L)
        try {
            store.add(record)
            store.update("id") {
                it.copy(
                    status = DownloadStatus.COMPLETE,
                    title = "Original audio",
                    codec = "opus",
                    extension = "webm",
                    relativePath = "id/audio.webm",
                    sizeBytes = 1000,
                    progress = 100,
                )
            }
        } finally {
            firstScope.cancel()
            firstScope.coroutineContext[Job]!!.join()
        }
        val reopened =
            HistoryStore(
                DataStoreFactory.create(HistorySerializer, scope = backgroundScope) { file }
            )
        val saved = reopened.history.first().records.single()
        assertEquals(DownloadStatus.COMPLETE, saved.status)
        assertEquals("Original audio", saved.title)
        assertEquals("id/audio.webm", saved.relativePath)
        assertEquals("opus", saved.codec)
    }

    @Test
    fun updatesPreserveOtherHistoryEntriesAndDoNotDuplicateIds() = runTest {
        val store =
            HistoryStore(
                DataStoreFactory.create(HistorySerializer, scope = backgroundScope) {
                    File(temporary.root, "updates.json")
                }
            )
        store.add(DownloadRecord("first", "one", 1))
        store.add(DownloadRecord("second", "two", 2))
        store.add(DownloadRecord("second", "two", 2, status = DownloadStatus.DOWNLOADING))
        store.update("second") { it.copy(progress = 65) }
        val records = store.history.first().records
        assertEquals(2, records.size)
        assertEquals(65, records.first().progress)
        assertEquals(DownloadStatus.QUEUED, records.last().status)
    }

    @Test
    fun corruptHistoryIsReportedInsteadOfSilentlyDiscarded() = runTest {
        try {
            HistorySerializer.readFrom(ByteArrayInputStream("not json".toByteArray()))
            fail("Corruption must be visible")
        } catch (_: CorruptionException) {
            /* expected */
        }
    }

    @Test
    fun workReconciliationPreservesCompletedAudioAndExposesInterruptedJobs() {
        val record = DownloadRecord("id", "url", 0L, status = DownloadStatus.DOWNLOADING)
        assertEquals(
            DownloadStatus.CANCELLED,
            DownloadRepository.reconcile(record, WorkInfo.State.CANCELLED, 20_000).status,
        )
        assertEquals(
            DownloadStatus.QUEUED,
            DownloadRepository.reconcile(record, WorkInfo.State.ENQUEUED, 20_000).status,
        )
        assertEquals(
            DownloadError.INTERRUPTED,
            DownloadRepository.reconcile(record, null, 20_000).error,
        )
        assertEquals(
            record,
            DownloadRepository.reconcile(record, null, 100)
                .copy(status = DownloadStatus.DOWNLOADING),
        )
        val completed =
            record.copy(status = DownloadStatus.COMPLETE, relativePath = "id/audio.webm")
        assertEquals(
            completed,
            DownloadRepository.reconcile(completed, WorkInfo.State.CANCELLED, 20_000),
        )
    }
}
