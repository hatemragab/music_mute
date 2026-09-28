package com.hatem.musicmute.playback

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews
import androidx.core.content.ContextCompat
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.hatem.musicmute.MainActivity
import com.hatem.musicmute.R
import com.hatem.musicmute.VocalApplication
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class PlaybackWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = render(context)
    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) = render(context)

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action !in setOf(TOGGLE, NEXT)) return
        val app = context.applicationContext as VocalApplication
        val pending = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate).launch {
            var future: com.google.common.util.concurrent.ListenableFuture<MediaController>? = null
            try {
                withTimeout(8000) {
                    app.updateCoordinator.state.first { !it.restoring }
                    if (app.updateAdmission.isBlocked()) return@withTimeout
                    val expected = app.processingSessions.first { it != null }!!
                    val connection = MediaController.Builder(context, SessionToken(context, ComponentName(context, AudioPlaybackService::class.java))).buildAsync()
                    future = connection
                    val player = suspendCancellableCoroutine<MediaController> { continuation ->
                        connection.addListener({
                            try { if (continuation.isActive) continuation.resume(connection.get()) }
                            catch (error: Exception) { if (continuation.isActive) continuation.resumeWithException(error) }
                        }, ContextCompat.getMainExecutor(context))
                    }
                    if (app.processingSession() != expected || app.updateAdmission.isBlocked()) return@withTimeout
                    if (intent.action == NEXT) player.seekToNextMediaItem()
                    else if (player.playWhenReady) player.pause() else {
                        if (player.mediaItemCount > 0 && player.playbackState == androidx.media3.common.Player.STATE_IDLE) player.prepare()
                        player.play()
                    }
                    // Keep the controller alive while Media3 handles the transport request.
                    delay(300)
                }
            } catch (_: Exception) { /* Tap the title to open Player for recovery. */ }
            finally { future?.let(MediaController::releaseFuture); pending.finish() }
        }
    }

    companion object {
        private const val TOGGLE = "com.hatem.musicmute.widget.TOGGLE"
        private const val NEXT = "com.hatem.musicmute.widget.NEXT"
        private var title: String? = null
        private var titleOwner: String? = null
        private var playing = false

        fun update(context: Context, trackTitle: String?, isPlaying: Boolean) {
            title = trackTitle; playing = isPlaying
            titleOwner = (context.applicationContext as VocalApplication).processingSession()?.uid
            render(context)
        }

        private fun render(context: Context) {
            val app = context.applicationContext as VocalApplication
            val available = app.processingSession() != null && !app.updateAdmission.isBlocked()
            val manager = AppWidgetManager.getInstance(context)
            manager.getAppWidgetIds(ComponentName(context, PlaybackWidget::class.java)).forEach { id ->
                val views = RemoteViews(context.packageName, R.layout.playback_widget)
                views.setTextViewText(R.id.widget_title, if (available) title?.takeIf { titleOwner == app.processingSession()?.uid } ?: context.getString(R.string.listen_widget_empty) else context.getString(R.string.listen_widget_sign_in))
                views.setTextViewText(R.id.widget_toggle, context.getString(if (playing && available) R.string.creative_library_pause else R.string.creative_library_play))
                views.setOnClickPendingIntent(R.id.widget_title, MainActivity.playerPendingIntent(context))
                views.setOnClickPendingIntent(R.id.widget_art, MainActivity.playerPendingIntent(context))
                views.setOnClickPendingIntent(R.id.widget_import, MainActivity.entryPendingIntent(context, "IMPORT_AUDIO"))
                for ((view, action) in listOf(R.id.widget_toggle to TOGGLE, R.id.widget_next to NEXT)) {
                    views.setOnClickPendingIntent(view, if (available) PendingIntent.getBroadcast(context, view,
                        Intent(context, PlaybackWidget::class.java).setAction(action), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                        else MainActivity.playerPendingIntent(context))
                }
                val height = manager.getAppWidgetOptions(id).getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT)
                views.setViewVisibility(R.id.widget_import, if (height >= 168) View.VISIBLE else View.GONE)
                manager.updateAppWidget(id, views)
            }
        }
    }
}
