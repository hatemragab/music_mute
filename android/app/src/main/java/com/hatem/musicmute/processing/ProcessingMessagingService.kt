package com.hatem.musicmute.processing

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.hatem.musicmute.BuildConfig
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

const val PROCESSING_NOTIFICATION_CHANNEL = "audio_processing_outcomes"

interface ProcessingPushHost { val processingPush: PushRegistrationCoordinator }

/** Call during application startup, before requesting a token or receiving system notifications. */
fun createProcessingNotificationChannel(context: Context, name: String = "Audio processing") {
    context.getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(PROCESSING_NOTIFICATION_CHANNEL, name, NotificationManager.IMPORTANCE_DEFAULT))
}

fun processingNotificationsPermitted(context: Context): Boolean =
    context.getSystemService(NotificationManager::class.java).areNotificationsEnabled()

fun processingPushEnabled(): Boolean = BuildConfig.AUTH_EMULATOR_HOST.isBlank()

/** AuthE2e must never ask the real default Firebase project for a messaging token. */
suspend fun firebaseProcessingToken(): String? {
    if (!processingPushEnabled()) return null
    val app = FirebaseApp.getInstance()
    if (app.options.projectId?.startsWith("demo-") == true) return null
    val messaging = FirebaseMessaging.getInstance()
    messaging.isAutoInitEnabled = true
    return suspendCancellableCoroutine { continuation ->
        messaging.token.addOnCompleteListener { result ->
            if (continuation.isActive) continuation.resume(if (result.isSuccessful) result.result else null)
        }
    }
}

fun processingNotificationData(intent: Intent?): Map<String, String> = try {
    listOf("type", "jobId", "eventId", "outcome").mapNotNull { key ->
        intent?.getStringExtra(key)?.let { key to it }
    }.toMap()
} catch (_: RuntimeException) { emptyMap() }

class ProcessingMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        if (processingPushEnabled()) (application as? ProcessingPushHost)?.processingPush?.onToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        if (processingPushEnabled()) (application as? ProcessingPushHost)?.processingPush?.onMessage(message.data)
        // Background notification+data is displayed by FCM; foreground receives only a refresh hint.
        // Never construct a second local notification or a second PendingIntent for this message.
    }
}
