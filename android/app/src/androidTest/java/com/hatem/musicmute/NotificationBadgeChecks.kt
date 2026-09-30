package com.hatem.musicmute

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.provider.Settings
import com.hatem.musicmute.processing.PROCESSING_NOTIFICATION_CHANNEL
import com.hatem.musicmute.processing.createProcessingNotificationChannel
import java.util.UUID

/** Opt-in framework checks; no notifications posted, media played or update downloaded. */
internal fun checkNotificationBadges(context: Context) {
    val manager = context.getSystemService(NotificationManager::class.java)
    for (create in listOf(::createPlaybackNotificationChannel, ::createAppUpdateNotificationChannel)) {
        val created = create(context)
        val saved = requireNotNull(manager.getNotificationChannel(created.id))
        check(!saved.canShowBadge()) { "${created.id} must not create a launcher dot" }
        // Re-registration must preserve the saved preference and disabled badge policy.
        create(context)
        val registered = requireNotNull(manager.getNotificationChannel(created.id))
        check(!registered.canShowBadge())
        check(registered.importance == saved.importance)
        check(registered.sound == saved.sound)
    }
    check(PLAYBACK_NOTIFICATION_CHANNEL != APP_UPDATE_NOTIFICATION_CHANNEL)
    createProcessingNotificationChannel(context)
    check(PLAYBACK_NOTIFICATION_CHANNEL != PROCESSING_NOTIFICATION_CHANNEL)
    check(APP_UPDATE_NOTIFICATION_CHANNEL != PROCESSING_NOTIFICATION_CHANNEL)
    // Outcome alerts keep their existing channel and user-controlled badge preference.
    check(manager.getNotificationChannel(PROCESSING_NOTIFICATION_CHANNEL) != null)

    // Isolated channels exercise upgrades from both blocked and customized library channels.
    for (importance in listOf(NotificationManager.IMPORTANCE_NONE, NotificationManager.IMPORTANCE_DEFAULT)) {
        val suffix = UUID.randomUUID().toString()
        val legacyId = "badge-check-legacy-$suffix"
        val id = "badge-check-$suffix"
        try {
            manager.createNotificationChannel(NotificationChannel(legacyId, "Badge check", importance).apply {
                setShowBadge(true)
                setSound(Settings.System.DEFAULT_NOTIFICATION_URI, null)
                vibrationPattern = longArrayOf(0, 100, 100, 100)
                enableVibration(true)
                enableLights(true)
                lightColor = android.graphics.Color.GREEN
                lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
            })
            val legacy = requireNotNull(manager.getNotificationChannel(legacyId))
            createNonBadgingNotificationChannel(context, id, "Badge check", legacyId)
            val migrated = requireNotNull(manager.getNotificationChannel(id))
            check(!migrated.canShowBadge())
            check(migrated.importance == legacy.importance)
            check(migrated.sound == legacy.sound)
            check(migrated.shouldVibrate() == legacy.shouldVibrate())
            check(migrated.vibrationPattern.contentEquals(legacy.vibrationPattern))
            check(migrated.shouldShowLights() == legacy.shouldShowLights())
            check(migrated.lightColor == legacy.lightColor)
            check(migrated.lockscreenVisibility == legacy.lockscreenVisibility)
            // Recreating the new channel must not reset its preferences when the old one is gone.
            manager.deleteNotificationChannel(legacyId)
            createNonBadgingNotificationChannel(context, id, "Renamed badge check", legacyId)
            val repeated = requireNotNull(manager.getNotificationChannel(id))
            check(repeated.importance == migrated.importance)
            check(repeated.sound == migrated.sound)
            check(!repeated.canShowBadge())
        } finally {
            manager.deleteNotificationChannel(id)
            manager.deleteNotificationChannel(legacyId)
        }
    }
}
