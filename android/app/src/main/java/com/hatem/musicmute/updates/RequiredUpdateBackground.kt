package com.hatem.musicmute.updates

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.ui.VocalTheme

/** Stays mounted behind the native dialog and installation recovery prompts. */
@Composable
internal fun RequiredUpdateBackground() {
    val colors = MaterialTheme.colorScheme
    Column(
        modifier =
            Modifier.fillMaxSize()
                .background(Brush.verticalGradient(listOf(colors.primaryContainer, colors.background)))
                .safeDrawingPadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Image(
            painter = painterResource(R.drawable.ic_vocal),
            contentDescription = null,
            modifier = Modifier.size(72.dp).clip(RoundedCornerShape(20.dp)),
        )
        Text(
            text = stringResource(R.string.app_name),
            style = MaterialTheme.typography.headlineMedium,
            color = colors.onPrimaryContainer,
            textAlign = TextAlign.Center,
        )
        Text(
            text = stringResource(R.string.update_background_title),
            style = MaterialTheme.typography.titleLarge,
            color = colors.onPrimaryContainer,
            textAlign = TextAlign.Center,
        )
        Text(
            text = stringResource(R.string.update_background_message),
            style = MaterialTheme.typography.bodyLarge,
            color = colors.onPrimaryContainer,
            textAlign = TextAlign.Center,
        )
    }
}

@Preview(name = "Required update · light", showBackground = true)
@Composable
private fun RequiredUpdateBackgroundLightPreview() {
    VocalTheme(dark = false) { RequiredUpdateBackground() }
}

@Preview(name = "Required update · dark", showBackground = true)
@Composable
private fun RequiredUpdateBackgroundDarkPreview() {
    VocalTheme(dark = true) { RequiredUpdateBackground() }
}

@Preview(name = "Required update · Arabic large text", locale = "ar", fontScale = 1.5f)
@Composable
private fun RequiredUpdateBackgroundArabicPreview() {
    VocalTheme(dark = true) { RequiredUpdateBackground() }
}
