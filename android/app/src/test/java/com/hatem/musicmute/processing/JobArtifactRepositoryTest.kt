package com.hatem.musicmute.processing

import java.io.File
import java.io.IOException
import java.time.Instant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class JobArtifactRepositoryTest {
    @get:Rule val temporary = TemporaryFolder()
    private val id = "68c000000000000000000001"
    private val now = Instant.parse("2026-09-10T00:00:00Z")
    private val mp3 = "valid-mp3-bytes".toByteArray()
    private var session: ProcessingSession? = ProcessingSession("owner", 1)

    @Test fun constructionNeverFetchesReadyJobsAndPlayCallsCoalesce() = runTest {
        val api = FakeApi()
        val gate = CompletableDeferred<Unit>()
        var transfers = 0
        val repository = repository(api, ArtifactDownloader { _, file, progress ->
            transfers++
            progress(1, mp3.size.toLong())
            gate.await()
            file.writeBytes(mp3)
        }, backgroundScope)
        assertEquals(0, api.grants)
        val first = async { repository.ensureOutput(id) }
        val second = async { repository.ensureOutput(id) }
        runCurrent()
        assertEquals(1, transfers)
        assertEquals(1L, repository.progress.value[id]?.bytes)
        gate.complete(Unit)
        val file = first.await()
        assertEquals(file, second.await())
        assertArrayEquals(mp3, file.readBytes())
        assertEquals(file, repository.ensureOutput(id))
        assertEquals(1, transfers)
        assertEquals(1, api.grants)
        assertTrue(repository.progress.value.isEmpty())
    }

    @Test fun corruptCacheIsReplacedOnlyAfterValidNewDownload() = runTest {
        val api = FakeApi()
        var bytes = mp3
        val repository = repository(api, ArtifactDownloader { _, file, _ -> file.writeBytes(bytes) }, backgroundScope)
        val cached = repository.ensureOutput(id)
        cached.writeText("corrupt")
        bytes = "<html>expired</html>".toByteArray()
        try { repository.ensureOutput(id); fail("Invalid output accepted") }
        catch (error: ArtifactException) { assertEquals(ArtifactProblem.INVALID_OUTPUT, error.problem) }
        assertEquals("corrupt", cached.readText())
        bytes = mp3
        assertArrayEquals(mp3, repository.ensureOutput(id).readBytes())
        assertFalse(temporary.root.walkTopDown().any { it.extension == "partial" })
    }

    @Test fun emptyAndNonMp3BodiesNeverBecomeCache() = runTest {
        for (body in listOf(byteArrayOf(), "<html>error</html>".toByteArray(), "m4a".toByteArray())) {
            val repository = repository(FakeApi(), ArtifactDownloader { _, file, _ -> file.writeBytes(body) }, backgroundScope)
            try { repository.ensureOutput(id); fail("Invalid output accepted") }
            catch (error: ArtifactException) { assertEquals(ArtifactProblem.INVALID_OUTPUT, error.problem) }
        }
        assertFalse(temporary.root.walkTopDown().any { it.isFile })
    }

    @Test fun interruptedTransferRemovesOnlyItsPartialAndCanRetry() = runTest {
        var fail = true
        val repository = repository(FakeApi(), ArtifactDownloader { _, file, _ ->
            file.writeBytes(mp3)
            if (fail) throw IOException("private URL must not escape")
        }, backgroundScope)
        try { repository.ensureOutput(id); fail("Expected transfer failure") }
        catch (error: ArtifactException) { assertEquals(ArtifactProblem.TRANSFER, error.problem) }
        assertFalse(temporary.root.walkTopDown().any { it.isFile })
        fail = false
        assertArrayEquals(mp3, repository.ensureOutput(id).readBytes())
    }

    @Test fun expiredGrantRenewsOnceAfterAuthenticatedReadyRefresh() = runTest {
        val api = FakeApi().apply { grant = DownloadGrant("https://storage.invalid/expired", now.minusSeconds(1)) }
        var downloads = 0
        val repository = repository(api, ArtifactDownloader { _, file, _ -> downloads++; file.writeBytes(mp3) }, backgroundScope)
        api.onGrant = { count -> if (count > 1) DownloadGrant("https://storage.invalid/new", now.plusSeconds(60)) else api.grant }
        assertArrayEquals(mp3, repository.ensureOutput(id).readBytes())
        assertEquals(2, api.grants)
        assertEquals(2, api.details)
        assertEquals(1, downloads)
    }

    @Test fun repeatedExpiredGrantAndUnexpiredForbiddenDoNotLoop() = runTest {
        val api = FakeApi().apply { grant = DownloadGrant("https://storage.invalid/expired", now.minusSeconds(1)) }
        val repository = repository(api, ArtifactDownloader { _, _, _ -> fail("Expired URL fetched") }, backgroundScope)
        try { repository.ensureOutput(id); fail("Expected expiry") }
        catch (error: ArtifactException) { assertEquals(ArtifactProblem.EXPIRED_GRANT, error.problem) }
        assertEquals(2, api.grants)
        val deniedApi = FakeApi()
        val denied = repository(deniedApi, ArtifactDownloader { _, _, _ -> throw ArtifactHttpException(403) }, backgroundScope)
        try { denied.ensureOutput(id); fail("Expected denial") }
        catch (error: ArtifactException) { assertEquals(ArtifactProblem.TRANSFER, error.problem) }
        assertEquals(1, deniedApi.grants)
    }

    @Test fun deletionCancelsInFlightDownloadAndLateBytesCannotRepopulateCache() = runTest {
        val gate = CompletableDeferred<Unit>()
        val started = CompletableDeferred<Unit>()
        val repository = repository(FakeApi(), ArtifactDownloader { _, file, _ ->
            started.complete(Unit)
            try { gate.await() } finally { file.writeBytes(mp3) }
        }, backgroundScope)
        val pending = async { repository.ensureOutput(id) }
        started.await()
        repository.evict(id)
        gate.complete(Unit)
        runCurrent()
        assertTrue(runCatching { pending.await() }.exceptionOrNull() is kotlinx.coroutines.CancellationException)
        assertFalse(temporary.root.walkTopDown().any { it.isFile })
        assertTrue(runCatching { repository.ensureOutput(id) }.exceptionOrNull() is ArtifactException)
    }

    @Test fun accountSwitchCancelsOldDownloadAndFencesLateCompletion() = runTest {
        val api = FakeApi()
        val started = CompletableDeferred<Unit>()
        val hold = CompletableDeferred<Unit>()
        val repository = repository(api, ArtifactDownloader { _, file, progress ->
            started.complete(Unit)
            kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) {
                hold.await()
                file.writeBytes(mp3)
                progress(mp3.size.toLong(), mp3.size.toLong())
            }
        }, backgroundScope)
        val pending = async { repository.ensureOutput(id) }
        started.await()
        session = ProcessingSession("other", 2)
        repository.onSessionChanged()
        hold.complete(Unit)
        runCurrent()
        try { pending.await(); fail("Old session output escaped") }
        catch (_: kotlinx.coroutines.CancellationException) { }
        assertTrue(repository.progress.value.isEmpty())
        assertFalse(temporary.root.walkTopDown().any { it.isFile })
    }

    @Test fun purgingAnOldOwnerWaitsForItsWriterAndPreservesCurrentOwnerDownloads() = runTest {
        val oldGate = CompletableDeferred<Unit>()
        val newGate = CompletableDeferred<Unit>()
        var transfers = 0
        val repository = repository(FakeApi(), ArtifactDownloader { _, file, _ ->
            if (++transfers == 1) kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) {
                oldGate.await()
                file.writeBytes(mp3)
            } else {
                newGate.await()
                file.writeBytes(mp3)
            }
        }, backgroundScope)
        val oldDownload = async { repository.ensureOutput(id) }
        runCurrent()
        session = ProcessingSession("other", 2)
        repository.onSessionChanged()
        val newDownload = async { repository.ensureOutput(id) }
        runCurrent()
        val purge = async { repository.purgeOwner("owner") }
        runCurrent()
        assertFalse(purge.isCompleted)
        newGate.complete(Unit)
        val preserved = newDownload.await()
        assertTrue(preserved.isFile)
        oldGate.complete(Unit)
        purge.await()
        assertTrue(runCatching { oldDownload.await() }.exceptionOrNull() is kotlinx.coroutines.CancellationException)
        assertFalse(processingOwnerDirectory(temporary.root, "owner").exists())
        assertArrayEquals(mp3, preserved.readBytes())
    }

    @Test fun ownersUseDifferentConfinedPathsAndKeepPriorCache() = runTest {
        val repository = repository(FakeApi(), ArtifactDownloader { _, file, _ -> file.writeBytes(mp3) }, backgroundScope)
        session = ProcessingSession("../owner", 1)
        val first = repository.ensureOutput(id)
        session = ProcessingSession("other", 2)
        repository.onSessionChanged()
        val second = repository.ensureOutput(id)
        assertNotEquals(first, second)
        assertTrue(first.isFile)
        assertTrue(second.canonicalPath.startsWith(temporary.root.canonicalPath + File.separator))
        assertFalse(first.path.contains("../"))
    }

    @Test fun nonReadyJobNeverRequestsGrant() = runTest {
        val api = FakeApi().apply { status = "processing" }
        val repository = repository(api, ArtifactDownloader { _, _, _ -> fail("Unexpected download") }, backgroundScope)
        try { repository.ensureOutput(id); fail("Expected not ready") }
        catch (error: ArtifactException) { assertEquals(ArtifactProblem.NOT_READY, error.problem) }
        assertEquals(0, api.grants)
    }

    private fun repository(api: FakeApi, downloader: ArtifactDownloader, scope: kotlinx.coroutines.CoroutineScope) =
        JobArtifactRepository(temporary.root, api, { session }, downloader,
            isPlayableMp3 = { it.isFile && it.readBytes().contentEquals(mp3) }, scope = scope, now = { now })

    private inner class FakeApi : JobsApi {
        var grants = 0
        var details = 0
        var status = "ready"
        var grant = DownloadGrant("https://storage.invalid/output", now.plusSeconds(60))
        var onGrant: ((Int) -> DownloadGrant)? = null
        override suspend fun detail(id: String): Job {
            details++
            return Job(id, status, now, now, JobInput("mp3", 1, 1.0), true, status == "ready", workerAvailable = true)
        }
        override suspend fun download(id: String, artifact: String): DownloadGrant {
            assertEquals("output", artifact)
            grants++
            return onGrant?.invoke(grants) ?: grant
        }
        override suspend fun create(requestId: String, input: InputDeclaration): CreateReservation = error("unused")
        override suspend fun renewUpload(id: String): UploadGrant = error("unused")
        override suspend fun confirmUpload(id: String): JobMutation = error("unused")
        override suspend fun list(cursor: String?, status: String?): JobPage = error("unused")
        override suspend fun cancel(id: String): JobMutation = error("unused")
        override suspend fun retry(id: String, requestId: String): JobMutation = error("unused")
    }
}
