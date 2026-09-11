package com.hatem.musicmute.auth

import android.app.Activity
import android.content.Context
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.firebase.auth.AuthCredential
import com.google.firebase.auth.GoogleAuthProvider
import kotlinx.coroutines.CancellationException

class GoogleCredentialProvider(private val context: Context) {
    suspend fun credential(activity: Activity): AuthCredential {
        AuthProviderOverrides.googleCredential(activity)?.let {
            return it
        }
        val resource =
            context.resources.getIdentifier("default_web_client_id", "string", context.packageName)
        if (resource == 0) throw AuthFailure(AuthProblem.CONFIGURATION)
        val clientId = context.getString(resource)
        if (clientId.isBlank() || activity.isDestroyed || activity.isFinishing)
            throw AuthFailure(AuthProblem.CONFIGURATION)
        return try {
            val option = GetSignInWithGoogleOption.Builder(clientId).build()
            val result =
                CredentialManager.create(activity)
                    .getCredential(
                        activity,
                        GetCredentialRequest.Builder().addCredentialOption(option).build(),
                    )
            if (activity.isDestroyed || activity.isFinishing)
                throw CancellationException("Activity changed")
            val credential = result.credential
            if (
                credential !is CustomCredential ||
                    credential.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL
            )
                throw AuthFailure(AuthProblem.INVALID_CREDENTIALS)
            val google = GoogleIdTokenCredential.createFrom(credential.data)
            GoogleAuthProvider.getCredential(google.idToken, null)
        } catch (_: GetCredentialCancellationException) {
            throw AuthFailure(AuthProblem.CANCELLED)
        } catch (_: NoCredentialException) {
            throw AuthFailure(AuthProblem.INVALID_CREDENTIALS)
        } catch (_: GetCredentialException) {
            throw AuthFailure(AuthProblem.CONFIGURATION)
        } catch (_: IllegalArgumentException) {
            throw AuthFailure(AuthProblem.INVALID_CREDENTIALS)
        }
    }

    suspend fun clearSession() {
        try {
            CredentialManager.create(context).clearCredentialState(ClearCredentialStateRequest())
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            /* Firebase sign-out remains effective if a credential provider is unavailable. */
        }
    }
}
