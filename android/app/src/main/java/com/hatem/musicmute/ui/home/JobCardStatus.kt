package com.hatem.musicmute.ui.home

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.Canvas
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Assignment
import androidx.compose.material.icons.automirrored.outlined.FactCheck
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material.icons.outlined.Cancel
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.CloudDone
import androidx.compose.material.icons.outlined.CloudDownload
import androidx.compose.material.icons.outlined.CloudUpload
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.HourglassEmpty
import androidx.compose.material.icons.outlined.PauseCircleOutline
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.hatem.musicmute.R
import com.hatem.musicmute.processing.AudioTaskPresentation
import com.hatem.musicmute.processing.AudioTaskStage
import com.hatem.musicmute.ui.audioTaskStageLabel
import com.hatem.musicmute.ui.design.rememberCreativeMotionEnabled
import com.hatem.musicmute.ui.formatElapsed
import kotlin.math.PI
import kotlin.math.sin

/** CLI-style status inside the console inset; the title owns the full header width. */
@Composable
internal fun JobCardStatus(task: AudioTaskPresentation, modifier: Modifier = Modifier) {
    val waitingForWorker = task.stage == AudioTaskStage.QUEUED && task.active && task.workerAvailable == false
    val label = stringResource(when {
        waitingForWorker -> R.string.job_card_status_worker_unavailable
        task.stage == AudioTaskStage.WAITING && task.importOnly -> R.string.job_card_status_source_queued
        task.stage == AudioTaskStage.WAITING -> R.string.job_card_status_preparing
        task.stage == AudioTaskStage.QUEUED -> R.string.job_card_status_queued
        task.stage == AudioTaskStage.UNKNOWN -> R.string.job_card_status_unknown
        else -> audioTaskStageLabel(task.stage)
    })
    val color = jobCardStatusColor(task.stage)
    val animated = rememberCreativeMotionEnabled(
        jobCardStatusCanAnimate(task.stage, task.active, task.workerAvailable),
    )
    Row(
        modifier.semantics(mergeDescendants = true) { },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        task.totalElapsedMs?.takeIf { it >= 0 }?.let { elapsedMs ->
            val elapsed = formatElapsed(elapsedMs)
            val elapsedDescription = stringResource(
                if (task.totalElapsedApproximate) R.string.job_card_status_elapsed_approximate
                else R.string.job_card_status_elapsed,
                elapsed,
            )
            Text(
                text = if (task.totalElapsedApproximate) "≈ $elapsed" else elapsed,
                modifier = Modifier.clearAndSetSemantics { contentDescription = elapsedDescription },
                style = MaterialTheme.typography.bodySmall.copy(
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Medium,
                    letterSpacing = 0.sp,
                ),
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.82f),
                maxLines = 1,
            )
            Text(
                text = "·",
                modifier = Modifier.clearAndSetSemantics { },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.outline,
            )
        }
        if (task.stage == AudioTaskStage.PROCESSING && animated) {
            StudioPulseIcon(color)
        } else {
            Icon(
                imageVector = if (waitingForWorker) Icons.Outlined.PauseCircleOutline else jobCardStatusIcon(task.stage),
                contentDescription = null,
                modifier = Modifier.size(16.dp),
                tint = color,
            )
        }
        ShimmeringJobStatusText(label, color, animated, Modifier.weight(1f))
    }
}

@Composable
private fun ShimmeringJobStatusText(
    label: String,
    highlightColor: Color,
    animated: Boolean,
    modifier: Modifier,
) {
    val shimmer = if (animated) {
        val position = rememberInfiniteTransition(label = "job-status-shimmer").animateFloat(
            initialValue = -0.45f,
            targetValue = 1.45f,
            animationSpec = infiniteRepeatable(
                animation = tween(2_400, delayMillis = 500, easing = LinearEasing),
                repeatMode = RepeatMode.Restart,
            ),
            label = "job-status-highlight",
        )
        Modifier.graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
            .drawWithContent {
                drawContent()
                // Read phase only during drawing: status motion never recomposes the card.
                val center = size.width * if (layoutDirection == LayoutDirection.Rtl) 1f - position.value else position.value
                val radius = size.width * 0.36f
                drawRect(
                    brush = Brush.linearGradient(
                        colors = listOf(Color.Transparent, highlightColor.copy(alpha = 0.95f), Color.Transparent),
                        start = Offset(center - radius, 0f),
                        end = Offset(center + radius, 0f),
                    ),
                    blendMode = BlendMode.SrcAtop,
                )
            }
    } else Modifier
    Text(
        text = label,
        modifier = modifier.then(shimmer),
        style = MaterialTheme.typography.bodySmall.copy(
            fontWeight = FontWeight.Medium,
            fontFamily = if (LocalLayoutDirection.current == LayoutDirection.Ltr) FontFamily.Monospace
                else MaterialTheme.typography.bodySmall.fontFamily,
        ),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
    )
}

