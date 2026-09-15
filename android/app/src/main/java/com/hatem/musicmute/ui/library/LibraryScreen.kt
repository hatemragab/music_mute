package com.hatem.musicmute.ui.library

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Sort
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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
    Box(Modifier.fillMaxSize().imePadding(), contentAlignment = Alignment.TopCenter) {
    Column(Modifier.widthIn(max = CreativeTokens.ContentWidth).fillMaxSize().padding(horizontal = CreativeTokens.PagePadding)) {
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp), contentPadding = PaddingValues(vertical = 16.dp)) {
            item {
                Column(Modifier.padding(bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.fillMaxWidth()) {
                    CreativeWave(Modifier.fillMaxWidth().padding(top = 38.dp).height(76.dp).alpha(0.65f))
                    Column {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text(stringResource(R.string.creative_library_title),
                            Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.headlineMedium)
                        IconButton(actions.refresh) {
                            Icon(Icons.Outlined.Refresh, stringResource(R.string.creative_library_refresh))
                        }
                    }
                    Spacer(Modifier.height(66.dp))
                    }
                    }
                    LibraryToolbar(state, actions)
                }
            }
            if (state.loadFailed || state.problem != null) item {
                CreativeFeedback(stringResource(libraryProblemLabel(state.problem)), error = true,
                    actionLabel = stringResource(R.string.creative_library_refresh), onAction = actions.refresh)
            }
            if (state.entries.isEmpty() && !state.loadFailed && state.problem == null) item {
                CreativeCard {
                    val narrowed = state.query.isNotBlank() || state.filter != LibraryFilter.ALL
                    Text(stringResource(if (narrowed) R.string.creative_library_no_results else R.string.creative_library_empty))
                    TextButton(if (narrowed) ({ actions.query(""); actions.filter(LibraryFilter.ALL) }) else actions.home) {
                        Text(stringResource(if (narrowed) R.string.creative_library_reset else R.string.creative_library_home))
                    }
                }
            }
            items(state.entries, key = { "${it.key.ownerUid}/${it.key.jobId}" }) { entry ->
                LibraryAudioCard(entry, { actions.play(entry) }, { actions.star(entry.key) }, { menu = entry })
            }
        }
        miniPlayer()
    }
    }
    menu?.let { entry ->
        CreativeSheet({ menu = null }) {
            Text(entry.title, style = MaterialTheme.typography.titleLarge)
            Text(offlineLabel(entry.offlineStatus), color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (entry.offlineStatus == OfflineStatus.DOWNLOADING) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (entry.offlineStatus !in setOf(OfflineStatus.AVAILABLE, OfflineStatus.DOWNLOADING)) TextButton({ actions.download(entry.key); menu = null }) { Text(stringResource(R.string.creative_library_download)) }
            TextButton({ actions.details(entry.key); menu = null }) { Text(stringResource(R.string.creative_library_info)) }
            Text(stringResource(R.string.creative_library_hide_body), style = MaterialTheme.typography.bodySmall)
            TextButton({ actions.hidden(entry.key, !entry.hidden); menu = null }) { Text(stringResource(if (entry.hidden) R.string.creative_library_restore else R.string.creative_library_hide)) }
        }
    }
}

