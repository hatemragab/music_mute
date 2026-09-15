package com.hatem.musicmute.download

import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ExtractorMaintenanceTest {
    @get:Rule val temporary = TemporaryFolder()
    private val candidate = "new extractor".toByteArray()
    private val release = ExtractorRelease("2026.08.19", sha256(candidate), "test")
    private fun installed() = temporary.newFile("yt-dlp").apply { writeText("old extractor") }

    @Test fun verifiedUpdateIsActivatedAndChecksArePersistent() {
        val file = installed()
        val updater = ExtractorMaintenance(file, { release }, { candidate }, { 1_000 })
        assertEquals(ExtractorUpdate.UPDATED, updater.refresh { if (file.readText() == "old extractor") "2025.11.12" else release.version })
        assertArrayEquals(candidate, file.readBytes())
        assertEquals("old extractor", File(file.parentFile, "yt-dlp.previous").readText())
        val restarted = ExtractorMaintenance(file, { error("Must not fetch") }, { error("Must not download") }, { 2_000 })
        assertEquals(ExtractorUpdate.DEFERRED, restarted.refresh { error("Must not probe") })
    }

    @Test fun invalidChecksumNeverReplacesInstalledEngine() {
        val file = installed()
        val updater = ExtractorMaintenance(file, { release }, { "tampered".toByteArray() }, { 1_000 })
        assertEquals(ExtractorUpdate.FAILED, updater.refresh { "2025.11.12" })
        assertEquals("old extractor", file.readText())
    }

    @Test fun incompatibleRuntimeRestoresPreviousVersion() {
        val file = installed()
        val updater = ExtractorMaintenance(file, { release }, { candidate }, { 1_000 })
        assertEquals(ExtractorUpdate.FAILED, updater.refresh {
            if (file.readText() != "old extractor") error("unsupported runtime")
            "2025.11.12"
        })
        assertEquals("old extractor", file.readText())
        assertFalse(File(file.parentFile, "yt-dlp.pending").exists())
    }

    @Test fun interruptedInstallIsRecoveredEvenDuringCooldown() {
        val file = installed()
        File(file.parentFile, "yt-dlp.previous").writeText("working")
        File(file.parentFile, "yt-dlp.pending").writeText("pending")
        File(file.parentFile, "next-check").writeText("99999")
        val updater = ExtractorMaintenance(file, { error("offline") }, now = { 1_000 })
        assertEquals(ExtractorUpdate.DEFERRED, updater.refresh { error("unused") })
        assertEquals("working", file.readText())
    }

    @Test fun offlineUpdateKeepsInstalledEngineAndBacksOff() {
        val file = installed()
        val updater = ExtractorMaintenance(file, { throw java.net.SocketTimeoutException() }, now = { 1_000 })
        assertEquals(ExtractorUpdate.FAILED, updater.refresh { "2025.11.12" })
        assertEquals("old extractor", file.readText())
        assertEquals(ExtractorUpdate.DEFERRED, updater.refresh { "2025.11.12" })
    }

    @Test fun currentVersionDoesNotDownloadAgain() {
        val updater = ExtractorMaintenance(installed(), { release }, { error("Must not download") }, { 1_000 })
        assertEquals(ExtractorUpdate.CURRENT, updater.refresh { release.version })
    }

    @Test fun damagedInstalledExtractorCanBeRepaired() {
        val file = installed()
        val updater = ExtractorMaintenance(file, { release }, { candidate }, { 1_000 })
        assertEquals(ExtractorUpdate.UPDATED, updater.refresh {
            if (file.readText() == "old extractor") error("damaged")
            release.version
        })
        assertArrayEquals(candidate, file.readBytes())
    }

    @Test fun cancellationRestoresEngineAndPropagates() {
        val file = installed()
        val updater = ExtractorMaintenance(file, { release }, { candidate }, { 1_000 })
        try {
            updater.refresh {
                if (file.readText() != "old extractor") throw InterruptedException()
                "2025.11.12"
            }
            fail("Cancellation must propagate")
        } catch (_: InterruptedException) {
            assertEquals("old extractor", file.readText())
            assertFalse(File(file.parentFile, "yt-dlp.pending").exists())
        }
    }
}