@Composable
internal fun jobCardStatusColor(stage: AudioTaskStage): Color = when (stage) {
    AudioTaskStage.WAITING, AudioTaskStage.QUEUED -> Color(0xFFFFB088)
    AudioTaskStage.DOWNLOADING_SOURCE -> Color(0xFF8ECAFF)
    AudioTaskStage.REVIEW, AudioTaskStage.INSPECTING, AudioTaskStage.PREPARING_INPUT,
    AudioTaskStage.RESERVING_JOB, AudioTaskStage.UPLOADING_INPUT,
    AudioTaskStage.CONFIRMING_UPLOAD -> Color(0xFF77DCDD)
    AudioTaskStage.VALIDATING, AudioTaskStage.PROCESSING -> Color(0xFFC5B0FF)
    AudioTaskStage.UPLOADING_RESULT -> Color(0xFF8BE2C1)
    AudioTaskStage.READY -> Color(0xFF9BDD9F)
    AudioTaskStage.FAILED -> MaterialTheme.colorScheme.error
    AudioTaskStage.INTERRUPTED, AudioTaskStage.CANCELLING,
    AudioTaskStage.CANCELLED, AudioTaskStage.UNKNOWN -> MaterialTheme.colorScheme.onSurfaceVariant
}

/** Audio motion stays in this tiny draw surface, with no per-frame card recomposition. */
@Composable
private fun StudioPulseIcon(color: Color) {
    val phase = rememberInfiniteTransition(label = "studio-pulse").animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1_400, easing = LinearEasing), RepeatMode.Restart),
        label = "studio-pulse-phase",
    )
    Canvas(Modifier.size(16.dp)) {
        val barWidth = size.width / 9f
        repeat(5) { index ->
            val wave = (sin(phase.value * 2f * PI + index * 0.9f).toFloat() + 1f) / 2f
            val height = size.height * (0.28f + wave * 0.62f)
            drawRoundRect(
                color = color,
                topLeft = Offset(index * barWidth * 2f, (size.height - height) / 2f),
                size = androidx.compose.ui.geometry.Size(barWidth, height),
                cornerRadius = androidx.compose.ui.geometry.CornerRadius(barWidth / 2f),
            )
        }
    }
}

private fun jobCardStatusIcon(stage: AudioTaskStage): ImageVector = when (stage) {
    AudioTaskStage.REVIEW -> Icons.AutoMirrored.Outlined.Assignment
    AudioTaskStage.WAITING -> Icons.Outlined.Schedule
    AudioTaskStage.DOWNLOADING_SOURCE -> Icons.Outlined.CloudDownload
    AudioTaskStage.INSPECTING -> Icons.Outlined.Search
    AudioTaskStage.PREPARING_INPUT -> Icons.Outlined.Tune
    AudioTaskStage.RESERVING_JOB -> Icons.AutoMirrored.Outlined.Assignment
    AudioTaskStage.UPLOADING_INPUT, AudioTaskStage.UPLOADING_RESULT -> Icons.Outlined.CloudUpload
    AudioTaskStage.CONFIRMING_UPLOAD -> Icons.Outlined.CloudDone
    AudioTaskStage.QUEUED -> Icons.Outlined.HourglassEmpty
    AudioTaskStage.VALIDATING -> Icons.AutoMirrored.Outlined.FactCheck
    AudioTaskStage.PROCESSING -> Icons.Outlined.GraphicEq
    AudioTaskStage.INTERRUPTED -> Icons.Outlined.PauseCircleOutline
    AudioTaskStage.CANCELLING, AudioTaskStage.CANCELLED -> Icons.Outlined.Cancel
    AudioTaskStage.READY -> Icons.Outlined.CheckCircle
    AudioTaskStage.FAILED -> Icons.Outlined.ErrorOutline
    AudioTaskStage.UNKNOWN -> Icons.AutoMirrored.Outlined.HelpOutline
}
