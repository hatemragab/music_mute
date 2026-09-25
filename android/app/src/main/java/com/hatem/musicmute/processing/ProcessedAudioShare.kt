package com.hatem.musicmute.processing

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

class ProcessedAudioShare(private val context: Context, private val shareRoot: File) {
    fun intent(file: File, displayName: String, ownerUid: String, jobId: String): Intent {
        require(file.isFile && file.length() > 0)
        val owner = processingOwnerDirectory(shareRoot, ownerUid)
        val directory = File(owner, outputCacheKey(ownerUid, jobId))
        if (!directory.isDirectory && !directory.mkdirs()) throw ArtifactException(ArtifactProblem.STORAGE)
        val shared = File(directory, processedAudioExportName(displayName))
        if (!shared.canonicalPath.startsWith(shareRoot.canonicalPath + File.separator))
            throw ArtifactException(ArtifactProblem.STORAGE)
        if (!shared.isFile || shared.length() != file.length()) {
            try {
                Files.copy(file.toPath(), shared.toPath(), StandardCopyOption.REPLACE_EXISTING)
            } catch (_: Exception) {
                throw ArtifactException(ArtifactProblem.STORAGE)
            }
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.processed-audio", shared)
        return Intent(Intent.ACTION_SEND).apply {
            type = "audio/mpeg"
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_TITLE, displayName)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            clipData = android.content.ClipData.newUri(context.contentResolver, displayName, uri)
        }
    }

    fun evict(ownerUid: String, jobId: String) {
        File(processingOwnerDirectory(shareRoot, ownerUid), outputCacheKey(ownerUid, jobId))
            .takeIf { it.canonicalPath.startsWith(shareRoot.canonicalPath + File.separator) }
            ?.deleteRecursively()
    }
}
