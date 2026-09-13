package com.hatem.musicmute.ui.library

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.library.*
import com.hatem.musicmute.state.LibraryUiState
import com.hatem.musicmute.ui.design.*

data class LibraryActions(
    val query: (String) -> Unit, val filter: (LibraryFilter) -> Unit, val sort: (LibrarySort) -> Unit,
    val play: (LibraryEntry) -> Unit, val star: (LibraryKey) -> Unit, val details: (LibraryKey) -> Unit,
    val download: (LibraryKey) -> Unit, val hidden: (LibraryKey, Boolean) -> Unit,
    val home: () -> Unit, val refresh: () -> Unit, val openPlayer: () -> Unit,
    val togglePlayback: () -> Unit, val next: () -> Unit,
)

@Composable
fun LibraryScreen(state: LibraryUiState, actions: LibraryActions, miniPlayer: @Composable () -> Unit = {}) {
    var menu by remember { mutableStateOf<LibraryEntry?>(null) }
    Column(Modifier.fillMaxSize().widthIn(max = CreativeTokens.ContentWidth).padding(horizontal = 20.dp)) {
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(vertical = 16.dp)) {
            item { CreativeHeader(stringResource(R.string.creative_library_title)) }
            item { CreativeTextField(state.query, actions.query, stringResource(R.string.creative_library_search), trailingIcon = { Icon(Icons.Outlined.Search, null) }) }
            item {
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    LibraryFilter.entries.forEach { filter ->
                        FilterChip(state.filter == filter, { actions.filter(filter) }, { Text(stringResource(filter.label())) })
                    }
                }
            }
            item {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    TextButton({ actions.sort(if (state.sort == LibrarySort.NEWEST) LibrarySort.TITLE else LibrarySort.NEWEST) }) {
                        Icon(Icons.Outlined.Sort, stringResource(R.string.creative_library_sort))
                        Text(stringResource(if (state.sort == LibrarySort.NEWEST) R.string.creative_library_newest else R.string.creative_library_sort_title))
                    }
                    IconButton(actions.refresh) { Icon(Icons.Outlined.Refresh, stringResource(R.string.creative_library_refresh)) }
                }
            }
            if (state.loadFailed || state.problem != null) item {
                CreativeFeedback(stringResource(libraryProblemLabel(state.problem)), error = true,
                    actionLabel = stringResource(R.string.creative_library_refresh), onAction = actions.refresh)
            }
            if (state.entries.isEmpty()) item {
                CreativeCard {
                    val narrowed = state.query.isNotBlank() || state.filter != LibraryFilter.ALL
                    Text(stringResource(if (narrowed) R.string.creative_library_no_results else R.string.creative_library_empty))
                    TextButton(if (narrowed) ({ actions.query(""); actions.filter(LibraryFilter.ALL) }) else actions.home) {
                        Text(stringResource(if (narrowed) R.string.creative_library_reset else R.string.creative_library_home))
                    }
                }
            }
            items(state.entries, key = { "${it.key.ownerUid}/${it.key.jobId}" }) { entry ->
                LibraryAudioCard(entry, { actions.play(entry) }, { actions.star(entry.key) }, { actions.details(entry.key) }, { menu = entry })
            }
        }
        miniPlayer()
    }
    menu?.let { entry ->
        CreativeSheet({ menu = null }) {
            Text(entry.title, style = MaterialTheme.typography.titleLarge)
            Text(offlineLabel(entry.offlineStatus), color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (entry.offlineStatus != OfflineStatus.AVAILABLE) TextButton({ actions.download(entry.key); menu = null }) { Text(stringResource(R.string.creative_library_download)) }
            TextButton({ actions.details(entry.key); menu = null }) { Text(stringResource(R.string.creative_library_info)) }
            Text(stringResource(R.string.creative_library_hide_body), style = MaterialTheme.typography.bodySmall)
            TextButton({ actions.hidden(entry.key, !entry.hidden); menu = null }) { Text(stringResource(if (entry.hidden) R.string.creative_library_restore else R.string.creative_library_hide)) }
        }
    }
}

@Composable
fun LibraryAudioCard(entry: LibraryEntry, onPlay: () -> Unit, onStar: () -> Unit, onInfo: () -> Unit, onMore: () -> Unit) {
    CreativeCard(Modifier.clickable(onClick = onPlay), contentPadding = CreativeTokens.CompactCardPadding,
        contentGap = CreativeTokens.CompactGap) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedIconButton(onPlay) { Icon(Icons.Outlined.PlayArrow, stringResource(R.string.creative_library_play)) }
            Column(Modifier.weight(1f).padding(horizontal = 8.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text(entry.title, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium)
                AudioBars(Modifier.fillMaxWidth().height(20.dp))
            }
            CreativeStarButton(entry.starred, onStar, stringResource(if (entry.starred) R.string.creative_library_unstar else R.string.creative_library_star))
            IconButton(onInfo) { Icon(Icons.Outlined.Info, stringResource(R.string.creative_library_info)) }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            entry.durationMs?.let { Text(audioTime(it), style = MaterialTheme.typography.labelSmall) }
            Text(offlineLabel(entry.offlineStatus), Modifier.weight(1f), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            IconButton(onMore) { Icon(Icons.Outlined.MoreVert, stringResource(R.string.creative_library_more)) }
        }
        if (entry.offlineStatus == OfflineStatus.DOWNLOADING) {
            val total = entry.totalBytes
            if (total != null && total > 0) LinearProgressIndicator(progress = { (entry.downloadedBytes.toFloat() / total).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
            else LinearProgressIndicator(Modifier.fillMaxWidth())
        }
    }
}

@Composable
fun AudioBars(modifier: Modifier = Modifier) {
    val color = MaterialTheme.colorScheme.primary
    Canvas(modifier) { repeat(28) { i ->
        val height = size.height * (0.2f + ((i * 7 + 3) % 13) / 16f)
        val x = size.width * i / 28f
        drawLine(color.copy(alpha = .7f), Offset(x, (size.height - height) / 2), Offset(x, (size.height + height) / 2), 2.dp.toPx())
    } }
}

@Composable fun offlineLabel(status: OfflineStatus): String = stringResource(when (status) {
    OfflineStatus.AVAILABLE -> R.string.creative_library_offline
    OfflineStatus.DOWNLOADING -> R.string.creative_library_downloading
    OfflineStatus.FAILED -> R.string.creative_library_failed
    OfflineStatus.REMOTE_ONLY -> R.string.creative_library_remote
})

internal fun LibraryFilter.label(): Int = when (this) {
    LibraryFilter.ALL -> R.string.creative_library_all; LibraryFilter.STARRED -> R.string.creative_library_starred
    LibraryFilter.DOWNLOADED -> R.string.creative_library_downloaded; LibraryFilter.NOT_DOWNLOADED -> R.string.creative_library_not_downloaded
    LibraryFilter.REMOVED -> R.string.creative_library_removed
}

internal fun libraryProblemLabel(problem: LibraryProblem?): Int = when (problem) {
    LibraryProblem.OFFLINE -> R.string.processing_error_offline
    LibraryProblem.STORAGE -> R.string.processing_error_storage
    LibraryProblem.INVALID_AUDIO -> R.string.download_invalid_audio
    else -> R.string.creative_library_failed
}

fun audioTime(ms: Long): String {
    val seconds = ms.coerceAtLeast(0) / 1000
    return "%d:%02d".format(java.util.Locale.getDefault(), seconds / 60, seconds % 60)
}
