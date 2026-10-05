package com.hatem.musicmute.ui.home

import java.time.Instant
import java.util.Locale
import java.util.TimeZone
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class JobCardMetadataTest {
    private val utc = TimeZone.getTimeZone("UTC")

    @Test fun sameYearUsesACompactDateAndKeepsTheTime() {
        val created = Instant.parse("2026-10-02T01:46:00Z").toEpochMilli()
        val now = Instant.parse("2026-10-02T12:00:00Z").toEpochMilli()

        val label = jobCardCreatedAtLabel(created, now, Locale.US, utc)!!

        assertEquals("Oct 2 · 1:46 AM", label)
        assertFalse(label.contains("2026"))
    }

    @Test fun olderJobsKeepTheirYearAndInvalidDatesStayHidden() {
        val created = Instant.parse("2025-10-02T13:46:00Z").toEpochMilli()
        val now = Instant.parse("2026-10-02T12:00:00Z").toEpochMilli()

        val label = jobCardCreatedAtLabel(created, now, Locale.US, utc)!!

        assertTrue(label.startsWith("Oct 2, 2025"))
        assertTrue(label.endsWith("1:46 PM"))
        assertNull(jobCardCreatedAtLabel(0, now, Locale.US, utc))
    }
}
