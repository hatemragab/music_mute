package com.hatem.musicmute.playback

import androidx.annotation.StringRes
import androidx.media3.session.SessionError
import com.hatem.musicmute.R
import com.hatem.musicmute.auth.AuthPhase
import com.hatem.musicmute.processing.ProcessingSession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
internal enum class PlaybackLibraryProblem(val code: @SessionError.Code Int, @param:StringRes val messageResource: Int) {
    SIGN_IN_REQUIRED(SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED, R.string.auto_sign_in_required),
    UPDATE_REQUIRED(SessionError.ERROR_SESSION_SETUP_REQUIRED, R.string.auto_update_required),
    UNAVAILABLE(SessionError.ERROR_IO, R.string.auto_library_unavailable),
    BAD_REQUEST(SessionError.ERROR_BAD_VALUE, R.string.auto_audio_unavailable),
}

internal class PlaybackLibraryFailure(val problem: PlaybackLibraryProblem) :
    IllegalStateException("Media access unavailable")

/** Restoration and account recovery never grant access to a previous account's media. */
internal fun playbackLibraryAccessProblem(
    phase: AuthPhase,
    updateRestoring: Boolean,
    updateRequired: Boolean,
): PlaybackLibraryProblem? = when {
    updateRequired -> PlaybackLibraryProblem.UPDATE_REQUIRED
    updateRestoring || phase == AuthPhase.RESTORING -> PlaybackLibraryProblem.UNAVAILABLE
    phase == AuthPhase.SIGNED_OUT || phase == AuthPhase.BOOTSTRAP_REQUIRED -> PlaybackLibraryProblem.SIGN_IN_REQUIRED
    phase != AuthPhase.AUTHENTICATED -> PlaybackLibraryProblem.UNAVAILABLE
    else -> null
}

internal fun playbackLibraryOwnerMatches(
    expected: ProcessingSession,
    authenticatedUid: String?,
    current: ProcessingSession?,
): Boolean = authenticatedUid == expected.uid && current == expected

/** Technical exceptions and provider diagnostics are never used as car-facing copy. */
internal fun playbackLibraryFailureProblem(error: Exception): PlaybackLibraryProblem = when (error) {
    is PlaybackLibraryFailure -> error.problem
    is IllegalArgumentException -> PlaybackLibraryProblem.BAD_REQUEST
    else -> PlaybackLibraryProblem.UNAVAILABLE
}

/** A stalled restoration/catalog returns an error, while controller/service cancellation stays cancellation. */
internal suspend fun <T> playbackLibraryRequest(
    onFailure: (Exception) -> T,
    block: suspend () -> T,
): T = try {
    withTimeout(5000) { block() }
} catch (error: TimeoutCancellationException) {
    onFailure(error)
} catch (error: CancellationException) {
    throw error
} catch (error: Exception) {
    onFailure(error)
}
