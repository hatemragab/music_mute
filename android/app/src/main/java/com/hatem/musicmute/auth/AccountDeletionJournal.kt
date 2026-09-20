package com.hatem.musicmute.auth

import com.hatem.musicmute.processing.processingOwnerDirectory
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

@Serializable
data class PendingAccountDeletion(
    val uid: String,
    val accepted: Boolean,
    val invalidated: Boolean = false,
    val requestId: String? = null,
    val recoverUntil: String? = null,
) {
    val requiresPurge: Boolean get() = accepted || invalidated
}

/** Minimal no-backup recovery record. A timeout never authorizes a private-data purge. */
class AccountDeletionJournal(private val file: File) {
    fun all(): List<PendingAccountDeletion> = if (file.isFile)
        Json.decodeFromString<List<PendingAccountDeletion>>(file.readText()) else emptyList()

    fun pending(): PendingAccountDeletion? = all().firstOrNull()
    /** Returns true only for the first attempt; later responses cannot disprove an earlier timeout. */
    fun requested(uid: String): Boolean {
        all().firstOrNull { it.uid == uid }?.let {
            require(!it.accepted)
            return false
        }
        record(PendingAccountDeletion(uid, false))
        return true
    }
    fun accepted(uid: String, receipt: AccountDeletionReceipt) {
        require(receipt.requestId.isNotBlank() && !receipt.recoverUntil.isNullOrBlank())
        record(PendingAccountDeletion(uid, true, requestId = receipt.requestId, recoverUntil = receipt.recoverUntil))
    }
    fun invalidated(uid: String) {
        val existing = all().firstOrNull { it.uid == uid }
        record(
            PendingAccountDeletion(
                uid,
                existing?.accepted == true,
                true,
                existing?.requestId,
                existing?.recoverUntil,
            )
        )
    }
    fun rejected(uid: String) {
        if (all().any { it.uid == uid && !it.requiresPurge }) completed(uid)
    }
    fun completed(uid: String) {
        val remaining = all().filterNot { it.uid == uid }
        if (remaining.isNotEmpty()) write(remaining)
        else if (file.exists() && !file.delete()) throw IOException("Deletion receipt cleanup failed")
    }

    private fun record(value: PendingAccountDeletion) {
        require(value.uid.isNotBlank())
        val existing = all()
        require(value.accepted || existing.none { it.uid == value.uid && it.accepted })
        write(existing.filterNot { it.uid == value.uid } + value)
    }

    private fun write(values: List<PendingAccountDeletion>) {
        file.parentFile?.mkdirs()
        val temporary = File(file.parentFile, file.name + ".tmp")
        temporary.outputStream().use { output ->
            output.write(Json.encodeToString(values).toByteArray())
            output.fd.sync()
        }
        Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    }
}

fun purgePrivateOwnerDirectory(root: File, uid: String) {
    require(uid.isNotBlank())
    val directory = processingOwnerDirectory(root, uid).canonicalFile
    require(directory != root.canonicalFile && directory.toPath().startsWith(root.canonicalFile.toPath()))
    if (directory.exists() && !directory.deleteRecursively()) throw IOException("Private account cleanup failed")
}
