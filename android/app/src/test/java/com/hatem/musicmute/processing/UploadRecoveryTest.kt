package com.hatem.musicmute.processing

import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class UploadRecoveryTest {
    private class Scheduler : ProcessingScheduler {
        val scheduled = mutableListOf<Triple<String,String,Long>>()
        override suspend fun enqueue(ownerUid: String, operationId: String, epoch: Long) { scheduled += Triple(ownerUid,operationId,epoch) }
        override suspend fun cancel(ownerUid: String, operationId: String) = Unit
        override suspend fun cancelOwner(ownerUid: String) = Unit
    }
    private class Api : JobsApi {
        val id = "68c000000000000000000001"
        val requests = mutableListOf<String>()
        var created: suspend () -> Unit = {}
        var exists = false
        var status = "awaiting_upload"
        var confirms = 0
        var renewals = 0
        var during: (String) -> Unit = {}
        var retried: suspend () -> Unit = {}
        val retryRequests = mutableListOf<String>()
        private val grant = UploadGrant(
            UploadMethod.PUT,
            "https://storage.example/",
            mapOf(
                "Content-Type" to "audio/mpeg",
                "x-amz-checksum-sha256" to "fixture",
                "If-None-Match" to "*",
            ),
            Instant.parse("2026-09-10T12:00:00Z"),
        )
        override suspend fun create(requestId: String, input: InputDeclaration): CreateReservation { requests += requestId; created(); during("create"); return CreateReservation(id,status,if(status == "awaiting_upload") grant else null) }
        override suspend fun renewUpload(id: String): UploadGrant { renewals++; during("renew"); return grant }
        override suspend fun confirmUpload(id: String): JobMutation { confirms++; during("confirm"); if (!exists) throw JobsFailure(JobsProblem.UPLOAD_NOT_READY); status = "queued"; return JobMutation(id,status) }
        override suspend fun detail(id: String): Job { during("detail"); return Job(id,status,Instant.EPOCH,Instant.EPOCH,JobInput("mp3",3,1.0),exists,false,workerAvailable=false) }
        override suspend fun list(cursor: String?, status: String?) = JobPage(emptyList())
        override suspend fun cancel(id: String): JobMutation { status="cancelled"; return JobMutation(id,status) }
        override suspend fun retry(id: String, requestId: String): JobMutation { retryRequests += requestId; retried(); return JobMutation(this.id,"queued",id) }
        override suspend fun download(id: String, artifact: String): DownloadGrant = error("unused")
    }
    private fun prepared(root: File): PreparedInput {
        val op = UUID.randomUUID().toString()
        val file = File(processingOwnerDirectory(root,"owner"), "$op/input.mp3")
        requireNotNull(file.parentFile).mkdirs(); file.writeBytes(byteArrayOf(1,2,3))
        val hash = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(file.readBytes()))
        return PreparedInput(op,"owner",file,InputDeclaration("mp3","audio/mpeg",3,1.0,hash),"clip.mp3")
    }

    @Test fun intentIsDurableBeforeNetworkingAndLostCreateReusesId() = runTest {
        val root = kotlin.io.path.createTempDirectory("upload-recovery-").toFile()
        val store = ProcessingStore(root, backgroundScope)
        val api = Api(); val scheduler = Scheduler()
        val repository = ProcessingRepository(store,root,api,{ ProcessingSession("owner",1) },scheduler,
            FormUploader { _,_,_,progress -> api.exists=true; progress(3,3) })
        val input = prepared(root)
        val first = repository.submit(input)
        assertEquals(first.operationId,repository.submit(input).operationId)
        assertEquals(1,scheduler.scheduled.size)
        api.created = { assertEquals(first.requestId,store.get("owner",first.operationId)!!.requestId); if(api.requests.size == 1) throw JobsFailure(JobsProblem.OFFLINE) }
        assertEquals(ProcessingRunResult.RETRY,repository.runUpload("owner",first.operationId,1))
        assertEquals(ProcessingRunResult.COMPLETE,repository.runUpload("owner",first.operationId,1))
        assertEquals(2,api.requests.size); assertEquals(api.requests[0],api.requests[1])
        assertEquals("queued",store.get("owner",first.operationId)!!.serverStatus)
    }

    @Test fun lostStorageResponseConfirmsBeforeRenewalOrReupload() = runTest {
        val root = kotlin.io.path.createTempDirectory("upload-uncertain-").toFile()
        val store = ProcessingStore(root,backgroundScope); val api = Api(); var uploads=0
        val repository = ProcessingRepository(store,root,api,{ ProcessingSession("owner",1) },Scheduler(),
            FormUploader { _,_,_,_ -> uploads++; api.exists=true; throw IOException("lost response") })
        val operation = repository.submit(prepared(root))
        assertEquals(ProcessingRunResult.RETRY,repository.runUpload("owner",operation.operationId,1))
        assertEquals(ProcessingRunResult.COMPLETE,repository.runUpload("owner",operation.operationId,1))
        assertEquals(1,uploads)
        assertEquals(0,api.renewals)
        assertEquals("queued",store.get("owner",operation.operationId)!!.serverStatus)
    }

    @Test fun sameUidNewSessionFencesLateCreateAndRetainsIntent() = runTest {
        val root=kotlin.io.path.createTempDirectory("upload-fence-").toFile(); val store=ProcessingStore(root,backgroundScope)
        val api=Api(); var session=ProcessingSession("owner",1)
        val repository=ProcessingRepository(store,root,api,{session},Scheduler(), FormUploader { _,_,_,_ -> error("must not upload") })
        val op=repository.submit(prepared(root))
        api.created={session=ProcessingSession("owner",2)}
        assertTrue(runCatching { repository.runUpload("owner",op.operationId,1) }.exceptionOrNull() is CancellationException)
        assertNull(store.get("owner",op.operationId)!!.jobId)
        assertEquals(op.requestId,store.get("owner",op.operationId)!!.requestId)
    }

    @Test fun changedStagedBytesNeverReachNetworkAndExhaustionOffersResume() = runTest {
        val root=kotlin.io.path.createTempDirectory("upload-mutation-").toFile(); val store=ProcessingStore(root,backgroundScope)
        val api=Api(); val repository=ProcessingRepository(store,root,api,{ProcessingSession("owner",1)},Scheduler(),FormUploader { _,_,_,_ -> error("must not upload") })
        val input=prepared(root); val operation=repository.submit(input)
        input.file.writeBytes(byteArrayOf(3,2,1))
        assertEquals(ProcessingRunResult.PAUSED,repository.runUpload("owner",operation.operationId,1))
        assertTrue(api.requests.isEmpty())
        assertEquals(ProcessingLocalProblem.INPUT_CHANGED,store.get("owner",operation.operationId)!!.localProblem)
    }
    @Test fun expiredUploadGrantRenewsOnlyAfterUncertainConfirmation() = runTest {
        val root=kotlin.io.path.createTempDirectory("upload-expired-").toFile(); val store=ProcessingStore(root,backgroundScope)
        val api=Api(); var uploads=0
        val repository=ProcessingRepository(store,root,api,{ProcessingSession("owner",1)},Scheduler(),FormUploader { _,_,_,_ ->
            uploads++
            if (uploads == 1) throw IOException("expired grant")
            api.exists=true
        })
        val op=repository.submit(prepared(root))
        assertEquals(ProcessingRunResult.RETRY,repository.runUpload("owner",op.operationId,1))
        assertEquals(ProcessingRunResult.COMPLETE,repository.runUpload("owner",op.operationId,1))
        assertEquals(2,uploads)
        assertEquals(1,api.renewals)
        assertEquals(3,api.confirms)
    }

    @Test fun cancellationResolvesLostCreateBeforeServerCancel() = runTest {
        val root=kotlin.io.path.createTempDirectory("upload-cancel-").toFile(); val store=ProcessingStore(root,backgroundScope)
        val api=Api()
        val repository=ProcessingRepository(store,root,api,{ProcessingSession("owner",1)},Scheduler(),FormUploader { _,_,_,_ -> error("must not upload") })
        val op=repository.submit(prepared(root))
        api.created={if (api.requests.size == 1) throw JobsFailure(JobsProblem.OFFLINE)}
        assertEquals(ProcessingRunResult.RETRY,repository.runUpload("owner",op.operationId,1))
        repository.cancelOperation(op.operationId)
        val result=store.get("owner",op.operationId)!!
        assertEquals("cancelled",result.serverStatus)
        assertEquals(2,api.requests.size)
        assertEquals(api.requests[0],api.requests[1])
        assertTrue(result.cancellationRequested)
        assertEquals(ProcessingPhase.COMPLETE,result.phase)
    }

    @Test fun offlineDoesNotConsumeRetryBudgetAndResumePreservesIntent() = runTest {
        val root=kotlin.io.path.createTempDirectory("upload-budget-").toFile(); val store=ProcessingStore(root,backgroundScope)
        val api=Api(); val scheduler=Scheduler()
        val repository=ProcessingRepository(store,root,api,{ProcessingSession("owner",1)},scheduler,FormUploader { _,_,_,_ -> error("unused") })
        val op=repository.submit(prepared(root))
        api.created={throw JobsFailure(JobsProblem.OFFLINE)}
        assertEquals(ProcessingRunResult.RETRY,repository.runUpload("owner",op.operationId,1,ProcessingRepository.MAX_ATTEMPTS-1))
        assertNull(store.get("owner",op.operationId)!!.localProblem)
        assertEquals(0,store.get("owner",op.operationId)!!.transientRetryCount)
        repository.resumePending()
        assertEquals(2,scheduler.scheduled.size)
        repository.resume(op.operationId)
        assertEquals(3,scheduler.scheduled.size)
        assertEquals(op.requestId,store.get("owner",op.operationId)!!.requestId)
    }

    @Test fun lowDiskPreventsReservationAndAccountSwitchDuringUploadCannotConfirm() = runTest {
        val root=kotlin.io.path.createTempDirectory("upload-disk-").toFile(); val store=ProcessingStore(root,backgroundScope)
        val api=Api(); var owner=ProcessingSession("owner",1); var free=0L
        val repository=ProcessingRepository(store,root,api,{owner},Scheduler(),FormUploader { _,_,_,_ -> owner=ProcessingSession("other",2) },availableSpace={free})
        val input=prepared(root)
        assertEquals(ProcessingLocalProblem.STORAGE,(runCatching { repository.submit(input) }.exceptionOrNull() as ProcessingTransferException).problem)
        assertTrue(api.requests.isEmpty())
        free=10_000_000
        val op=repository.submit(input)
        assertTrue(runCatching { repository.runUpload("owner",op.operationId,1) }.exceptionOrNull() is CancellationException)
        assertEquals(1,api.confirms)
        assertEquals("awaiting_upload",store.get("owner",op.operationId)!!.serverStatus)
    }

    @Test fun eachApiAwaitFencesSwitchedSessions() = runTest {
        for (stage in listOf("create", "confirm", "detail", "renew")) {
            val root=kotlin.io.path.createTempDirectory("upload-await-$stage-").toFile(); val store=ProcessingStore(root,backgroundScope)
            val api=Api(); var owner=ProcessingSession("owner",1)
            val repository=ProcessingRepository(store,root,api,{owner},Scheduler(),FormUploader { _,_,_,_ -> throw IOException("uncertain transfer") })
            val op=repository.submit(prepared(root))
            if (stage in listOf("detail", "renew")) assertEquals(ProcessingRunResult.RETRY,repository.runUpload("owner",op.operationId,1))
            api.during={ if(it == stage) owner=ProcessingSession("owner",2) }
            assertTrue("Stage $stage must fence",runCatching { repository.runUpload("owner",op.operationId,1) }.exceptionOrNull() is CancellationException)
            assertNotEquals("queued",store.get("owner",op.operationId)!!.serverStatus)
        }
    }

    @Test fun retryResponseLossReusesDurableIntentAndNewInputRequiredDoesNotLoop() = runTest {
        val root=kotlin.io.path.createTempDirectory("upload-retry-").toFile(); val store=ProcessingStore(root,backgroundScope)
        val api=Api().apply { status="failed" }
        val repository=ProcessingRepository(store,root,api,{ProcessingSession("owner",1)},Scheduler(),FormUploader { _,_,_,_ -> error("retry does not upload") })
        val source="68c000000000000000000002"
        val first=repository.retry(source)
        assertEquals(first.operationId,repository.retry(source).operationId)
        api.retried={if(api.retryRequests.size == 1) throw JobsFailure(JobsProblem.OFFLINE)}
        assertEquals(ProcessingRunResult.RETRY,repository.runUpload("owner",first.operationId,1))
        assertEquals(ProcessingRunResult.COMPLETE,repository.runUpload("owner",first.operationId,1))
        assertEquals(api.retryRequests[0],api.retryRequests[1])
        val next=repository.retry("68c000000000000000000003")
        api.retried={throw JobsFailure(JobsProblem.NEW_INPUT_REQUIRED)}
        assertEquals(ProcessingRunResult.PAUSED,repository.runUpload("owner",next.operationId,1))
        assertEquals(JobsProblem.NEW_INPUT_REQUIRED,store.get("owner",next.operationId)!!.problem)
    }

}
