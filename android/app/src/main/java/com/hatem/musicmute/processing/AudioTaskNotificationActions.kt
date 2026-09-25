package com.hatem.musicmute.processing

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import com.hatem.musicmute.VocalApplication
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

private const val ACTION_CANCEL = "com.hatem.musicmute.CANCEL_AUDIO_TASK"
private const val OWNER = "audio_task_owner"
private const val OPERATION = "audio_task_operation"
private const val EPOCH = "audio_task_epoch"
private const val JOB = "audio_task_job"
private const val TRANSFER = "audio_task_transfer"
private const val WORK = "audio_task_work"

enum class AudioTaskTransferKind { SOURCE, UPLOAD, OUTCOME }

data class AudioTaskNotificationTarget(
    val ownerUid: String,
    val operationId: String,
    val epoch: Long,
    val jobId: String? = null,
    val transferKind: AudioTaskTransferKind = AudioTaskTransferKind.UPLOAD,
    val workRequestId: String? = null,
) {
    fun matches(session: ProcessingSession?): Boolean =
        session != null && ownerUid == session.uid && epoch == session.epoch
}

internal fun putAudioTaskNotificationTarget(intent: Intent, target: AudioTaskNotificationTarget) {
    intent.putExtra(OWNER, target.ownerUid).putExtra(OPERATION, target.operationId)
        .putExtra(EPOCH, target.epoch).putExtra(JOB, target.jobId).putExtra(TRANSFER, target.transferKind.name)
        .putExtra(WORK, target.workRequestId)
}

fun audioTaskNotificationTarget(intent: Intent?, session: ProcessingSession?): AudioTaskNotificationTarget? = try {
    val owner = intent?.getStringExtra(OWNER)
    val operation = intent?.getStringExtra(OPERATION)
    if (owner.isNullOrBlank() || operation == null || !intent.hasExtra(EPOCH)) null
    else {
        val parsed = UUID.fromString(operation)
        if (!parsed.toString().equals(operation, ignoreCase = true)) null
        else AudioTaskNotificationTarget(owner, operation, intent.getLongExtra(EPOCH, Long.MIN_VALUE),
            intent.getStringExtra(JOB), AudioTaskTransferKind.entries.firstOrNull {
                it.name == intent.getStringExtra(TRANSFER)
            } ?: AudioTaskTransferKind.UPLOAD, intent.getStringExtra(WORK)).takeIf { it.matches(session) }
    }
} catch (_: RuntimeException) { null }

internal fun audioTaskCancelPendingIntent(context: Context, target: AudioTaskNotificationTarget): PendingIntent {
    val intent = Intent(context, AudioTaskNotificationActions::class.java).setAction(ACTION_CANCEL)
    putAudioTaskNotificationTarget(intent, target)
    intent.data = Uri.parse("musicmute://cancel-audio/${audioTaskNotificationGroup(target.ownerUid)}/${target.operationId}/${target.epoch}")
    return PendingIntent.getBroadcast(context, audioTaskNotificationId(target), intent,
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
}

/** Private explicit receiver. An old account/session's notification has no authority. */
class AudioTaskNotificationActions : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_CANCEL) return
        val app = context.applicationContext as? VocalApplication ?: return
        if (app.updateAdmission.isBlocked()) return
        val target = audioTaskNotificationTarget(intent, app.processingSession()) ?: return
        val pending = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                // Persisted cancellation survives when backend acknowledgement
                // takes longer than a broadcast receiver's execution allowance.
                withTimeoutOrNull(8_000) {
                    if (!target.matches(app.processingSession())) return@withTimeoutOrNull
                    val operation = app.processingRepository.store.get(target.ownerUid, target.operationId)
                        ?: return@withTimeoutOrNull
                    if (operation.pendingDelete || !target.matches(app.processingSession())) return@withTimeoutOrNull
                    app.audioPipelineCoordinator.cancel(target.operationId)
                }
            } catch (_: Exception) {
                // The durable task keeps its reconciliation state; no raw error
                // or account information is emitted by a notification action.
            } finally {
                pending.finish()
            }
        }
    }
}