@Composable
private fun LibraryToolbar(state: LibraryUiState, actions: LibraryActions) {
    var sortMenu by remember { mutableStateOf(false) }
    LaunchedEffect(state.filter) {
        if (state.filter == LibraryFilter.REMOVED) actions.filter(LibraryFilter.ALL)
    }
    val keyboard = LocalSoftwareKeyboardController.current
    val searchLabel = stringResource(R.string.creative_library_search)
    val sortLabel = stringResource(R.string.creative_library_sort)
    val controlShape = RoundedCornerShape(12.dp)
    val controlTextStyle = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp, lineHeight = 20.sp)
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).heightIn(min = CreativeTokens.TouchTarget),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        BasicTextField(
            value = state.query, onValueChange = actions.query, singleLine = true,
            modifier = Modifier.weight(1f).fillMaxHeight().semantics { contentDescription = searchLabel },
            textStyle = controlTextStyle.copy(color = MaterialTheme.colorScheme.onSurface),
            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
            decorationBox = { innerTextField ->
                Row(Modifier.fillMaxWidth().fillMaxHeight()
                    .background(MaterialTheme.colorScheme.surfaceContainerLow, controlShape)
                    .border(1.dp, MaterialTheme.colorScheme.outlineVariant, controlShape)
                    .padding(horizontal = 11.dp, vertical = 7.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.Search, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Box(Modifier.weight(1f)) {
                        if (state.query.isEmpty()) Text(stringResource(R.string.creative_library_search_short),
                            style = controlTextStyle, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                        innerTextField()
                    }
                }
            },
        )
        Box(Modifier.fillMaxHeight()) {
            OutlinedButton(onClick = { sortMenu = true }, modifier = Modifier.fillMaxHeight().widthIn(min = 100.dp)
                .semantics { contentDescription = sortLabel }, shape = controlShape,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                colors = ButtonDefaults.outlinedButtonColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
                    contentColor = MaterialTheme.colorScheme.onSurfaceVariant),
                contentPadding = PaddingValues(horizontal = 11.dp, vertical = 7.dp)) {
                Text(stringResource(if (state.sort == LibrarySort.NEWEST) R.string.creative_library_newest_short else R.string.creative_library_sort_title),
                    style = controlTextStyle)
                Spacer(Modifier.width(4.dp))
                Icon(Icons.Outlined.ExpandMore, null, Modifier.size(18.dp))
            }
            DropdownMenu(expanded = sortMenu, onDismissRequest = { sortMenu = false }) {
                LibrarySort.entries.forEach { sort ->
                    DropdownMenuItem(text = { Text(stringResource(if (sort == LibrarySort.NEWEST) R.string.creative_library_newest else R.string.creative_library_sort_title)) },
                        onClick = { actions.sort(sort); sortMenu = false },
                        trailingIcon = { if (state.sort == sort) Icon(Icons.Outlined.Check, null) })
                }
            }
        }
    }
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).selectableGroup(),
        horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        LibraryFilter.entries.filter { it != LibraryFilter.REMOVED }.forEach { filter ->
            val selected = state.filter == filter
            Column(Modifier.selectable(selected = selected, onClick = { actions.filter(filter) }, role = Role.Tab)) {
                Box(Modifier.heightIn(min = 46.dp).padding(horizontal = 9.dp, vertical = 10.dp), contentAlignment = Alignment.Center) {
                    Text(stringResource(filter.label()), style = MaterialTheme.typography.labelMedium, maxLines = 1,
                        color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                }
                HorizontalDivider(color = if (selected) MaterialTheme.colorScheme.primary else Color.Transparent,
                    thickness = 2.dp, modifier = Modifier.width(24.dp).align(Alignment.CenterHorizontally))
            }
        }
    }
}

@Composable
@OptIn(ExperimentalFoundationApi::class)
fun LibraryAudioCard(entry: LibraryEntry, onPlay: () -> Unit, onStar: () -> Unit, onMore: () -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().combinedClickable(
            onClick = onPlay, onClickLabel = stringResource(R.string.creative_library_play),
            onLongClick = onMore, onLongClickLabel = stringResource(R.string.creative_library_more),
        ).padding(vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Surface(shape = RoundedCornerShape(10.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh) {
                Icon(Icons.Outlined.MusicNote, null, Modifier.size(48.dp).padding(11.dp),
                    tint = MaterialTheme.colorScheme.primary)
            }
            Column(Modifier.weight(1f).padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(entry.title, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodyMedium, fontSize = 15.sp)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (entry.offlineStatus == OfflineStatus.AVAILABLE) {
                        Icon(Icons.Outlined.CheckCircle, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.primary)
                    }
                    Text(offlineLabel(entry.offlineStatus), maxLines = 1, overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.labelSmall, fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            entry.durationMs?.let {
                Text(audioTime(it), style = MaterialTheme.typography.labelSmall, fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            CreativeStarButton(entry.starred, onStar,
                stringResource(if (entry.starred) R.string.creative_library_unstar else R.string.creative_library_star))
        }
        if (entry.offlineStatus == OfflineStatus.DOWNLOADING) {
            val total = entry.totalBytes
            if (total != null && total > 0) LinearProgressIndicator(progress = { (entry.downloadedBytes.toFloat() / total).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
            else LinearProgressIndicator(Modifier.fillMaxWidth())
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
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
