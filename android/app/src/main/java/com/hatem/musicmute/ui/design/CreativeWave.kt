package com.hatem.musicmute.ui.design

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import kotlin.math.PI
import kotlin.math.sin

/** Decorative art, never a claim about measured audio samples. */
@Composable
fun CreativeWave(
    modifier: Modifier = Modifier,
    active: Boolean = true,
    intensity: Float = 0.5f,
) {
    val enabled = rememberCreativeMotionEnabled(active)
    val phase = if (enabled) {
        rememberInfiniteTransition(label = "creative-wave").animateFloat(
            initialValue = 0f,
            targetValue = (2 * PI).toFloat(),
            animationSpec = infiniteRepeatable(tween(CreativeMotion.WAVE_MS, easing = LinearEasing), RepeatMode.Restart),
            label = "wave-phase",
        )
    } else remember { mutableFloatStateOf(0f) }
    val paths = remember { List(3) { Path() } }
    val color = MaterialTheme.colorScheme.primary
    val strength = if (intensity.isFinite()) intensity.coerceIn(0f, 1f) else 0.5f
    Canvas(modifier.height(84.dp).clearAndSetSemantics { }) {
        val angle = phase.value // Read only in drawing; no screen-wide per-frame recomposition.
        paths.forEachIndexed { layer, path ->
            path.reset()
            val samples = 96
            for (sample in 0..samples) {
                val x = size.width * sample / samples
                val position = sample.toFloat() / samples
                val envelope = sin(position * PI).toFloat()
                val oscillation = sin(position * 3 * PI + angle + layer * 0.65).toFloat()
                val y = size.height * 0.5f + oscillation * envelope * size.height * (0.1f + strength * 0.18f)
                if (sample == 0) path.moveTo(x, y) else path.lineTo(x, y)
            }
            drawPath(path, color.copy(alpha = 0.7f - layer * 0.2f), style = Stroke((2.4f - layer * 0.5f).dp.toPx()))
        }
    }
}
