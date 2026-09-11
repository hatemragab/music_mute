package com.hatem.musicmute.download

import androidx.datastore.core.CorruptionException
import androidx.datastore.core.DataStore
import androidx.datastore.core.Serializer
import java.io.InputStream
import java.io.OutputStream
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

@Serializable
enum class DownloadStatus {
    QUEUED,
    DOWNLOADING,
    COMPLETE,
    FAILED,
    CANCELLED,
}

@Serializable
enum class DownloadError {
    NONE,
    UNAVAILABLE,
    NETWORK,
    STORAGE,
    INTERRUPTED,
    ENGINE,
    INVALID_AUDIO,
}

@Serializable
data class DownloadRecord(
    val id: String,
    val url: String,
    val createdAt: Long,
    val status: DownloadStatus = DownloadStatus.QUEUED,
    val progress: Int = 0,
    val title: String = "",
    val relativePath: String = "",
    val codec: String = "",
    val extension: String = "",
    val bitrateKbps: Int = 0,
    val durationMs: Long = 0,
    val sizeBytes: Long = 0,
    val error: DownloadError = DownloadError.NONE,
    val downloadedBytes: Long = 0,
    val totalBytes: Long? = null,
    val ownerUid: String? = null,
    val operationId: String? = null,
    val sessionEpoch: Long? = null,
    val workRequestId: String? = null,
)

@Serializable data class DownloadHistory(val records: List<DownloadRecord> = emptyList())

object HistorySerializer : Serializer<DownloadHistory> {
    private val json = Json { ignoreUnknownKeys = true }
    override val defaultValue = DownloadHistory()

    override suspend fun readFrom(input: InputStream): DownloadHistory =
        try {
            json.decodeFromString(input.readBytes().decodeToString())
        } catch (error: SerializationException) {
            throw CorruptionException("Download history could not be read", error)
        }

    override suspend fun writeTo(t: DownloadHistory, output: OutputStream) {
        output.write(json.encodeToString(t).encodeToByteArray())
    }
}

class HistoryStore(private val store: DataStore<DownloadHistory>) {
    val history: Flow<DownloadHistory> = store.data

    suspend fun get(id: String): DownloadRecord? = store.data.first().records.find { it.id == id }

    suspend fun add(record: DownloadRecord) {
        store.updateData {
            it.copy(records = listOf(record) + it.records.filterNot { old -> old.id == record.id })
        }
    }

    suspend fun update(id: String, transform: (DownloadRecord) -> DownloadRecord) {
        store.updateData {
            it.copy(
                records = it.records.map { item -> if (item.id == id) transform(item) else item }
            )
        }
    }

    suspend fun removeOwner(uid: String) { store.updateData { it.copy(records = it.records.filterNot { record -> record.ownerUid == uid }) } }

    suspend fun records(): List<DownloadRecord> = store.data.first().records
}
