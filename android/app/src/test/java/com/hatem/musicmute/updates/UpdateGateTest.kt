package com.hatem.musicmute.updates

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateGateTest {
    @Test
    fun requiredBackgroundRemainsWhileOptionalUpdatesKeepContentAcrossInstallationStates() {
        val states = listOf(
            UpdateInstallState.Idle,
            UpdateInstallState.Downloading(50),
            UpdateInstallState.Verifying,
            UpdateInstallState.PermissionNeeded,
            UpdateInstallState.AwaitingInstaller,
            UpdateInstallState.StoreOpened,
            UpdateInstallState.Failed(UpdateProblem.INSTALL_CANCELLED),
        )
        for (install in states) {
            val required = updatePromptPresentation(
                UpdateUiState(restoring = false, decision = UpdateDecision.REQUIRED), install,
            )
            assertTrue("Required background must remain for $install", required.blocksContent)
            assertFalse("Required update cannot be dismissed for $install", required.dismissible)
            val optional = updatePromptPresentation(
                UpdateUiState(restoring = false, decision = UpdateDecision.OPTIONAL), install,
            )
            assertFalse("Optional update must retain app content for $install", optional.blocksContent)
        }
    }

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
