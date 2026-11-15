package com.hatem.musicmute.download

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import com.hatem.musicmute.data.YouTubeUrl
import com.hatem.musicmute.processing.PipelineSourceScheduler
import com.hatem.musicmute.processing.ProcessingStore
import com.hatem.musicmute.processing.WorkManagerProcessingScheduler
import com.hatem.musicmute.processing.processingOwnerDirectory
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

class DownloadRepository(
    context: Context,
    val store: HistoryStore,
    val audioRoot: File,
    private val processingStore: ProcessingStore? = null,
) : PipelineSourceScheduler {
    private val workManager = WorkManager.getInstance(context)
    private val enqueueLock = Mutex()

    override suspend fun enqueue(ownerUid: String, operationId: String, url: String, epoch: Long) =
        enqueueLock.withLock {
            require(YouTubeUrl.isSupported(url))
            val existing = store.get(operationId)
            if (existing != null) {
                require(existing.ownerUid == ownerUid && existing.url == url.trim())
                if (existing.status != DownloadStatus.CANCELLED) {
                    schedule(existing.copy(
                        sessionEpoch = epoch,
                        status = if (existing.status == DownloadStatus.FAILED) DownloadStatus.QUEUED else existing.status,
                        error = if (existing.status == DownloadStatus.FAILED) DownloadError.NONE else existing.error,
                    ))
                }
                return@withLock
            }
            schedule(DownloadRecord(
                id = operationId,
                url = url.trim(),
                createdAt = System.currentTimeMillis(),
                ownerUid = ownerUid,
                operationId = operationId,
                sessionEpoch = epoch,
            ))
        }

    private suspend fun schedule(record: DownloadRecord) {
        val uniqueName = "vocal-${record.id}-${record.sessionEpoch ?: 0}"
        val active = withContext(Dispatchers.IO) {
            workManager.getWorkInfosForUniqueWork(uniqueName).get()
                .firstOrNull { !it.state.isFinished }
        }
        if (active != null) {
            val workId = active.id.toString()
            store.update(record.id) { current ->
                if (current.ownerUid == record.ownerUid &&
                    current.operationId == record.operationId &&
                    current.sessionEpoch == record.sessionEpoch) {
                    current.copy(workRequestId = workId)
                } else current
            }
            store.get(record.id)?.takeIf { it.workRequestId == workId }?.let {
                bindSourceWork(it, workId)
            }
            return
        }
        val request =
            OneTimeWorkRequestBuilder<AudioDownloadWorker>()
                .setInputData(
                    workDataOf(
                        KEY_ID to record.id,
                        WorkManagerProcessingScheduler.KEY_OWNER to record.ownerUid,
                        WorkManagerProcessingScheduler.KEY_OPERATION to record.operationId,
                        WorkManagerProcessingScheduler.KEY_EPOCH to record.sessionEpoch,
                    )
                )
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
                )
                .addTag(TAG)
                .addTag(recordTag(record.id))
                .addTag(sourceWorkTag(record.id, record.sessionEpoch))
                .also { builder -> record.ownerUid?.let { builder.addTag(ownerTag(it)) } }
                .also { builder ->
                    if (record.ownerUid != null && record.operationId != null) {
                        builder.addTag(sourceOperationTag(record.ownerUid, record.operationId))
                    }
                }
                .build()
        val scheduled = record.copy(workRequestId = request.id.toString())
        val latest = store.get(record.id)
        if (latest == null) {
            store.add(scheduled)
        } else {
            store.update(record.id) {
                it.copy(
                    sessionEpoch = record.sessionEpoch,
                    status = record.status,
                    error = record.error,
                    workRequestId = scheduled.workRequestId,
                )
            }
        }
        bindSourceWork(store.get(record.id) ?: scheduled, scheduled.workRequestId!!)
        try {
            withContext(Dispatchers.IO) {
                workManager
                    .enqueueUniqueWork(
                        uniqueName,
                        ExistingWorkPolicy.KEEP,
                        request,
                    )
                    .result
                    .get()
            }
        } catch (error: Exception) {
            store.update(record.id) {
                if (it.workRequestId == scheduled.workRequestId) {
                    it.copy(status = DownloadStatus.FAILED, error = DownloadError.ENGINE)
                } else {
                    it
                }
            }
            throw error
        }
    }

    private suspend fun bindSourceWork(record: DownloadRecord, workRequestId: String) {
        val owner = record.ownerUid ?: return
        val operation = record.operationId ?: return
        processingStore?.update(owner, operation) { current ->
            if (current.ownerUid == owner && current.operationId == operation) {
                current.copy(sourceWorkRequestId = workRequestId)
            } else current
        }
    }

    override suspend fun cancel(ownerUid: String, operationId: String) {
        val record = store.get(operationId) ?: return
        if (record.ownerUid != ownerUid) return
        store.update(operationId) {
            if (it.status == DownloadStatus.COMPLETE) it
            else it.copy(status = DownloadStatus.CANCELLED)
        }
        withContext(Dispatchers.IO) {
            workManager.cancelAllWorkByTag(sourceOperationTag(ownerUid, operationId)).result.get()
        }
    }

    override suspend fun pause(ownerUid: String, operationId: String) {
        val record = store.get(operationId) ?: return
        if (record.ownerUid != ownerUid) return
        withContext(Dispatchers.IO) {
            workManager.cancelAllWorkByTag(sourceOperationTag(ownerUid, operationId)).result.get()
        }
        store.update(operationId) {
            if (it.ownerUid != ownerUid || it.status == DownloadStatus.COMPLETE) it
            else
                it.copy(
                    status = DownloadStatus.QUEUED,
                    error = DownloadError.NONE,
                    workRequestId = null,
                )
        }
        processingStore?.update(ownerUid, operationId) {
            if (it.ownerUid == ownerUid) it.copy(sourceWorkRequestId = null) else it
        }
    }

    override suspend fun cancelOwner(ownerUid: String) {
        store.records().filter { it.ownerUid == ownerUid && it.status !in setOf(
            DownloadStatus.COMPLETE, DownloadStatus.FAILED, DownloadStatus.CANCELLED
        ) }.forEach { record ->
            store.update(record.id) { it.copy(status = DownloadStatus.CANCELLED) }
        }
        withContext(Dispatchers.IO) { workManager.cancelAllWorkByTag(ownerTag(ownerUid)).result.get() }
    }

    suspend fun purgeOwner(uid: String) {
        cancelOwner(uid)
        val records = store.records().filter { it.ownerUid == uid }
        withContext(Dispatchers.IO) {
            records.forEach { record ->
                record.workRequestId?.let { com.yausername.youtubedl_android.YoutubeDL.getInstance().destroyProcessById(it) }
                val directory = File(audioRoot, record.id).canonicalFile
                require(directory.toPath().startsWith(audioRoot.canonicalFile.toPath()) && directory != audioRoot.canonicalFile)
                if (directory.exists() && !directory.deleteRecursively()) throw java.io.IOException("Private source cleanup failed")
            }
        }
        store.removeOwner(uid)
    }

    companion object {
        const val TAG = "vocal-audio-download"
        const val KEY_ID = "download_id"
        private fun ownerTag(uid: String) =
            "audio-source-${processingOwnerDirectory(File("."), uid).name}"
        private fun recordTag(id: String) = "audio-source-record-$id"
        private fun sourceWorkTag(id: String, epoch: Long?) = "audio-source-run-$id-${epoch ?: 0}"
        private fun sourceOperationTag(uid: String, operationId: String) =
            "${ownerTag(uid)}-operation-$operationId"

    }
}
