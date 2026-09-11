package com.hatem.musicmute.processing

import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.first

/**
 * A bounded, owner-scoped queue containing only allowlisted diagnostic fields.
 * Reporting is best-effort and can never block the audio pipeline.
 */
class ClientErrorOutbox(
    private val store: ProcessingStore,
    private val session: () -> ProcessingSession?,
    private val api: JobsApi,
    private val maxEntries: Int = 100,
    private val schedule: suspend (ProcessingSession) -> Unit = {},
) {
    suspend fun capture(
        operationId: String,
        jobId: String?,
        stage: ClientErrorStage,
        code: ClientErrorCode,
        retryable: Boolean,
        appVersion: String,
        osVersion: String,
        occurredAt: Instant = Instant.now(),
        httpStatus: Int? = null,
    ): String {
        val owner = session() ?: throw JobsFailure(JobsProblem.UNAUTHENTICATED)
        val report = ClientErrorReport(
            eventId = UUID.randomUUID().toString(),
            operationId = operationId,
            jobId = jobId,
            stage = stage,
            code = code,
            retryable = retryable,
            platform = "android",
            appVersion = appVersion,
            osVersion = osVersion,
            occurredAt = occurredAt,
            httpStatus = httpStatus,
        )
        store.enqueueClientError(owner.uid, StoredClientError(owner.uid, report), maxEntries)
        try {
            schedule(owner)
        } catch (_: Exception) {
            // The durable event remains available for a later app/session retry.
        }
        return report.eventId
    }

    suspend fun flush(): Boolean {
        val owner = session() ?: return true
        val entries = store.clientErrors(owner.uid).first()
        for (entry in entries) {
            if (session() != owner) throw CancellationException("Processing session changed")
            try {
                val accepted = api.reportClientError(entry.report)
                if (accepted.eventId != entry.report.eventId) return false
                if (session() != owner) throw CancellationException("Processing session changed")
                store.removeClientError(owner.uid, entry.report.eventId)
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                return false
            }
        }
        return true
    }
}
