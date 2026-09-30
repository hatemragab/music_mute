package com.hatem.musicmute

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context

// Separate IDs avoid reusing library channels already saved with badges enabled.
internal const val PLAYBACK_NOTIFICATION_CHANNEL = "audio-playback"
internal const val APP_UPDATE_NOTIFICATION_CHANNEL = "app-update-downloads"

internal fun createPlaybackNotificationChannel(context: Context): NotificationChannel =
    createNonBadgingNotificationChannel(
        context,
        PLAYBACK_NOTIFICATION_CHANNEL,
        context.getString(androidx.media3.session.R.string.default_notification_channel_name),
        "default_channel_id",
    )

internal fun createAppUpdateNotificationChannel(context: Context): NotificationChannel =
    createNonBadgingNotificationChannel(
        context,
        APP_UPDATE_NOTIFICATION_CHANNEL,
        context.getString(R.string.update_available_title),
        "appUpdate",
    )

internal fun createNonBadgingNotificationChannel(
    context: Context,
    id: String,
    name: String,
    legacyId: String,
): NotificationChannel {
    val manager = context.getSystemService(NotificationManager::class.java)
    val channel = manager.getNotificationChannel(id) ?: run {
        val legacy = manager.getNotificationChannel(legacyId)
        NotificationChannel(id, name, legacy?.importance ?: NotificationManager.IMPORTANCE_LOW).apply {
            setShowBadge(false)
            if (legacy != null) {
                // Carry notification preferences forward, especially an explicitly blocked channel.
                setSound(legacy.sound, legacy.audioAttributes)
                vibrationPattern = legacy.vibrationPattern
                enableVibration(legacy.shouldVibrate())
                enableLights(legacy.shouldShowLights())
                lightColor = legacy.lightColor
                lockscreenVisibility = legacy.lockscreenVisibility
                group = legacy.group
            }
        }
    }
    // Later calls retain this channel's saved preferences rather than re-importing the legacy ones.
    channel.name = name
    manager.createNotificationChannel(channel)
    return channel
}
