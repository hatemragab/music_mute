package com.hatem.musicmute.processing

import java.io.File
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test

class PreparedMediaCleanupTest {
    @Test fun uncertainReceiptRetainsInputAndConfirmedReceiptRemovesOnlyTemporaryFile() {
        val root = java.nio.file.Files.createTempDirectory("cleanup-test").toFile()
        try {
            val id = UUID.randomUUID().toString()
            val owner = processingOwnerDirectory(root, "owner")
            val file = File(File(owner, id), "input.m4a").apply { requireNotNull(parentFile).mkdirs(); writeText("audio") }
            val original = File(root, "original.m4a").apply { writeText("original") }
            val operation = ProcessingOperation(id, "owner", id, stagedRelativePath = file.relativeTo(root).path, jobId = "job", serverStatus = "awaiting_upload")
            assertFalse(PreparedMediaCleanup(root).afterConfirmedUpload(operation))
            assertTrue(file.exists())
            assertTrue(PreparedMediaCleanup(root).afterConfirmedUpload(operation.copy(serverStatus = "queued")))
            assertFalse(file.exists()); assertTrue(original.exists())
        } finally { root.deleteRecursively() }
    }
    @Test fun cannotDeleteAnotherOwnerOrOriginalFile() {
        val root = java.nio.file.Files.createTempDirectory("cleanup-test").toFile()
        try {
            val original = File(root, "input.m4a").apply { writeText("original") }
            val operation = ProcessingOperation(UUID.randomUUID().toString(), "owner", "request", stagedRelativePath = original.name, jobId = "job", serverStatus = "ready")
            assertFalse(PreparedMediaCleanup(root).afterConfirmedUpload(operation)); assertTrue(original.exists())
        } finally { root.deleteRecursively() }
    }
}
