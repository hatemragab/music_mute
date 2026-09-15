package com.hatem.musicmute.ui.auth

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.ui.design.*
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics

@Composable
internal fun AccountHeader(title: String, onBack: () -> Unit, enabled: Boolean = true, showWave: Boolean = true) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        IconButton(onBack, enabled = enabled) {
            Icon(Icons.AutoMirrored.Outlined.ArrowBack, stringResource(R.string.back))
        }
        Text(title, Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.titleLarge)
    }
    if (showWave) CreativeWave(Modifier.fillMaxWidth().height(64.dp))
}

@Composable
internal fun AccountActionRow(
    title: String, icon: ImageVector, modifier: Modifier = Modifier,
    enabled: Boolean = true, destructive: Boolean = false, onClick: () -> Unit,
) {
    val color = (if (destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
        .copy(alpha = if (enabled) 1f else CreativeTokens.DisabledAlpha)
    Row(modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(enabled = enabled, onClick = onClick)
        .padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Icon(icon, null, tint = color)
        Text(title, Modifier.weight(1f), color = color)
        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, tint = color)
    }
}

@Composable
internal fun AccountSymbol(icon: ImageVector, modifier: Modifier = Modifier) {
    Surface(modifier.size(64.dp), shape = CircleShape,
        color = MaterialTheme.colorScheme.primary.copy(alpha = .10f),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = .3f))) {
        Box(contentAlignment = Alignment.Center) { Icon(icon, null, Modifier.size(30.dp), tint = MaterialTheme.colorScheme.primary) }
    }
}
