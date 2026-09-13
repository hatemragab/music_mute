package com.hatem.musicmute.ui.library

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.library.LibraryEntry
import com.hatem.musicmute.processing.Job
import com.hatem.musicmute.ui.design.*
import com.hatem.musicmute.ui.processingStatusLabel

data class TrackDetailsActions(
    val back: () -> Unit, val play: () -> Unit, val star: () -> Unit, val download: () -> Unit,
    val save: () -> Unit, val share: () -> Unit, val rename: (String) -> Unit, val delete: () -> Unit,
    val hidden: (Boolean) -> Unit, val viewJob: () -> Unit, val refresh: () -> Unit,
)

@Composable
fun TrackDetailsScreen(entry: LibraryEntry?, job: Job?, busy: Boolean, message: String?, actions: TrackDetailsActions) {
    var tab by rememberSaveable(entry?.key?.jobId) { mutableIntStateOf(0) }
    var renaming by rememberSaveable(entry?.key?.jobId) { mutableStateOf(false) }
    var deleting by rememberSaveable(entry?.key?.jobId) { mutableStateOf(false) }
    var renameFrom by rememberSaveable(entry?.key?.jobId) { mutableStateOf<String?>(null) }
    CreativePage {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(actions.back) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, stringResource(R.string.creative_library_back)) }
            Text(stringResource(R.string.creative_library_info), style = MaterialTheme.typography.headlineSmall)
        }
        CreativeWave(Modifier.fillMaxWidth())
        if (entry == null) {
            CreativeFeedback(stringResource(R.string.creative_library_job_unavailable), actionLabel = stringResource(R.string.creative_library_refresh), onAction = actions.refresh)
            return@CreativePage
        }
        CreativeCard {
            AudioBars(Modifier.fillMaxWidth().height(40.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(entry.title, style = MaterialTheme.typography.titleLarge)
                    Text(entry.durationMs?.let(::audioTime) ?: stringResource(R.string.creative_library_unknown))
                    Text(stringResource(R.string.creative_library_voice), style = MaterialTheme.typography.bodySmall)
                }
                CreativeStarButton(entry.starred, actions.star, stringResource(if (entry.starred) R.string.creative_library_unstar else R.string.creative_library_star))
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(tab == 0, { tab = 0 }, { Text(stringResource(R.string.creative_library_media)) }, Modifier.weight(1f))
            FilterChip(tab == 1, { tab = 1 }, { Text(stringResource(R.string.creative_library_job)) }, Modifier.weight(1f))
        }
        message?.let { CreativeFeedback(it) }
        if (tab == 0) {
            CreativeCard {
                DetailRow(stringResource(R.string.creative_library_duration), entry.durationMs?.let(::audioTime) ?: stringResource(R.string.creative_library_unknown))
                DetailRow(stringResource(R.string.creative_library_availability), offlineLabel(entry.offlineStatus))
                CreativePrimaryButton(actions.play, Modifier.fillMaxWidth(), busy = busy) { Text(stringResource(R.string.creative_library_play)) }
                OutlinedButton(actions.download, Modifier.fillMaxWidth(), enabled = !busy) { Text(stringResource(R.string.creative_library_download)) }
            }
            CreativeCard {
                TextButton({ renaming = true }, enabled = !busy) { Text(stringResource(R.string.audio_task_rename)) }
                Text(stringResource(R.string.creative_library_hide_body), style = MaterialTheme.typography.bodySmall)
                TextButton({ actions.hidden(!entry.hidden) }, enabled = !busy) { Text(stringResource(if (entry.hidden) R.string.creative_library_restore else R.string.creative_library_hide)) }
                TextButton({ deleting = true }, enabled = !busy, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text(stringResource(R.string.creative_library_delete)) }
            }
        } else {
            CreativeCard {
                if (job == null) Text(stringResource(R.string.creative_library_job_unavailable))
                else {
                    DetailRow(stringResource(R.string.creative_library_status), stringResource(processingStatusLabel(job.status)))
                    DetailRow(stringResource(R.string.creative_library_job_id), job.id)
                    DetailRow(stringResource(R.string.creative_library_source), job.sourceTitle ?: stringResource(R.string.creative_library_unknown))
                    DetailRow(stringResource(R.string.creative_library_processing_time), job.timing?.processingElapsedMs?.let { (if (job.timing.processingElapsedApproximate) "≈ " else "") + audioTime(it) } ?: stringResource(R.string.creative_library_unknown))
                    OutlinedButton(actions.viewJob, Modifier.fillMaxWidth()) { Text(stringResource(R.string.creative_library_view_job)) }
                }
                Text(stringResource(R.string.creative_library_cached_job), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton(actions.refresh, enabled = !busy) { Text(stringResource(R.string.creative_library_refresh)) }
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(CreativeTokens.CompactGap)) {
            CreativePrimaryButton(actions.save, Modifier.fillMaxWidth(), busy = busy) { Text(stringResource(R.string.creative_library_save_copy)) }
            OutlinedButton(actions.share, Modifier.fillMaxWidth(), enabled = !busy) { Text(stringResource(R.string.creative_library_share)) }
        }
    }
    if (renaming && entry != null) RenameAudioSheet(entry.title, busy, { renaming = false }, {
        renameFrom = entry.title
        actions.rename(it)
    }, message)
    if (deleting && entry != null) DeleteAudioSheet(entry.title, busy, { deleting = false }, actions.delete, message)
    // Rename changes the catalog title after success; deletion removes the entry after confirmation.
    LaunchedEffect(entry?.title) {
        if (renameFrom != null && entry?.title != renameFrom) {
            renaming = false
            renameFrom = null
        }
    }
    LaunchedEffect(entry == null) { if (entry == null) deleting = false }
}

@Composable private fun DetailRow(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium)
        Text(value, style = MaterialTheme.typography.bodyLarge)
    }
}
