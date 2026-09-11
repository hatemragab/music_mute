package com.hatem.musicmute.auth

import android.app.Activity
import com.google.firebase.auth.AuthCredential

internal object AuthProviderOverrides {
    suspend fun googleCredential(activity: Activity): AuthCredential? = null
}
