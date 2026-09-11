package com.hatem.musicmute.auth

import android.util.AtomicFile
import java.io.File
import java.io.FileNotFoundException
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

@Serializable data class BootstrapRecord(val uid: String, val profile: AccountProfile)

@Serializable
private data class StoredInstallation(
    val report: InstallationReport,
    val bootstrap: BootstrapRecord? = null,
)

/**
 * Auth-only state: kept in Context.noBackupFilesDir, independent of local audio and Firebase
 * tokens.
 */
class InstallationStore(directory: File, private val currentMetadata: () -> InstallationMetadata) {
    private val file = AtomicFile(File(directory, "auth-installation.json"))
    private val lock = Any()
    private val json = Json { ignoreUnknownKeys = true }

    suspend fun report(): InstallationReport = access { stored ->
        val current = currentMetadata()
        validate(current)
        val result =
            if (stored.report.metadata() == current) stored.report
            else
                makeReport(
                    stored.report.installationId,
                    current,
                    nextRevision(stored.report.metadataRevision),
                )
        if (stored.report != result) write(stored.copy(report = result))
        result
    }

    suspend fun reconcile(serverDevice: RegisteredDevice): InstallationReport = access { stored ->
        if (serverDevice.installationId != stored.report.installationId)
            throw AuthFailure(AuthProblem.DEVICE_CONFLICT)
        val report =
            makeReport(
                stored.report.installationId,
                currentMetadata(),
                nextRevision(maxOf(stored.report.metadataRevision, serverDevice.metadataRevision)),
            )
        write(stored.copy(report = report))
        report
    }

    suspend fun bootstrap(): BootstrapRecord? = access { it.bootstrap }

    suspend fun saveBootstrap(uid: String, profile: AccountProfile) = access {
        write(it.copy(bootstrap = BootstrapRecord(uid, profile)))
    }

    suspend fun clearBootstrap() = access { write(it.copy(bootstrap = null)) }

    private suspend fun <T> access(action: (StoredInstallation) -> T): T =
        withContext(Dispatchers.IO) {
            synchronized(lock) {
                try {
                    action(read())
                } catch (failure: AuthFailure) {
                    throw failure
                } catch (_: Exception) {
                    throw AuthFailure(AuthProblem.STORAGE)
                }
            }
        }

    private fun read(): StoredInstallation {
        val stored =
            try {
                file.openRead().use {
                    json.decodeFromString<StoredInstallation>(it.reader().readText())
                }
            } catch (_: FileNotFoundException) {
                val created =
                    StoredInstallation(
                        makeReport(UUID.randomUUID().toString(), currentMetadata(), 1)
                    )
                write(created)
                return created
            }
        val id = UUID.fromString(stored.report.installationId)
        if (
            id.version() != 4 ||
                id.toString() != stored.report.installationId ||
                stored.report.metadataRevision !in 1..MAX_METADATA_REVISION
        )
            throw AuthFailure(AuthProblem.STORAGE)
        validate(stored.report.metadata())
        return stored
    }

    private fun write(value: StoredInstallation) {
        file.baseFile.parentFile?.mkdirs()
        val stream = file.startWrite()
        try {
            stream.write(json.encodeToString(value).toByteArray())
            file.finishWrite(stream)
        } catch (error: Exception) {
            file.failWrite(stream)
            throw error
        }
    }

    private fun makeReport(
        id: String,
        metadata: InstallationMetadata,
        revision: Long,
    ): InstallationReport {
        validate(metadata)
        return InstallationReport(
            id,
            metadata.platform,
            metadata.appVersion,
            metadata.buildNumber,
            revision,
            metadata.osVersion,
            metadata.deviceModel,
        )
    }

    private fun nextRevision(revision: Long): Long {
        if (revision !in 1 until MAX_METADATA_REVISION) throw AuthFailure(AuthProblem.STORAGE)
        return revision + 1
    }

    private fun validate(value: InstallationMetadata) {
        fun printable(text: String, max: Int) =
            text.codePointCount(0, text.length) in 1..max &&
                text.codePoints().noneMatch {
                    Character.getType(it) in
                        setOf(Character.CONTROL.toInt(), Character.FORMAT.toInt())
                }
        if (
            value.platform != "android" ||
                value.buildNumber < 1 ||
                !printable(value.appVersion, 32) ||
                !printable(value.osVersion, 64) ||
                (value.deviceModel != null && !printable(value.deviceModel, 100))
        )
            throw AuthFailure(AuthProblem.CONFIGURATION)
    }
}
