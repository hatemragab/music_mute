package com.hatem.musicmute.updates

import com.azhon.appupdate.base.BaseHttpDownloadManager
import com.azhon.appupdate.base.bean.DownloadStatus
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.flowOn

/** AppUpdate must never receive Done until the APK is safe to expose for installation. */
internal class AppUpdateHttpManager(
    private val transport: UpdateDownloadClient,
    private val destination: File,
    private val target: ReleaseTarget,
    private val grant: ReleaseDownloadGrant,
    private val verifier: ApkVerifier,
) : BaseHttpDownloadManager() {
    @Volatile private var cancelled = false

    override fun download(apkUrl: String, apkName: String): Flow<DownloadStatus> = flow {
        var complete = false
        try {
            if (cancelled) throw CancellationException("Update cancelled")
            if (apkUrl != grant.url || apkName != destination.name)
                throw UpdateFailure(UpdateProblem.INVALID_POLICY)
            emit(DownloadStatus.Start)
            var downloaded = false
            transport.download(apkUrl, destination).collect { event ->
                if (cancelled) throw CancellationException("Update cancelled")
                when (event) {
                    is UpdateDownloadEvent.Progress -> {
                        if (event.bytes < 0 || event.bytes > grant.bytes ||
                            (event.totalBytes > 0 && event.totalBytes != grant.bytes))
                            throw UpdateFailure(UpdateProblem.APK_SIZE_MISMATCH)
                        emit(DownloadStatus.Downloading(grant.bytes.toInt(), event.bytes.toInt()))
                    }
                    is UpdateDownloadEvent.Complete -> {
                        if (event.file.canonicalFile != destination.canonicalFile)
                            throw UpdateFailure(UpdateProblem.APK_INVALID)
                        downloaded = true
                    }
                }
            }
            if (!downloaded) throw UpdateFailure(UpdateProblem.DOWNLOAD_FAILED)
            verifier.verify(destination, target, grant)
            if (cancelled) throw CancellationException("Update cancelled")
            emit(DownloadStatus.Done(destination))
            complete = true
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            // Do not forward transport exceptions containing signed URLs to library logs.
            emit(DownloadStatus.Error(
                if (error is UpdateFailure) error else UpdateFailure(UpdateProblem.DOWNLOAD_FAILED)
            ))
        } finally {
            if (!complete) destination.delete()
        }
    }.flowOn(Dispatchers.IO)

    override fun cancel() {
        cancelled = true
        transport.cancel()
    }

    override fun release() = cancel()
}
