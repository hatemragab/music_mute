package com.hatem.musicmute.processing

import androidx.datastore.core.CorruptionException
import androidx.datastore.core.DataStore
import androidx.datastore.core.DataStoreFactory
import androidx.datastore.core.Serializer
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromStream
import kotlinx.serialization.ExperimentalSerializationApi

data class ProcessingSession(val uid: String, val epoch: Long)

@Serializable
enum class ProcessingPhase {
    SOURCE_INTAKE, SOURCE_QUEUED, DOWNLOADING_SOURCE, PREPARING_INPUT,
    WAITING, RESERVING, UPLOADING, CONFIRMING, RETRY_WAIT, PAUSED, COMPLETE, CANCELLING,
}

@Serializable
enum class ProcessingLocalProblem { STORAGE, INPUT_CHANGED, TRANSFER, RETRY_EXHAUSTED, UNKNOWN_STATE }

/** No signed grants, tokens, storage keys, or diagnostics belong in this durable record. */
@Serializable
data class ProcessingOperation(
    val operationId: String,
    val ownerUid: String,
    val requestId: String,
    val input: InputDeclaration? = null,
    val stagedRelativePath: String? = null,
    val displayName: String = "",
    val jobId: String? = null,
    val retryOfJobId: String? = null,
    val serverStatus: String? = null,
    val phase: ProcessingPhase = ProcessingPhase.WAITING,
    val uploadedBytes: Long = 0,
    val problem: JobsProblem? = null,
    val localProblem: ProcessingLocalProblem? = null,
    val cancellationRequested: Boolean = false,
    val runId: String? = null,
    val retryNotBeforeMillis: Long = 0,
    val sourceKind: SourceKind? = null,
    val sourceTitle: String = "",
    val sourceUrl: String? = null,
    val clientStartedAtMillis: Long = 0,
    val acceptedAtMillis: Long = 0,
    val transientRetryCount: Int = 0,
    val sourceDownloadedBytes: Long = 0,
    val sourceTotalBytes: Long? = null,
    val pendingDelete: Boolean = false,
    val reservationAttempted: Boolean = false,
    val sourceWorkRequestId: String? = null,
    val awaitingCloudConsent: Boolean = false,
    val schemaVersion: Int = 2,
)

@Serializable
data class StoredClientError(val ownerUid: String, val report: ClientErrorReport)

@Serializable
data class ProcessingDocument(
    val operations: List<ProcessingOperation> = emptyList(),
    val snapshots: List<Job> = emptyList(),
    val clientErrors: List<StoredClientError> = emptyList(),
    val schemaVersion: Int = 2,
)

private object ProcessingSerializer : Serializer<ProcessingDocument> {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    override val defaultValue = ProcessingDocument()

    @OptIn(ExperimentalSerializationApi::class)
    override suspend fun readFrom(input: InputStream): ProcessingDocument {
        return try {
            json.decodeFromStream<ProcessingDocument>(input)
        } catch (error: SerializationException) {
            throw CorruptionException("Processing metadata is unreadable", error)
        } catch (error: IllegalArgumentException) {
            throw CorruptionException("Processing metadata is invalid", error)
        } catch (error: java.time.DateTimeException) {
            throw CorruptionException("Processing metadata dates are invalid", error)
        }
    }

    override suspend fun writeTo(t: ProcessingDocument, output: OutputStream) {
        output.write(json.encodeToString(t).toByteArray(Charsets.UTF_8))
    }
}

/** One DataStore per owner under the application's no-backup processing root.
 * Corruption is surfaced instead of replacing an unknown reservation with a new request ID.
 */
class ProcessingStore(
    private val root: File,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    private val stores = ConcurrentHashMap<String, DataStore<ProcessingDocument>>()

    private fun store(uid: String): DataStore<ProcessingDocument> {
        require(uid.isNotBlank())
        return stores.computeIfAbsent(uid) {
            DataStoreFactory.create(ProcessingSerializer, scope = scope) {
                File(processingOwnerDirectory(root, uid), "processing.json")
            }
        }
    }

    fun operations(uid: String): Flow<List<ProcessingOperation>> = store(uid).data.map { document ->
        validateOwner(uid, document)
        document.operations
    }

    fun snapshots(uid: String): Flow<List<Job>> = store(uid).data.map { document ->
        validateOwner(uid, document)
        document.snapshots
    }

    suspend fun get(uid: String, operationId: String): ProcessingOperation? =
        operations(uid).first().find { it.operationId == operationId }

    suspend fun put(uid: String, operation: ProcessingOperation) {
        require(operation.ownerUid == uid)
        store(uid).updateData { document ->
            validateOwner(uid, document)
            val existing = document.operations.find { it.operationId == operation.operationId }
            require(existing == null || existing.requestId == operation.requestId)
            document.copy(operations = document.operations.filterNot { it.operationId == operation.operationId } + operation)
        }
    }

    suspend fun update(uid: String, operationId: String, transform: (ProcessingOperation) -> ProcessingOperation): ProcessingOperation? {
        val document = store(uid).updateData { current ->
            validateOwner(uid, current)
            current.copy(operations = current.operations.map { operation ->
                if (operation.operationId != operationId) operation else transform(operation).also {
                    require(it.ownerUid == uid && it.operationId == operationId && it.requestId == operation.requestId)
                }
            })
        }
        return document.operations.find { it.operationId == operationId }
    }

    suspend fun saveSnapshots(uid: String, jobs: List<Job>) {
        store(uid).updateData { current ->
            validateOwner(uid, current)
            current.copy(snapshots = jobs.distinctBy { it.id })
        }
    }

    fun clientErrors(uid: String): Flow<List<StoredClientError>> = store(uid).data.map { document ->
        validateOwner(uid, document)
        document.clientErrors
    }

    suspend fun enqueueClientError(uid: String, value: StoredClientError, maxEntries: Int) {
        require(value.ownerUid == uid && maxEntries > 0)
        store(uid).updateData { current ->
            validateOwner(uid, current)
            val values = (current.clientErrors.filterNot { it.report.eventId == value.report.eventId } + value)
                .takeLast(maxEntries)
            current.copy(clientErrors = values)
        }
    }

    suspend fun removeClientError(uid: String, eventId: String) {
        store(uid).updateData { current ->
            validateOwner(uid, current)
            current.copy(clientErrors = current.clientErrors.filterNot { it.report.eventId == eventId })
        }
    }

    suspend fun removeOperation(uid: String, operationId: String) {
        store(uid).updateData { current ->
            validateOwner(uid, current)
            current.copy(operations = current.operations.filterNot { it.operationId == operationId })
        }
    }

    suspend fun clearOwner(uid: String) { store(uid).updateData { ProcessingDocument() } }

    private fun validateOwner(uid: String, document: ProcessingDocument) {
        if (document.operations.any { it.ownerUid != uid } || document.clientErrors.any { it.ownerUid != uid } ||
            document.operations.map { it.operationId }.distinct().size != document.operations.size
        ) throw CorruptionException("Processing metadata owner is invalid")
    }
}
