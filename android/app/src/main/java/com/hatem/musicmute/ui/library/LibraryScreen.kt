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
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.hatem.musicmute.R
import com.hatem.musicmute.library.*
import com.hatem.musicmute.state.LibraryUiState
import com.hatem.musicmute.ui.design.*
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

data class LibraryActions(
    val query: (String) -> Unit, val filter: (LibraryFilter) -> Unit, val sort: (LibrarySort) -> Unit,
    val play: (LibraryEntry) -> Unit, val star: (LibraryKey) -> Unit, val details: (LibraryKey) -> Unit,
    val download: (LibraryKey) -> Unit, val hidden: (LibraryKey, Boolean) -> Unit,
    val home: () -> Unit, val refresh: () -> Unit, val openPlayer: () -> Unit,
    val togglePlayback: () -> Unit, val next: () -> Unit,
    val rename: (LibraryKey, String, () -> Unit) -> Unit,
)

@Composable
fun LibraryScreen(
    state: LibraryUiState,
    actions: LibraryActions,
    hasMore: Boolean = false,
    loadingMore: Boolean = false,
    loadMoreFailed: Boolean = false,
    onLoadMore: () -> Unit = {},
    renameBusy: Boolean = false,
    renameMessage: String? = null,
    miniPlayer: @Composable () -> Unit = {},
) {
    var menu by remember { mutableStateOf<LibraryKey?>(null) }
    var renaming by remember { mutableStateOf<LibraryKey?>(null) }
    var removing by remember { mutableStateOf<LibraryKey?>(null) }
    var renameAttempted by remember { mutableStateOf(false) }
    LaunchedEffect(state.entries) {
        val keys = state.entries.map { it.key }.toSet()
        if (menu !in keys) menu = null
        if (renaming !in keys) renaming = null
        if (removing !in keys) removing = null
    }
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
                LibraryAudioCard(entry, { actions.play(entry) }, { menu = entry.key })
            }
            if (loadMoreFailed) item {
                CreativeFeedback(stringResource(R.string.processing_error_service), error = true,
                    actionLabel = stringResource(R.string.retry),
                    onAction = if (hasMore) onLoadMore else actions.refresh)
            }
            if (hasMore) item {
                OutlinedButton(onClick = onLoadMore, enabled = !loadingMore, modifier = Modifier.fillMaxWidth()) {
                    if (loadingMore) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Text(stringResource(R.string.creative_jobs_load_more))
                }
            }
        }
        miniPlayer()
    }
    }
    state.entries.firstOrNull { it.key == menu }?.let { entry ->
        LibraryTrackActionsSheet(
            entry = entry,
            onDismiss = { menu = null },
            onPlay = { menu = null; actions.play(entry) },
            onStar = { menu = null; actions.star(entry.key) },
            onRename = { menu = null; renameAttempted = false; renaming = entry.key },
            onDetails = { menu = null; actions.details(entry.key) },
            onDownload = { menu = null; actions.download(entry.key) },
            onRemoveOrRestore = {
                menu = null
                if (entry.hidden) actions.hidden(entry.key, false) else removing = entry.key
            },
            renameEnabled = !renameBusy,
        )
    }
    state.entries.firstOrNull { it.key == renaming }?.let { entry ->
        RenameAudioSheet(
            title = entry.title,
            busy = renameBusy,
            onDismiss = { renaming = null },
            onRename = { title ->
                renameAttempted = true
                actions.rename(entry.key, title) { renaming = null }
            },
            message = renameMessage.takeIf { renameAttempted },
        )
    }
    state.entries.firstOrNull { it.key == removing }?.let { entry ->
        CreativeSheet(onDismiss = { removing = null }) {
            Text(stringResource(R.string.creative_library_hide_title), style = MaterialTheme.typography.titleLarge)
            Text(entry.title, style = MaterialTheme.typography.titleMedium)
            Text(stringResource(R.string.creative_library_hide_body), style = MaterialTheme.typography.bodySmall)
            CreativePrimaryButton(
                onClick = { removing = null; actions.hidden(entry.key, true) },
                modifier = Modifier.fillMaxWidth(),
                destructive = true,
            ) { Text(stringResource(R.string.creative_library_hide)) }
            OutlinedButton(onClick = { removing = null }, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.auth_cancel))
            }
        }
    }
}

