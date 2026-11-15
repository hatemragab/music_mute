package com.hatem.musicmute.playback

import androidx.media3.session.SessionError
import com.hatem.musicmute.R
import com.hatem.musicmute.auth.AuthPhase
import com.hatem.musicmute.processing.ProcessingSession
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class PlaybackLibraryErrorsTest {
    @Test fun signedOutAndIncompleteSignInReturnAuthenticationErrors() {
        listOf(AuthPhase.SIGNED_OUT, AuthPhase.BOOTSTRAP_REQUIRED).forEach { phase ->
            val problem = playbackLibraryAccessProblem(phase, updateRestoring = false, updateRequired = false)
            assertEquals(PlaybackLibraryProblem.SIGN_IN_REQUIRED, problem)
            assertEquals(SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED, problem?.code)
            assertEquals(R.string.auto_sign_in_required, problem?.messageResource)
        }
    }

    @Test fun mandatoryUpdateTakesPriorityAndRequiresPhoneSetup() {
        AuthPhase.entries.forEach { phase ->
            val problem = playbackLibraryAccessProblem(phase, updateRestoring = false, updateRequired = true)
            assertEquals(PlaybackLibraryProblem.UPDATE_REQUIRED, problem)
            assertEquals(SessionError.ERROR_SESSION_SETUP_REQUIRED, problem?.code)
            assertEquals(R.string.auto_update_required, problem?.messageResource)
        }
    }

    @Test fun restorationAndAccountRecoveryRemainUnavailable() {
        assertEquals(PlaybackLibraryProblem.UNAVAILABLE,
            playbackLibraryAccessProblem(AuthPhase.RESTORING, updateRestoring = false, updateRequired = false))
        assertEquals(PlaybackLibraryProblem.UNAVAILABLE,
            playbackLibraryAccessProblem(AuthPhase.AUTHENTICATED, updateRestoring = true, updateRequired = false))
        assertEquals(PlaybackLibraryProblem.UNAVAILABLE,
            playbackLibraryAccessProblem(AuthPhase.RECOVERY_REQUIRED, updateRestoring = false, updateRequired = false))
        assertNull(playbackLibraryAccessProblem(AuthPhase.AUTHENTICATED, updateRestoring = false, updateRequired = false))
    }

    @Test fun accountIdentityAndEpochMustBothMatchBeforeReturningMedia() {
        val expected = ProcessingSession("owner", 4)
        assertTrue(playbackLibraryOwnerMatches(expected, "owner", expected))
        assertFalse(playbackLibraryOwnerMatches(expected, null, expected))
        assertFalse(playbackLibraryOwnerMatches(expected, "another", expected))
        assertFalse(playbackLibraryOwnerMatches(expected, "owner", null))
        assertFalse(playbackLibraryOwnerMatches(expected, "owner", ProcessingSession("owner", 5)))
        assertFalse(playbackLibraryOwnerMatches(expected, "owner", ProcessingSession("another", 4)))
    }

    @Test fun technicalFailuresUseSafeLocalizedMessagesAndRetainTypedGateErrors() {
        listOf(IOException("private file path"), IllegalStateException("account details"),
            Exception("provider diagnostics")).forEach { error ->
            val problem = playbackLibraryFailureProblem(error)
            assertEquals(PlaybackLibraryProblem.UNAVAILABLE, problem)
            assertEquals(R.string.auto_library_unavailable, problem.messageResource)
        }
        assertEquals(PlaybackLibraryProblem.BAD_REQUEST,
            playbackLibraryFailureProblem(IllegalArgumentException("external media ID")))
        assertEquals(PlaybackLibraryProblem.UPDATE_REQUIRED,
            playbackLibraryFailureProblem(PlaybackLibraryFailure(PlaybackLibraryProblem.UPDATE_REQUIRED)))
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test fun stalledCatalogReturnsUnavailableWithinFiveSeconds() = runTest {
        val problem = playbackLibraryRequest({ playbackLibraryFailureProblem(it) }) {
            delay(10_000)
            PlaybackLibraryProblem.BAD_REQUEST
        }
        assertEquals(PlaybackLibraryProblem.UNAVAILABLE, problem)
        assertEquals(5000L, testScheduler.currentTime)
    }

    @Test fun cancelledControllerRequestDoesNotEmitAnAvailabilityError() = runTest {
        val cancelled = CancellationException("Controller disconnected")
        var errorDelivered = false
        try {
            playbackLibraryRequest({ errorDelivered = true; Unit }) { throw cancelled }
            fail("Expected cancellation")
        } catch (error: CancellationException) {
            assertEquals(cancelled.message, error.message)
        }
        assertFalse(errorDelivered)
    }
}
