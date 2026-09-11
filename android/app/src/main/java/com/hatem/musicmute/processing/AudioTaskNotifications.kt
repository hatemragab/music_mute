package com.hatem.musicmute.processing

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.text.format.Formatter
import androidx.core.app.NotificationCompat
import androidx.work.ForegroundInfo
import com.hatem.musicmute.MainActivity
import com.hatem.musicmute.R
import java.security.MessageDigest

private const val TRANSFER_CHANNEL = "audio-task-transfers"

data class AudioTaskNotificationProjection(
    val title: String,
    val stage: AudioTaskStage,
    val percent: Int?,
    val transferredBytes: Long?,
    val totalBytes: Long?,
    val ongoing: Boolean,
    val canCancel: Boolean,
    val group: String,
    val silent: Boolean = true,
    val channelId: String = TRANSFER_CHANNEL,
)

fun audioTaskNotificationProjection(
    operation: ProcessingOperation,
    target: AudioTaskNotificationTarget,
    stage: AudioTaskStage? = null,
    transferredBytes: Long? = operation.uploadedBytes,
    totalBytes: Long? = operation.input?.bytes,
): AudioTaskNotificationProjection {
    val task = audioTaskPresentations(listOf(operation.copy(pendingDelete = false)), emptyList(), operation.acceptedAtMillis).single()
    val actualStage = stage ?: task.stage
    val transfer = actualStage == AudioTaskStage.DOWNLOADING_SOURCE || actualStage == AudioTaskStage.UPLOADING_INPUT
    val received = transferredBytes?.coerceAtLeast(0)?.takeIf { transfer }
    val total = totalBytes?.takeIf { it > 0 && transfer }
    val percent = if (received != null && total != null)
        (received.toDouble() / total * 100).toInt().coerceIn(0, 100) else null
    val active = !operation.pendingDelete && actualStage !in setOf(AudioTaskStage.REVIEW, AudioTaskStage.READY, AudioTaskStage.FAILED, AudioTaskStage.CANCELLED, AudioTaskStage.UNKNOWN)
    return AudioTaskNotificationProjection(
        title = task.displayName,
        stage = actualStage,
        percent = percent,
        transferredBytes = received,
        totalBytes = total,
        ongoing = active,
        canCancel = active && actualStage != AudioTaskStage.CANCELLING && !operation.cancellationRequested,
        group = audioTaskNotificationGroup(target.ownerUid),
    )
}

fun audioTaskFailureNotificationProjection(operation: ProcessingOperation, target: AudioTaskNotificationTarget) =
    audioTaskNotificationProjection(operation, target, stage = AudioTaskStage.FAILED)
        .copy(silent = false, channelId = PROCESSING_NOTIFICATION_CHANNEL)

private fun notificationHash(value: String): String = MessageDigest.getInstance("SHA-256")
    .digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

fun audioTaskNotificationGroup(ownerUid: String): String = "audio-tasks-${notificationHash(ownerUid)}"

fun audioTaskNotificationId(target: AudioTaskNotificationTarget): Int =
    // Download handoff may start upload before its own foreground worker exits.
    // Separate IDs prevent WorkManager stopping one notification from hiding the other.
    notificationHash("${target.ownerUid}\u0000${target.operationId}\u0000${target.epoch}\u0000${target.transferKind}\u0000${target.workRequestId.orEmpty()}")
        .take(8).toLong(16).toInt() and Int.MAX_VALUE

/** Progress may arrive many times per second; phase and rename changes are immediate. */
class AudioTaskNotificationThrottle {
    private var previous: AudioTaskNotificationProjection? = null
    private var lastUpdateMillis = 0L

    fun shouldUpdate(value: AudioTaskNotificationProjection, nowMillis: Long): Boolean {
        val old = previous
        if (old == value) return false
        if (old != null && old.stage == value.stage && old.title == value.title &&
            old.canCancel == value.canCancel && nowMillis - lastUpdateMillis < 1_000) return false
        previous = value
        lastUpdateMillis = nowMillis
        return true
    }
}

/** WorkManager owns the foreground service; this class only projects its notification. */
class AudioTaskNotifications(private val context: Context) {
    private val manager = context.getSystemService(NotificationManager::class.java)

