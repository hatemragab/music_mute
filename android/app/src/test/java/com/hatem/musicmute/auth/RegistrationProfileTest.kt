package com.hatem.musicmute.auth

import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class RegistrationProfileTest {
    @Test fun nameValidationAcceptsUnicodeAndRejectsBlankOrControlCharacters() {
        assertEquals("حاتم رجب", validatedFullName("  حاتم رجب  "))
        listOf("", "   ", "name\nother", "x".repeat(201)).forEach {
            assertTrue(runCatching { validatedFullName(it) }.isFailure)
        }
    }

    @Test fun failedNameUpdateRemainsPendingAndRetryClearsItWithoutCreatingAnAccount() = runTest {
        val request = PendingProfileName("owner", "User Name")
        var stored: PendingProfileName? = null
        var displayedName: String? = null
        val failed = completeProfileNameUpdate(request, { stored = it }, {
            throw AuthFailure(AuthProblem.OFFLINE)
        }, { stored = null })
        assertFalse(failed)
        assertEquals(request, stored)
        val success = completeProfileNameUpdate(stored!!, { stored = it }, {
            displayedName = it.fullName
        }, { stored = null })
        assertTrue(success)
        assertEquals("User Name", displayedName)
        assertNull(stored)
    }
}
