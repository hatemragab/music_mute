package com.hatem.musicmute.download

import org.junit.Assert.*
import org.junit.Test

class DownloadProgressTest {
    @Test
    fun parsesBytesAndResumedPercentage() {
        assertEquals(
            DownloadProgress(50, 500, 1000),
            DownloadProgress.parse(50f, "[download] 50.0% VOCAL:500:1000"),
        )
    }

    @Test
    fun unknownTotalStillReportsReceivedBytes() {
        assertEquals(
            DownloadProgress(0, 500, null),
            DownloadProgress.parse(-1f, "[download] Unknown% VOCAL:500:NA"),
        )
    }

    @Test
    fun invalidValuesCannotCreateInvalidProgress() {
        assertEquals(DownloadProgress(0), DownloadProgress.parse(Float.NaN, "unrelated output"))
        assertEquals(99, DownloadProgress.parse(100f, "VOCAL:1000:1000").percent)
    }
}
