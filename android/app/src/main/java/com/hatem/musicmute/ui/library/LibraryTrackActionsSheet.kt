package com.hatem.musicmute.ui.library

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Restore
import androidx.compose.material.icons.outlined.StarBorder
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.library.LibraryEntry
import com.hatem.musicmute.library.OfflineStatus
import com.hatem.musicmute.ui.design.CreativePrimaryButton
import com.hatem.musicmute.ui.design.CreativeSheet
import com.hatem.musicmute.ui.design.CreativeTokens

@Composable
internal fun LibraryTrackActionsSheet(
    entry: LibraryEntry,
    onDismiss: () -> Unit,
    onPlay: () -> Unit,
    onStar: () -> Unit,
    onRename: () -> Unit,
    onDetails: () -> Unit,
    onDownload: () -> Unit,
    onRemoveOrRestore: () -> Unit,
    renameEnabled: Boolean = true,
) {
    CreativeSheet(onDismiss) {
        Text(
            entry.title,
            modifier = Modifier.semantics { heading() },
            style = MaterialTheme.typography.titleLarge,
        )
        CreativePrimaryButton(onClick = onPlay, modifier = Modifier.fillMaxWidth()) {
            Icon(Icons.Outlined.PlayArrow, null, Modifier.size(20.dp))
            Spacer(Modifier.width(CreativeTokens.CompactGap))
            Text(stringResource(R.string.creative_library_play_now))
        }
        Surface(
            shape = RoundedCornerShape(16.dp),
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
        ) {
            Column(Modifier.fillMaxWidth()) {
                LibraryActionRow(
                    label = stringResource(if (entry.starred) R.string.creative_library_unstar else R.string.creative_library_star),
                    icon = if (entry.starred) Icons.Filled.Star else Icons.Outlined.StarBorder,
                    onClick = onStar,
                )
                LibraryActionDivider()
                LibraryActionRow(
                    label = stringResource(R.string.audio_task_rename),
                    icon = Icons.Outlined.Edit,
                    onClick = onRename,
                    enabled = renameEnabled,
                    opensScreen = true,
                )
                LibraryActionDivider()
                LibraryActionRow(
                    label = stringResource(R.string.creative_library_info),
                    icon = Icons.Outlined.Info,
                    onClick = onDetails,
                    opensScreen = true,
                )
                if (entry.offlineStatus != OfflineStatus.AVAILABLE && entry.offlineStatus != OfflineStatus.DOWNLOADING) {
                    LibraryActionDivider()
                    LibraryActionRow(
                        label = stringResource(R.string.creative_library_download),
                        icon = Icons.Outlined.Download,
                        onClick = onDownload,
                    )
                }
            }
        }
        Surface(
            shape = RoundedCornerShape(16.dp),
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
        ) {
            LibraryActionRow(
                label = stringResource(if (entry.hidden) R.string.creative_library_restore else R.string.creative_library_hide),
                icon = if (entry.hidden) Icons.Outlined.Restore else Icons.Outlined.Archive,
                onClick = onRemoveOrRestore,
                destructive = !entry.hidden,
            )
        }
    }
}

@Composable
private fun LibraryActionDivider() {
    HorizontalDivider(
        modifier = Modifier.padding(start = 50.dp, end = 16.dp),
        color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f),
    )
}

@Composable
private fun LibraryActionRow(
    label: String,
    icon: ImageVector,
    onClick: () -> Unit,
    enabled: Boolean = true,
    opensScreen: Boolean = false,
    destructive: Boolean = false,
) {
    val contentColor = if (destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
    val alpha = if (enabled) 1f else CreativeTokens.DisabledAlpha
    Row(
        modifier = Modifier.fillMaxWidth()
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .heightIn(min = 56.dp)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(
            icon, null, Modifier.size(20.dp),
            tint = (if (destructive) contentColor else MaterialTheme.colorScheme.primary).copy(alpha = alpha),
        )
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge, color = contentColor.copy(alpha = alpha))
        if (opensScreen) {
            Icon(
                Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, Modifier.size(18.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = alpha),
            )
        }
    }
}
