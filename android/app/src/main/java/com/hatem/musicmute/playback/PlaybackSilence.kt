package com.hatem.musicmute.playback

import android.content.Context
import androidx.media3.common.audio.SonicAudioProcessor
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.audio.SilenceSkippingAudioProcessor

/** Keep natural speech pauses and quiet syllables; only shorten sustained near-silence. */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
internal fun gentleSilenceProcessor() = SilenceSkippingAudioProcessor(
    // Media3 1.8 sizes its silence buffer in frames instead of bytes. This nominal
    // duration preserves at least 1 second in stereo and 2 seconds in mono PCM16.
    // Exercise real PCM in PlaybackSilenceTest when changing the Media3 version.
    /* minimumSilenceDurationUs = */ 4_000_000L,
    /* silenceRetentionRatio = */ 0.5f,
    /* maxSilenceToKeepDurationUs = */ 2_000_000L,
    /* minVolumeToKeepPercentageWhenMuting = */ 100,
    /* silenceThresholdLevel = */ 256.toShort(),
)

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
internal class ListeningRenderersFactory(context: Context) : DefaultRenderersFactory(context) {
    override fun buildAudioSink(
        context: Context,
        enableFloatOutput: Boolean,
        enableAudioTrackPlaybackParams: Boolean,
    ): AudioSink = DefaultAudioSink.Builder(context)
        .setEnableFloatOutput(enableFloatOutput)
        .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
        .setAudioProcessorChain(
            DefaultAudioSink.DefaultAudioProcessorChain(
                emptyArray(), gentleSilenceProcessor(), SonicAudioProcessor(),
            ),
        )
        .build()
}
