package com.hatem.musicmute.ui.home

import android.os.SystemClock
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.processing.AudioTaskPresentation
import com.hatem.musicmute.processing.AudioTaskStage
import com.hatem.musicmute.ui.audioTaskStageLabel
import com.hatem.musicmute.ui.design.rememberCreativeMotionEnabled
import kotlinx.coroutines.delay
import kotlin.math.exp
import kotlin.math.roundToInt

private const val ESTIMATED_PROGRESS_START = 0.08f
private const val ESTIMATED_PROGRESS_CAP = 0.94f
private const val ESTIMATED_PROGRESS_TICK_MS = 300L

internal data class JobCardStageProgressValue(val fraction: Float, val estimated: Boolean)

/** Visual pacing only: these defaults are neither completion forecasts nor server stage timings. */
internal fun jobCardStagePacingMs(stage: AudioTaskStage): Long? = when (stage) {
    AudioTaskStage.DOWNLOADING_SOURCE -> 15_000L
    AudioTaskStage.INSPECTING -> 5_000L
    AudioTaskStage.PREPARING_INPUT -> 20_000L
    AudioTaskStage.RESERVING_JOB -> 4_000L
    AudioTaskStage.UPLOADING_INPUT -> 20_000L
    AudioTaskStage.CONFIRMING_UPLOAD -> 4_000L
    AudioTaskStage.VALIDATING -> 8_000L
    AudioTaskStage.PROCESSING -> 45_000L
    AudioTaskStage.UPLOADING_RESULT -> 12_000L
    else -> null
}

/** A bounded estimate stays below completion until a genuine stage change arrives. */
internal fun jobCardEstimatedProgress(task: AudioTaskPresentation, localElapsedMs: Long): Float? {
    if (!task.active || task.workerAvailable == false || task.problem != null ||
        task.localProblem != null || task.errorCode != null) return null
    val pacingMs = jobCardStagePacingMs(task.stage) ?: return null
    val elapsed = localElapsedMs.coerceAtLeast(0).toDouble()
    val advanced = 1.0 - exp(-elapsed / pacingMs)
    return (ESTIMATED_PROGRESS_START + (ESTIMATED_PROGRESS_CAP - ESTIMATED_PROGRESS_START) * advanced)
        .toFloat().coerceIn(ESTIMATED_PROGRESS_START, ESTIMATED_PROGRESS_CAP)
}

/** Measured upload bytes/server phase progress always replaces an estimate. */
internal fun jobCardStageProgressValue(task: AudioTaskPresentation, localElapsedMs: Long): JobCardStageProgressValue? =
    jobCardProgress(task)?.let { JobCardStageProgressValue(it, estimated = false) }
        ?: jobCardEstimatedProgress(task, localElapsedMs)?.let { JobCardStageProgressValue(it, estimated = true) }

@Composable
internal fun JobStageProgress(task: AudioTaskPresentation, modifier: Modifier = Modifier) {
    // Import identity remains stable when acquisition turns into a server-backed job.
    val taskIdentity = task.importRequestId ?: task.operationId ?: task.jobId ?: task.createdAtMillis
    var localElapsedMs by remember(taskIdentity, task.stage) { mutableLongStateOf(0L) }
    val measured = jobCardProgress(task)
    val canEstimate = jobCardEstimatedProgress(task, 0L) != null
    val motionEnabled = rememberCreativeMotionEnabled(task.active && task.workerAvailable != false)
    val advanceEstimate = measured == null && canEstimate && motionEnabled
    LaunchedEffect(taskIdentity, task.stage, advanceEstimate) {
        if (!advanceEstimate) return@LaunchedEffect
        val pacingMs = jobCardStagePacingMs(task.stage) ?: return@LaunchedEffect
        // Six pacing periods already display ~94%; stop ticking rather than suggest completion.
        val maximumElapsedMs = pacingMs * 6
        var lastTick = SystemClock.elapsedRealtime()
        while (localElapsedMs < maximumElapsedMs) {
            delay(ESTIMATED_PROGRESS_TICK_MS)
            val now = SystemClock.elapsedRealtime()
            localElapsedMs = (localElapsedMs + (now - lastTick).coerceAtLeast(0)).coerceAtMost(maximumElapsedMs)
            lastTick = now
        }
    }
    val value = jobCardStageProgressValue(task, localElapsedMs)
    val trackColor = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.72f)
    if (value == null) {
        Box(modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(3.dp)).background(trackColor)
            .clearAndSetSemantics { })
        return
    }
    val stageLabel = stringResource(audioTaskStageLabel(task.stage))
    val percentage = (value.fraction * 100).roundToInt()
    val description = stringResource(
        if (value.estimated) R.string.job_card_progress_estimated else R.string.job_card_progress_measured,
        stageLabel,
        percentage,
    )
    val color = jobCardStatusColor(task.stage)
    key(taskIdentity, task.stage) {
        val animatedFraction = animateFloatAsState(
            targetValue = value.fraction,
            animationSpec = if (motionEnabled) tween(300, easing = LinearEasing) else snap(),
            label = "job-stage-progress",
        )
        Row(
            modifier.fillMaxWidth().clearAndSetSemantics { contentDescription = description },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            LinearProgressIndicator(
                progress = { animatedFraction.value },
                modifier = Modifier.weight(1f).height(4.dp).clip(RoundedCornerShape(3.dp)),
                color = color,
                trackColor = trackColor,
                drawStopIndicator = {},
            )
            Text(
                text = if (value.estimated) "~$percentage%" else "$percentage%",
                style = MaterialTheme.typography.labelSmall.copy(textDirection = TextDirection.Ltr),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
            )
        }
    }
}
