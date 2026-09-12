package com.hatem.musicmute.updates

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AppUpdateHandoffTest {
    @Test fun forcedDialogMustReturnToHostBeforeInstallation() {
        val gate = AppUpdateHandoff()
        val apk = File("verified.apk")
        gate.dialogOpened()
        gate.verified(apk)
        assertNull(gate.takeReady())
        gate.hostResumed()
        assertEquals(apk, gate.takeReady())
        assertNull(gate.takeReady())
    }

    @Test fun optionalDialogMayReturnBeforeDownloadCompletes() {
        val gate = AppUpdateHandoff()
        val apk = File("verified.apk")
        gate.dialogOpened()
        gate.hostResumed()
        assertNull(gate.takeReady())
        gate.verified(apk)
        assertEquals(apk, gate.takeReady())
        assertNull(gate.takeReady())
    }
}
