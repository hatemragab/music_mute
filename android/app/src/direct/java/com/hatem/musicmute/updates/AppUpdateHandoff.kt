package com.hatem.musicmute.updates

import java.io.File

/** Main-thread gate: native-dialog return must finish before installer handoff begins. */
internal class AppUpdateHandoff {
    private var hostResumed = false
    private var verified: File? = null

    fun dialogOpened() { hostResumed = false }
    fun hostResumed() { hostResumed = true }
    fun verified(apk: File) { verified = apk }

    fun takeReady(): File? {
        if (!hostResumed) return null
        val apk = verified ?: return null
        verified = null
        return apk
    }
}
