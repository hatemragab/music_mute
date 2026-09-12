package com.hatem.musicmute.playback

import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.hatem.musicmute.MainActivity
import com.hatem.musicmute.VocalApplication

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class AudioPlaybackService : MediaSessionService() {
    private var session: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        if ((application as? VocalApplication)?.updateAdmission?.isBlocked() == true) {
            stopSelf()
            return
        }
        val player =
            ExoPlayer.Builder(this).build().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(C.USAGE_MEDIA)
                        .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                        .build(),
                    true,
                )
                setHandleAudioBecomingNoisy(true)
                setWakeMode(C.WAKE_MODE_LOCAL)
            }
        session =
            MediaSession.Builder(this, player)
                .setSessionActivity(MainActivity.historyPendingIntent(this))
                .build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? =
        session.takeIf {
            (application as? VocalApplication)?.updateAdmission?.isBlocked() != true &&
                (controllerInfo.packageName == packageName || controllerInfo.isTrusted)
        }

    override fun onDestroy() {
        session?.run {
            player.release()
            release()
        }
        session = null
        super.onDestroy()
    }
}
