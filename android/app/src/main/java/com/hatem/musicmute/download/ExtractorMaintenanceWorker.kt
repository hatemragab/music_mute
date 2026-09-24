package com.hatem.musicmute.download

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.hatem.musicmute.VocalApplication
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException

class ExtractorMaintenanceWorker(context: Context, parameters: WorkerParameters) :
    CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result = try {
        val downloader = (applicationContext as VocalApplication).audioDownloader
        if (downloader.updateExtractor()) Result.success() else Result.retry()
    } catch (error: CancellationException) {
        throw error
    } catch (_: Exception) {
        Result.retry()
    }

    companion object {
        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<ExtractorMaintenanceWorker>(24, TimeUnit.HOURS)
                .setConstraints(Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.UNMETERED)
                    .setRequiresBatteryNotLow(true)
                    .setRequiresStorageNotLow(true)
                    .build())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                "youtube-extractor-maintenance", ExistingPeriodicWorkPolicy.KEEP, request)
        }
    }
}
