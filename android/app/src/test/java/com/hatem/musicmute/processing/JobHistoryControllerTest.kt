package com.hatem.musicmute.processing

import java.time.Instant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class JobHistoryControllerTest {
    private fun job(id: String, status: String = "queued") = Job(
        id, status, Instant.EPOCH, Instant.EPOCH, JobInput("mp3", 10, 2.0), true, false,
    )

    @Test fun refreshDiscardsOlderResponsesAndDeduplicatesPages() = runTest {
        val first = CompletableDeferred<JobPage>()
        var calls = 0
        val api = HistoryTestApi().apply {
            page = { cursor ->
                if (cursor != null) JobPage(listOf(job("b"), job("c")), null)
                else if (calls++ == 0) first.await() else JobPage(listOf(job("b")), "opaque")
            }
        }
        val controller = JobHistoryController(api, this)
        controller.bindOwner("a")
        controller.refresh()
        runCurrent()
        controller.refresh()
        runCurrent()
        first.complete(JobPage(listOf(job("old")), null))
        runCurrent()
        assertEquals(listOf("b"), controller.state.value.jobs.map { it.id })
        controller.loadMore()
        runCurrent()
        assertEquals(listOf("b", "c"), controller.state.value.jobs.map { it.id })
        controller.close()
    }

    @Test fun accountChangeFencesOldResponseEvenAfterReturningToSameUid() = runTest {
        val pending = CompletableDeferred<JobPage>()
        val api = HistoryTestApi().apply { page = { pending.await() } }
        val controller = JobHistoryController(api, this)
        controller.bindOwner("a")
        controller.refresh()
        runCurrent()
        controller.bindOwner(null)
        controller.bindOwner("a")
        pending.complete(JobPage(listOf(job("private")), null))
        runCurrent()
        assertTrue(controller.state.value.jobs.isEmpty())
        controller.close()
    }

    @Test fun transientFailureRetainsHistoryAndWorkerOfflineIsNotFailed() = runTest {
        val api = HistoryTestApi().apply {
            page = { JobPage(listOf(job("a")), null) }
            fetch = { job("a", "interrupted").copy(workerAvailable = false) }
        }
        val controller = JobHistoryController(api, this)
        controller.bindOwner("owner")
        controller.refresh()
        controller.select("a")
        runCurrent()
        assertEquals("interrupted", controller.state.value.detail?.status)
        assertEquals(false, controller.state.value.detail?.workerAvailable)
        api.page = { throw JobsFailure(JobsProblem.OFFLINE) }
        controller.refresh()
        runCurrent()
        assertEquals("a", controller.state.value.jobs.single().id)
        assertEquals(JobsProblem.OFFLINE, controller.state.value.failure)
        controller.close()
    }

    @Test fun visibilityBeforeOwnerBindingStartsAndRestartsPolling() = runTest {
        var calls = 0
        val api = HistoryTestApi().apply {
            page = { calls++; JobPage(listOf(job("queued")), null) }
        }
        val controller = JobHistoryController(api, this)
        controller.setVisible(true)
        controller.bindOwner("owner")
        runCurrent()
        assertEquals(1, calls)
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(2, calls)
        controller.bindOwner(null)
        controller.bindOwner("owner")
        runCurrent()
        assertEquals(3, calls)
        controller.close()
        advanceTimeBy(20_000)
        runCurrent()
        assertEquals(3, calls)
    }

    @Test fun unknownAndTerminalStatusesDoNotPoll() {
        assertFalse(shouldPollProcessingJob("new-server-state"))
        assertFalse(shouldPollProcessingJob("ready"))
        assertFalse(shouldPollProcessingJob("failed"))
        assertTrue(shouldPollProcessingJob("cancel_requested"))
        assertTrue(shouldPollProcessingJob("interrupted"))
    }

    @Test fun confirmedMissingDetailEvictsTheExactCachedJob() = runTest {
        val saved = mutableListOf<List<String>>()
        val api = HistoryTestApi().apply {
            page = { JobPage(listOf(job("a", "ready"), job("b", "ready")), null) }
            fetch = { throw JobsFailure(JobsProblem.JOB_NOT_FOUND) }
        }
        val controller = JobHistoryController(api, this,
            saveCached = { _, jobs -> saved += jobs.map { it.id } })
        controller.bindOwner("owner")
        controller.refresh()
        runCurrent()
        controller.select("a")
        runCurrent()
        assertEquals(listOf("b"), controller.state.value.jobs.map { it.id })
        assertEquals(listOf("b"), saved.last())
        controller.close()
    }
}

private class HistoryTestApi : JobsApi {
    var page: suspend (String?) -> JobPage = { JobPage(emptyList()) }
    var fetch: suspend (String) -> Job = { error("Unexpected detail") }
    override suspend fun list(cursor: String?, status: String?) = page(cursor)
    override suspend fun detail(id: String) = fetch(id)
    override suspend fun create(requestId: String, input: InputDeclaration): CreateReservation = error("Unexpected create")
    override suspend fun renewUpload(id: String): UploadGrant = error("Unexpected upload")
    override suspend fun confirmUpload(id: String): JobMutation = error("Unexpected confirm")
    override suspend fun cancel(id: String): JobMutation = error("Unexpected cancel")
    override suspend fun retry(id: String, requestId: String): JobMutation = error("Unexpected retry")
    override suspend fun download(id: String, artifact: String): DownloadGrant = error("Unexpected download")
}
