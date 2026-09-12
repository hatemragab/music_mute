package com.hatem.musicmute.updates

import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateAdmissionTest {
    @Test
    fun restorationAndKnownRequiredPolicyBlockBackgroundEntryPoints() {
        val state = MutableStateFlow(UpdateUiState())
        val admission = UpdateAdmission(state)
        assertTrue(admission.isBlocked())

        state.value = UpdateUiState(restoring = false, decision = UpdateDecision.NONE)
        assertFalse(admission.isBlocked())

        state.value = UpdateUiState(restoring = false, decision = UpdateDecision.REQUIRED)
        assertTrue(admission.isBlocked())
        assertThrows(UpdateFailure::class.java) { admission.requireAllowed() }
    }
}
