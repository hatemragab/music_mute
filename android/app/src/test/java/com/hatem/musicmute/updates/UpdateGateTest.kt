package com.hatem.musicmute.updates

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateGateTest {
    @Test
    fun requiredPromptBlocksTheAppAndCannotBeDeferredOrDismissed() {
        val prompt =
            updatePromptPresentation(
                UpdateUiState(restoring = false, decision = UpdateDecision.REQUIRED),
                UpdateInstallState.Idle,
            )
        assertTrue(prompt.visible)
        assertTrue(prompt.blocksContent)
        assertFalse(prompt.allowLater)
        assertFalse(prompt.dismissible)
    }

    @Test
    fun optionalPromptLeavesTheAppUsableAndOffersLater() {
        val prompt =
            updatePromptPresentation(
                UpdateUiState(restoring = false, decision = UpdateDecision.OPTIONAL),
                UpdateInstallState.Idle,
            )
        assertTrue(prompt.visible)
        assertFalse(prompt.blocksContent)
        assertTrue(prompt.allowLater)
        assertTrue(prompt.dismissible)
    }

    @Test
    fun cancelledRequiredInstallationNeverUnlocksTheGate() {
        val prompt =
            updatePromptPresentation(
                UpdateUiState(restoring = false, decision = UpdateDecision.REQUIRED),
                UpdateInstallState.Failed(UpdateProblem.INSTALL_CANCELLED),
            )
        assertTrue(prompt.visible)
        assertTrue(prompt.blocksContent)
        assertTrue(prompt.showRetry)
    }
}