    fun foreground(target: AudioTaskNotificationTarget, projection: AudioTaskNotificationProjection): ForegroundInfo {
        val notification = build(target, projection)
        val id = audioTaskNotificationId(target)
        return if (Build.VERSION.SDK_INT >= 29)
            ForegroundInfo(id, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else ForegroundInfo(id, notification)
    }

    fun updateIfVisible(target: AudioTaskNotificationTarget, projection: AudioTaskNotificationProjection) {
        val id = audioTaskNotificationId(target)
        // Android 14 lets users dismiss ongoing notifications. Never recreate a
        // dismissed progress notification in a timer/progress loop.
        if (!manager.areNotificationsEnabled() || manager.activeNotifications.none { it.id == id }) return
        try {
            manager.notify(id, build(target, projection))
        } catch (_: SecurityException) {
            // Notification permission is optional and must not fail a transfer.
        }
    }

    fun sourceFailed(target: AudioTaskNotificationTarget, operation: ProcessingOperation) {
        if (!manager.areNotificationsEnabled()) return
        val outcome = target.copy(transferKind = AudioTaskTransferKind.OUTCOME)
        try {
            manager.notify(audioTaskNotificationId(outcome), build(outcome,
                audioTaskFailureNotificationProjection(operation, outcome)))
        } catch (_: SecurityException) {
            // Failure remains visible in the app when notifications are denied.
        }
    }

    private fun build(target: AudioTaskNotificationTarget, projection: AudioTaskNotificationProjection): Notification {
        if (projection.channelId == TRANSFER_CHANNEL) {
            manager.createNotificationChannel(NotificationChannel(
                TRANSFER_CHANNEL, context.getString(R.string.download_channel), NotificationManager.IMPORTANCE_LOW,
            ).apply {
                setSound(null, null)
                enableVibration(false)
                setShowBadge(false)
            })
        } else createProcessingNotificationChannel(context, context.getString(R.string.cloud_processing_title))
        val stage = context.getString(stageLabel(projection.stage))
        val bytes = projection.transferredBytes?.let { transferred ->
            val received = Formatter.formatShortFileSize(context, transferred)
            projection.totalBytes?.let { "$received / ${Formatter.formatShortFileSize(context, it)}" } ?: received
        }
        val openIntent = Intent(context, MainActivity::class.java)
            .putExtra("open_processing", true)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        putAudioTaskNotificationTarget(openIntent, target)
        openIntent.data = Uri.parse("musicmute://audio-task/${notificationHash(target.ownerUid)}/${target.operationId}/${target.epoch}")
        val open = PendingIntent.getActivity(context, audioTaskNotificationId(target), openIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Builder(context, projection.channelId)
            .setSmallIcon(R.drawable.ic_vocal_monochrome)
            .setContentTitle(projection.title)
            .setContentText(if (bytes == null) stage else "$stage · $bytes")
            .setContentIntent(open)
            .setGroup(projection.group)
            .setGroupAlertBehavior(if (projection.silent) NotificationCompat.GROUP_ALERT_SUMMARY else NotificationCompat.GROUP_ALERT_ALL)
            .setOnlyAlertOnce(true)
            .setSilent(projection.silent)
            .setOngoing(projection.ongoing)
            .setAutoCancel(!projection.ongoing)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setProgress(if (projection.ongoing) 100 else 0, projection.percent ?: 0,
                projection.ongoing && projection.percent == null)
            .apply {
                if (projection.canCancel) addAction(0, context.getString(R.string.audio_task_cancel),
                    audioTaskCancelPendingIntent(context, target))
            }
            .build()
    }

    private fun stageLabel(stage: AudioTaskStage): Int = when (stage) {
        AudioTaskStage.WAITING -> R.string.audio_task_waiting
        AudioTaskStage.DOWNLOADING_SOURCE -> R.string.downloading
        AudioTaskStage.PREPARING_INPUT -> R.string.processing_preparing
        AudioTaskStage.RESERVING_JOB -> R.string.audio_task_reserving
        AudioTaskStage.UPLOADING_INPUT -> R.string.processing_uploading
        AudioTaskStage.CONFIRMING_UPLOAD -> R.string.audio_task_confirming
        AudioTaskStage.QUEUED -> R.string.processing_queued
        AudioTaskStage.VALIDATING -> R.string.processing_validating
        AudioTaskStage.PROCESSING -> R.string.processing_processing
        AudioTaskStage.UPLOADING_RESULT -> R.string.processing_uploading_result
        AudioTaskStage.INTERRUPTED -> R.string.processing_interrupted
        AudioTaskStage.CANCELLING -> R.string.audio_task_cancelling
        AudioTaskStage.READY -> R.string.processing_ready
        AudioTaskStage.FAILED -> R.string.processing_failed
        AudioTaskStage.CANCELLED -> R.string.processing_cancelled
        AudioTaskStage.REVIEW -> R.string.audio_review_title
        AudioTaskStage.UNKNOWN -> R.string.processing_unknown
    }
}
