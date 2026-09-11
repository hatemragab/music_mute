package com.hatem.musicmute.processing

import android.content.Context
import androidx.work.*
import com.hatem.musicmute.VocalApplication
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class WorkManagerClientErrorScheduler(private val context: Context) {
    suspend fun enqueue(session: ProcessingSession) {
        val request = OneTimeWorkRequestBuilder<ClientErrorReportWorker>()
            .setInputData(workDataOf(OWNER to session.uid, EPOCH to session.epoch))
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .addTag(ownerTag(session.uid))
            .build()
        withContext(Dispatchers.IO) {
            WorkManager.getInstance(context).enqueueUniqueWork(
                ownerTag(session.uid),
                ExistingWorkPolicy.KEEP,
                request,
            ).result.get()
        }
    }

    companion object {
        const val OWNER = "client_error_owner"
        const val EPOCH = "client_error_epoch"
        private fun ownerTag(uid: String) =
            "client-errors-${processingOwnerDirectory(java.io.File("."), uid).name}"
    }
}

class ClientErrorReportWorker(context: Context, parameters: WorkerParameters) :
    CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val app = applicationContext as? VocalApplication ?: return Result.failure()
        val owner = inputData.getString(WorkManagerClientErrorScheduler.OWNER)
            ?: return Result.failure()
        val epoch = inputData.getLong(WorkManagerClientErrorScheduler.EPOCH, Long.MIN_VALUE)
        if (!app.processingRepository.isCurrentSession(owner, epoch)) return Result.failure()
        return try {
            if (app.clientErrorOutbox.flush()) Result.success()
            else if (runAttemptCount < 3) Result.retry() else Result.failure()
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            if (runAttemptCount < 3) Result.retry() else Result.failure()
        }
    }
}
