package com.hatem.musicmute.ui.player

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.hatem.musicmute.R
import com.hatem.musicmute.processing.ArtifactProgress
import com.hatem.musicmute.ui.library.audioTime
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map

@Composable
internal fun PlayerDownloadProgress(
    jobId: String?,
    progress: StateFlow<Map<String, ArtifactProgress>>?,
    active: Boolean,
) {
    if (jobId == null || progress == null) {
        PlaybackActivityIndicator(active)
        return
    }
    val scopedProgress = remember(progress, jobId) {
        progress.map { it[jobId] }.distinctUntilChanged()
    }
    val initialProgress = remember(progress, jobId) { progress.value[jobId] }
    val transfer by scopedProgress.collectAsStateWithLifecycle(initialProgress)
    val current = transfer
    if (current == null) {
        PlaybackActivityIndicator(active)
        return
    }
    val fraction = current.downloadFraction()
    val percent = current.downloadPercent()
    val remaining = current.displayRemainingMs()
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        val barModifier = Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp))
        if (fraction != null) {
            LinearProgressIndicator(progress = { fraction }, modifier = barModifier)
        } else {
            LinearProgressIndicator(modifier = barModifier)
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                stringResource(
                    if (current.artifact == "input") R.string.player_downloading_original
                    else R.string.player_downloading_voice,
                ),
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            remaining?.let {
                Text(
                    stringResource(R.string.player_download_remaining, audioTime(it)),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            percent?.let {
                Text(
                    stringResource(R.string.progress_percent, it),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
        }
    }
}
