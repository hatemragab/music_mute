package com.hatem.musicmute.auth

import android.app.Activity
import android.app.AlertDialog
import com.google.firebase.auth.AuthCredential
import com.google.firebase.auth.GoogleAuthProvider
import com.hatem.musicmute.R
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

/**
 * Synthetic identity accepted only by the isolated Auth emulator; absent from Debug and Release.
 */
internal object AuthProviderOverrides {
    suspend fun googleCredential(activity: Activity): AuthCredential =
        withContext(Dispatchers.Main.immediate) {
            if (activity.isDestroyed || activity.isFinishing)
                throw AuthFailure(AuthProblem.CANCELLED)
            // No selection is cached: every attempt, including after logout, shows the picker.
            val emails = arrayOf("musicmute-google@example.test", "musicmute-google-2@example.test")
            val subjects = arrayOf("musicmute-google-e2e", "musicmute-google-e2e-2")
            suspendCancellableCoroutine { continuation ->
                val dialog =
                    AlertDialog.Builder(activity)
                        .setTitle(R.string.auth_test_choose_google_account)
                        .setItems(emails) { _, index ->
                            if (continuation.isActive) {
                                continuation.resume(
                                    GoogleAuthProvider.getCredential(
                                        """{"sub":"${subjects[index]}","email":"${emails[index]}","email_verified":true,"name":"E2E Listener ${index + 1}"}""",
                                        null,
                                    )
                                )
                            }
                        }
                        .setNegativeButton(android.R.string.cancel) { _, _ -> }
                        .create()
                dialog.setOnDismissListener {
                    if (continuation.isActive)
                        continuation.resumeWithException(AuthFailure(AuthProblem.CANCELLED))
                }
                continuation.invokeOnCancellation { activity.runOnUiThread { dialog.dismiss() } }
                if (continuation.isActive) dialog.show()
            }
        }
}
