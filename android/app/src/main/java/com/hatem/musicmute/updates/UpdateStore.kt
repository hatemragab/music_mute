package com.hatem.musicmute.updates

import androidx.datastore.core.DataStore
import androidx.datastore.core.Serializer
import java.io.InputStream
import java.io.OutputStream
import kotlinx.coroutines.flow.first
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
data class StoredUpdateState(
    val snapshot: UpdatePolicySnapshot? = null,
    val lastAttemptEpochMs: Long = 0,
    val lastSuccessEpochMs: Long = 0,
    val optionalReleaseId: String? = null,
    val optionalDeferredAtEpochMs: Long = 0,
    val optionalDeferredUntilEpochMs: Long = 0,
    val failureCount: Int = 0,
    val retryNotBeforeEpochMs: Long = 0,
    val provisionalRequired: Boolean = false,
)

interface UpdateStateStore {
    suspend fun load(): StoredUpdateState
    suspend fun save(value: StoredUpdateState)
}

class DataStoreUpdateStateStore(private val store: DataStore<StoredUpdateState>) : UpdateStateStore {
    override suspend fun load(): StoredUpdateState = store.data.first()
    override suspend fun save(value: StoredUpdateState) { store.updateData { value } }
}

object UpdateStateSerializer : Serializer<StoredUpdateState> {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true }
    override val defaultValue = StoredUpdateState()
    override suspend fun readFrom(input: InputStream): StoredUpdateState =
        runCatching { json.decodeFromString<StoredUpdateState>(input.readBytes().toString(Charsets.UTF_8)) }
            .getOrDefault(defaultValue)
    override suspend fun writeTo(t: StoredUpdateState, output: OutputStream) {
        output.write(json.encodeToString(StoredUpdateState.serializer(), t).toByteArray(Charsets.UTF_8))
    }
}
