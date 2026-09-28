package com.hatem.musicmute.library

import com.hatem.musicmute.ui.library.libraryCreatedAt
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LibraryCreatedAtTest {
    @Test fun formatsCreatedAtInTheRequestedZone() {
        val epochMs = Instant.parse("2026-09-28T10:00:00Z").toEpochMilli()
        val dubai = libraryCreatedAt(epochMs, ZoneId.of("Asia/Dubai"), Locale.US)
        val utc = libraryCreatedAt(epochMs, ZoneOffset.UTC, Locale.US)
        assertEquals("Sep 28, 2026, 2:00 PM", dubai)
        assertEquals("Sep 28, 2026, 10:00 AM", utc)
        assertTrue(dubai != utc)
    }

    @Test fun missingCreatedAtStaysHidden() {
        assertNull(libraryCreatedAt(0))
        assertNull(libraryCreatedAt(-1))
    }
}