@Composable
private fun LibraryToolbar(state: LibraryUiState, actions: LibraryActions) {
    var sortMenu by remember { mutableStateOf(false) }
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
        LibraryFilter.entries.forEach { filter ->
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
fun LibraryAudioCard(entry: LibraryEntry, onPlay: () -> Unit, onMore: () -> Unit) {
    Surface(
        Modifier.fillMaxWidth().padding(bottom = 4.dp),
        shape = RoundedCornerShape(18.dp),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f)),
    ) {
        Column(Modifier.combinedClickable(
            onClick = onPlay, onClickLabel = stringResource(R.string.creative_library_play),
            onLongClick = onMore, onLongClickLabel = stringResource(R.string.creative_library_more),
        ).padding(horizontal = 12.dp, vertical = 10.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                LibraryMusicIcon(entry.offlineStatus)
                Column(
                    Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Text(
                            entry.title,
                            Modifier.weight(1f, fill = false),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.titleMedium,
                        )
                        if (entry.starred) {
                            Icon(
                                Icons.Filled.Star,
                                stringResource(R.string.creative_library_starred),
                                Modifier.size(16.dp),
                                tint = MaterialTheme.colorScheme.primary,
                            )
                        }
                    }
                    val createdAt = libraryCreatedAt(entry.createdAtEpochMs)
                    if (entry.durationMs != null || createdAt != null) {
                        Row(
                            Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            entry.durationMs?.let {
                                Text(
                                    audioTime(it),
                                    maxLines = 1,
                                    style = MaterialTheme.typography.labelMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            createdAt?.let { created ->
                                Text(
                                    created,
                                    Modifier.weight(1f),
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    textAlign = TextAlign.End,
                                    style = MaterialTheme.typography.labelMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
            if (entry.offlineStatus == OfflineStatus.DOWNLOADING) {
                Spacer(Modifier.height(8.dp))
                val total = entry.totalBytes
                val bar = Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp))
                if (total != null && total > 0) LinearProgressIndicator(progress = { (entry.downloadedBytes.toFloat() / total).coerceIn(0f, 1f) }, modifier = bar)
                else LinearProgressIndicator(modifier = bar)
            }
        }
    }
}

@Composable
private fun LibraryMusicIcon(status: OfflineStatus) {
    Box(Modifier.size(44.dp)) {
        Surface(
            modifier = Modifier.fillMaxSize(),
            shape = RoundedCornerShape(13.dp),
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
            contentColor = MaterialTheme.colorScheme.primary,
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(Icons.Outlined.MusicNote, null, Modifier.size(22.dp))
            }
        }
        LibraryAvailabilityBadge(status, Modifier.align(Alignment.BottomEnd))
    }
}

@Composable
private fun LibraryAvailabilityBadge(status: OfflineStatus, modifier: Modifier = Modifier) {
    if (status == OfflineStatus.REMOTE_ONLY) return
    val description = offlineLabel(status)
    val icon = when (status) {
        OfflineStatus.AVAILABLE -> Icons.Outlined.Check
        OfflineStatus.DOWNLOADING -> Icons.Outlined.Download
        OfflineStatus.FAILED -> Icons.Outlined.ErrorOutline
        OfflineStatus.REMOTE_ONLY -> return
    }
    val failed = status == OfflineStatus.FAILED
    Surface(
        modifier = modifier.size(16.dp),
        shape = RoundedCornerShape(50),
        color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
        contentColor = if (failed) MaterialTheme.colorScheme.onError else MaterialTheme.colorScheme.onPrimary,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(icon, description, Modifier.size(10.dp))
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
    return "%d:%02d".format(Locale.getDefault(), seconds / 60, seconds % 60)
}

fun libraryCreatedAt(
    epochMs: Long,
    zone: ZoneId = ZoneId.systemDefault(),
    locale: Locale = Locale.getDefault(),
): String? {
    if (epochMs <= 0L) return null
    return DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)
        .withLocale(locale)
        .withZone(zone)
        .format(Instant.ofEpochMilli(epochMs))
}
