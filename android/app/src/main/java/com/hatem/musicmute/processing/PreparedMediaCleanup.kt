package com.hatem.musicmute.processing

import java.io.File

/** Only a verified upload receipt or authenticated post-upload state releases retry bytes. */
class PreparedMediaCleanup(private val root: File) {
    fun abandonedBeforeReservation(operation: ProcessingOperation) {
        if (!operation.cancellationRequested || operation.reservationAttempted || operation.jobId != null) return
        if (runCatching { java.util.UUID.fromString(operation.operationId).toString() }.getOrNull() != operation.operationId) return
        val directory = File(processingOwnerDirectory(root, operation.ownerUid), operation.operationId).canonicalFile
        if (directory.parentFile != processingOwnerDirectory(root, operation.ownerUid).canonicalFile) return
        directory.listFiles()?.filter { it.isFile && (it.name.startsWith("input.") || it.name.startsWith(".input.") || it.name.startsWith(".export-")) }
            ?.forEach { it.delete() }
    }
    fun afterConfirmedUpload(operation: ProcessingOperation): Boolean {
        if (operation.jobId == null || operation.serverStatus !in setOf("queued", "validating", "processing", "uploading_result", "interrupted", "ready")) return false
        val relative = operation.stagedRelativePath ?: return false
        val file = File(root, relative).canonicalFile
        val expected = File(processingOwnerDirectory(root, operation.ownerUid), operation.operationId).canonicalFile
        if (file.parentFile != expected || !file.name.startsWith("input.")) return false
        return !file.exists() || file.delete()
    }
}
