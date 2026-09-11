package com.hatem.musicmute.processing

import java.io.File
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class ClientErrorOutboxTest {
    @Test fun outboxIsOwnerScopedBoundedAndReplaysTheSameEventIdentity() = runTest {
        val root = kotlin.io.path.createTempDirectory("diagnostic-outbox-").toFile()
        val store = ProcessingStore(File(root, "metadata"), backgroundScope)
        val api = ReportingApi()
        var session: ProcessingSession? = ProcessingSession("owner", 1)
        val outbox = ClientErrorOutbox(store, { session }, api, maxEntries = 2)
        repeat(3) { index ->
            outbox.capture(
                operationId = UUID.randomUUID().toString(), jobId = null,
                stage = ClientErrorStage.PREPARING_INPUT, code = ClientErrorCode.LOCAL_IO,
                retryable = true, appVersion = "0.1.0", osVersion = "15",
                occurredAt = Instant.ofEpochSecond(index.toLong()),
            )
        }
        val pending = store.clientErrors("owner").first()
        assertEquals(2, pending.size)
        api.fail = true
        outbox.flush()
        val retained = store.clientErrors("owner").first()
        assertEquals(pending.map { it.report.eventId }, retained.map { it.report.eventId })
        api.fail = false
        outbox.flush()
        assertTrue(store.clientErrors("owner").first().isEmpty())
        assertEquals(retained.map { it.report.eventId }, api.accepted.takeLast(2))
        session = ProcessingSession("other", 2)
        assertTrue(store.clientErrors("other").first().isEmpty())
    }

    private class ReportingApi : JobsApi {
        var fail = false
        val accepted = mutableListOf<String>()
        override suspend fun reportClientError(report: ClientErrorReport): ClientErrorAccepted {
            accepted += report.eventId
            if (fail) throw JobsFailure(JobsProblem.OFFLINE)
            return ClientErrorAccepted(report.eventId)
        }
        override suspend fun create(requestId: String, input: InputDeclaration) = error("unused")
        override suspend fun renewUpload(id: String) = error("unused")
        override suspend fun confirmUpload(id: String) = error("unused")
        override suspend fun list(cursor: String?, status: String?) = JobPage(emptyList())
        override suspend fun detail(id: String) = error("unused")
        override suspend fun cancel(id: String) = error("unused")
        override suspend fun retry(id: String, requestId: String) = error("unused")
        override suspend fun download(id: String, artifact: String) = error("unused")
    }
}
