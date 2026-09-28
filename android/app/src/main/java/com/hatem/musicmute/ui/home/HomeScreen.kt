package com.hatem.musicmute.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.outlined.Audiotrack
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material.icons.outlined.Timer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.processing.AudioTaskPresentation
import com.hatem.musicmute.processing.RealtimeState
import com.hatem.musicmute.ui.ProcessingQueueStatus
import com.hatem.musicmute.processing.JobHistoryState
import com.hatem.musicmute.ui.design.*
import com.hatem.musicmute.ui.processingFailureLabel

@Composable
fun HomeScreen(
    tasks: List<AudioTaskPresentation>,
    history: JobHistoryState,
    busy: Boolean,
    onImport: () -> Unit,
    onRefresh: () -> Unit,
    onLoadMore: () -> Unit,
    onOpen: (AudioTaskPresentation) -> Unit,
    onCancel: (AudioTaskPresentation) -> Unit,
    trimEnabled: Boolean = true,
    onTrimEnabled: (Boolean) -> Unit = {},
    urlImportText: String = "",
    urlImportError: String? = null,
    urlImportBusy: Boolean = false,
    onUrlImportText: (String) -> Unit = {},
    onUrlImport: () -> Unit = {},
    onUrlImportPaste: () -> Unit = {},
    message: String? = null,
    onNotifications: () -> Unit = {},
    miniPlayer: @Composable () -> Unit = {},
    onPhotos: () -> Unit = {},
    actionBusy: Boolean = false,
    notificationsNeeded: Boolean = false,
    linkRequest: Int = 0,
) {
    val visibleTasks = tasks.filter { it.visibleOnHome }
    var notificationDismissed by rememberSaveable { mutableStateOf(false) }
    var linkSource by rememberSaveable { mutableStateOf(true) }
    var showSites by rememberSaveable { mutableStateOf(false) }
    var showTrimInfo by rememberSaveable { mutableStateOf(false) }
    val listState = androidx.compose.foundation.lazy.rememberLazyListState()
    LaunchedEffect(linkRequest) {
        if (linkRequest > 0) { linkSource = true; listState.scrollToItem(0) }
    }
    val keyboard = LocalSoftwareKeyboardController.current
    val importBusy = busy || actionBusy || urlImportBusy
    val startUrlImport = {
        if (!importBusy && urlImportText.isNotBlank()) {
            keyboard?.hide()
            onUrlImport()
        }
    }
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
        LazyColumn(
            Modifier.weight(1f).widthIn(max = CreativeTokens.ContentWidth).fillMaxWidth(),
            state = listState,
            contentPadding = PaddingValues(CreativeTokens.PagePadding),
            verticalArrangement = Arrangement.Top,
        ) {
            item {
                Spacer(Modifier.height(8.dp))
                HomeAppBar(history.connection)
                Spacer(Modifier.height(16.dp))
                ImportSourceCard(
                    linkSource = linkSource,
                    importBusy = importBusy,
                    busy = busy,
                    urlImportBusy = urlImportBusy,
                    urlImportText = urlImportText,
                    urlImportError = urlImportError,
                    onLink = { linkSource = true },
                    onFile = {
                        keyboard?.hide()
                        linkSource = false
                    },
                    onUrlImportText = onUrlImportText,
                    onUrlImportPaste = onUrlImportPaste,
                    onUrlImport = startUrlImport,
                    onImport = onImport,
                )
                Spacer(Modifier.height(12.dp))
                ImportUtilitiesCard(
                    trimEnabled = trimEnabled,
                    enabled = !importBusy,
                    onShowSites = { showSites = true },
                    onShowTrimInfo = { showTrimInfo = true },
                    onTrimEnabled = onTrimEnabled,
                )
                Spacer(Modifier.height(24.dp))
                Text(
                    stringResource(R.string.creative_jobs_recent),
                    modifier = Modifier.fillMaxWidth().semantics { heading() },
                    style = MaterialTheme.typography.headlineSmall,
                )
                Spacer(Modifier.height(12.dp))
            }
            if (visibleTasks.any { it.active } && notificationsNeeded && !notificationDismissed) item {
                CreativeCard(contentPadding = 12.dp, contentGap = 8.dp) {
                    Text(stringResource(R.string.listener_notify_title), style = MaterialTheme.typography.titleMedium)
                    Text(stringResource(R.string.listener_notify_body), style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = onNotifications) { Text(stringResource(R.string.listener_notify_action)) }
                        TextButton(onClick = { notificationDismissed = true }) { Text(stringResource(R.string.listener_notify_dismiss)) }
                    }
                }
                Spacer(Modifier.height(12.dp))
            }
            if (busy || message != null) item {
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (busy) CreativeFeedback(stringResource(R.string.processing_preparing))
                message?.let { CreativeFeedback(it) }
            }
            if (visibleTasks.isEmpty() && !history.loading && history.failure == null && !busy) item {
                CreativeCard { CreativeFeedback(stringResource(R.string.creative_jobs_empty)) }
            }
            items(visibleTasks, key = { it.importRequestId?.let { id -> "url:$id" } ?: it.operationId ?: requireNotNull(it.jobId) }) { task ->
                Column {
                    JobCard(
                        task = task,
                        busy = busy || actionBusy,
                        onOpen = { onOpen(task) },
                        onCancel = { onCancel(task) },
                    )
                    ProcessingQueueStatus(history.jobs.firstOrNull { it.id == task.jobId }, history.connection)
                }
                Spacer(Modifier.height(12.dp))
            }
            item {
                Spacer(Modifier.height(CreativeTokens.ContentGap))
                history.failure?.let {
                    CreativeFeedback(stringResource(processingFailureLabel(it)), error = true,
                        actionLabel = stringResource(R.string.retry),
                        onAction = if (history.nextCursor != null && visibleTasks.isNotEmpty()) onLoadMore else onRefresh)
                }
            }
        }
        miniPlayer()
    }
    if (showSites) CreativeSheet(onDismiss = { showSites = false }) {
        Text(stringResource(R.string.listener_supported_sites), style = MaterialTheme.typography.headlineSmall)
        Text(stringResource(R.string.url_import_supported, com.hatem.musicmute.processing.SupportedAudioSites.names.joinToString(", ")),
            style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        CreativePrimaryButton(onClick = { showSites = false }, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.creative_library_close))
        }
    }
    if (showTrimInfo) CreativeSheet(onDismiss = { showTrimInfo = false }) {
        Text(stringResource(R.string.trim_silence), style = MaterialTheme.typography.headlineSmall)
        Text(stringResource(R.string.listener_trim_description),
            style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        CreativePrimaryButton(onClick = { showTrimInfo = false }, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.creative_library_close))
        }
    }
}

@Composable
private fun HomeAppBar(connection: RealtimeState) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        StudioWaveMark()
        Text(
            stringResource(R.string.app_name),
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.SemiBold,
        )
        Spacer(Modifier.weight(1f))
        HomeLiveStatus(connection)
    }
}

@Composable
private fun StudioWaveMark() {
    Row(
        Modifier.height(32.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        listOf(18.dp, 30.dp, 22.dp).forEach { height ->
            Box(
                Modifier.width(4.dp).height(height)
                    .clip(RoundedCornerShape(50))
                    .background(MaterialTheme.colorScheme.primary),
            )
        }
    }
}

private val LiveConnectedGreen = Color(0xFF48C847)

@Composable
private fun HomeLiveStatus(connection: RealtimeState) {
    val connected = connection == RealtimeState.LIVE
    val description = stringResource(
        if (connected) R.string.realtime_connected_status else R.string.realtime_disconnected_status,
    )
    Row(
        Modifier.clearAndSetSemantics { contentDescription = description },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        val dotShape = RoundedCornerShape(50)
        Box(
            Modifier.size(9.dp).then(
                if (connected) Modifier.background(LiveConnectedGreen, dotShape)
                else Modifier.border(1.5.dp, MaterialTheme.colorScheme.onSurfaceVariant, dotShape),
            ),
        )
        Text(
            stringResource(R.string.realtime_live),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
        )
    }
}

@Composable
private fun ImportSourceCard(
    linkSource: Boolean,
    importBusy: Boolean,
    busy: Boolean,
    urlImportBusy: Boolean,
    urlImportText: String,
    urlImportError: String?,
    onLink: () -> Unit,
    onFile: () -> Unit,
    onUrlImportText: (String) -> Unit,
    onUrlImportPaste: () -> Unit,
    onUrlImport: () -> Unit,
    onImport: () -> Unit,
) {
    CreativeCard(contentPadding = 16.dp, contentGap = 12.dp, shape = RoundedCornerShape(20.dp)) {
        SourceChoice(linkSource, enabled = !importBusy, onLink = onLink, onFile = onFile)
        if (linkSource) {
            CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
                CompactUrlImportField(
                    value = urlImportText,
                    onValueChange = onUrlImportText,
                    enabled = !importBusy,
                    isError = urlImportError != null,
                    onPaste = onUrlImportPaste,
                    onDone = onUrlImport,
                )
            }
            urlImportError?.let { code ->
                CreativeFeedback(stringResource(urlImportMessage(code)), error = true)
            }
            CreativePrimaryButton(
                onClick = onUrlImport,
                enabled = !importBusy && urlImportText.isNotBlank(),
                busy = urlImportBusy,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.creative_home_import_audio))
                Spacer(Modifier.weight(1f))
                Icon(Icons.AutoMirrored.Outlined.ArrowForward, null, Modifier.size(CreativeTokens.SmallIcon))
            }
        } else {
            CreativePrimaryButton(
                onClick = onImport,
                enabled = !importBusy,
                busy = busy,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Outlined.FolderOpen, null, Modifier.size(CreativeTokens.SmallIcon))
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.listener_choose_file))
            }
        }
        ProcessingLimitsRow()
    }
}

@Composable
private fun ProcessingLimitsRow() {
    FlowRow(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        ProcessingLimit(Icons.Outlined.Audiotrack, stringResource(R.string.creative_home_limit_audio))
        ProcessingLimit(Icons.Outlined.Timer, stringResource(R.string.creative_home_limit_duration))
        ProcessingLimit(Icons.Outlined.Storage, stringResource(R.string.creative_home_limit_size))
    }
}

@Composable
private fun ProcessingLimit(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(icon, null, Modifier.size(CreativeTokens.SmallIcon), tint = MaterialTheme.colorScheme.primary)
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ImportUtilitiesCard(
    trimEnabled: Boolean,
    enabled: Boolean,
    onShowSites: () -> Unit,
    onShowTrimInfo: () -> Unit,
    onTrimEnabled: (Boolean) -> Unit,
) {
    CreativeCard(contentPadding = 0.dp, contentGap = 0.dp, shape = RoundedCornerShape(16.dp)) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 56.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(
                onClick = onShowSites,
                enabled = enabled,
                modifier = Modifier.weight(1f).heightIn(min = 56.dp),
                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
            ) {
                Icon(Icons.Outlined.Info, null, Modifier.size(CreativeTokens.SmallIcon))
                Spacer(Modifier.width(6.dp))
                Text(stringResource(R.string.listener_supported_sites), Modifier.weight(1f),
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                Icon(Icons.AutoMirrored.Outlined.ArrowForward, null, Modifier.size(16.dp))
            }
            VerticalDivider(Modifier.height(32.dp), color = MaterialTheme.colorScheme.outlineVariant)
            Row(
                Modifier.weight(1f).heightIn(min = 56.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(
                    onClick = onShowTrimInfo,
                    modifier = Modifier.size(CreativeTokens.TouchTarget),
                ) {
                    Icon(Icons.Outlined.Info, stringResource(R.string.listener_trim_info),
                        Modifier.size(CreativeTokens.SmallIcon), tint = MaterialTheme.colorScheme.primary)
                }
                Row(
                    Modifier.weight(1f).heightIn(min = 56.dp)
                    .toggleable(
                        value = trimEnabled,
                        enabled = enabled,
                        role = Role.Switch,
                        onValueChange = onTrimEnabled,
                    )
                    .padding(end = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(
                        stringResource(R.string.listener_trim_short),
                        Modifier.weight(1f),
                        maxLines = 1,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurface.copy(
                            alpha = if (enabled) 1f else CreativeTokens.DisabledAlpha,
                        ),
                    )
                    Switch(checked = trimEnabled, onCheckedChange = null, enabled = enabled)
                }
            }
        }
    }
}

@Composable
private fun SourceChoice(link: Boolean, enabled: Boolean, onLink: () -> Unit, onFile: () -> Unit) {
    Row(Modifier.fillMaxWidth().height(48.dp).background(MaterialTheme.colorScheme.surfaceContainerLowest, RoundedCornerShape(12.dp))
        .padding(4.dp).selectableGroup()) {
        SourceChoiceButton(
            stringResource(R.string.listener_source_link), Icons.Outlined.Link,
            link, enabled, Modifier.weight(1f), onLink,
        )
        SourceChoiceButton(
            stringResource(R.string.listener_source_file), Icons.Outlined.FolderOpen,
            !link, enabled, Modifier.weight(1f), onFile,
        )
    }
}

@Composable
private fun SourceChoiceButton(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    selected: Boolean,
    enabled: Boolean,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    val color = if (selected) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant
    Box(modifier.height(40.dp).clip(RoundedCornerShape(9.dp))
        .background(if (selected) MaterialTheme.colorScheme.primaryContainer else androidx.compose.ui.graphics.Color.Transparent)
        .selectable(selected = selected, enabled = enabled, role = Role.Tab, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
            Icon(icon, null, Modifier.size(CreativeTokens.SmallIcon), tint = color)
            Spacer(Modifier.width(8.dp))
            Text(label, color = color, style = MaterialTheme.typography.labelLarge)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CompactUrlImportField(
    value: String,
    onValueChange: (String) -> Unit,
    enabled: Boolean,
    isError: Boolean,
    onPaste: () -> Unit,
    onDone: () -> Unit,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val errorMessage = stringResource(R.string.url_import_invalid)
    val fieldDescription = stringResource(R.string.url_import_title)
    val textColor = MaterialTheme.colorScheme.onSurface.copy(
        alpha = if (enabled) 1f else CreativeTokens.DisabledAlpha,
    )
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)
            .semantics {
                contentDescription = fieldDescription
                if (isError) error(errorMessage)
            },
        enabled = enabled,
        singleLine = true,
        textStyle = MaterialTheme.typography.bodyMedium.copy(color = textColor),
        cursorBrush = SolidColor(if (isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary),
        interactionSource = interactionSource,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { onDone() }),
        decorationBox = { innerTextField ->
            OutlinedTextFieldDefaults.DecorationBox(
                value = value,
                innerTextField = innerTextField,
                enabled = enabled,
                singleLine = true,
                visualTransformation = VisualTransformation.None,
                interactionSource = interactionSource,
                isError = isError,
                label = {
                    Text(
                        stringResource(R.string.url_import_title),
                        style = MaterialTheme.typography.labelMedium,
                    )
                },
                placeholder = {
                    Text(stringResource(R.string.url_import_hint),
                        style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                },
                leadingIcon = {
                    Icon(Icons.Outlined.Link, null, Modifier.size(20.dp),
                        tint = MaterialTheme.colorScheme.primary.copy(alpha = if (enabled) 1f else CreativeTokens.DisabledAlpha))
                },
                trailingIcon = {
                    Button(
                        onClick = onPaste,
                        enabled = enabled,
                        modifier = Modifier.padding(end = 4.dp).heightIn(min = CreativeTokens.TouchTarget),
                        shape = RoundedCornerShape(10.dp),
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 0.dp),
                    ) { Text(stringResource(R.string.paste), style = MaterialTheme.typography.labelMedium) }
                },
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                container = {
                    OutlinedTextFieldDefaults.Container(
                        enabled = enabled,
                        isError = isError,
                        interactionSource = interactionSource,
                        shape = RoundedCornerShape(10.dp),
                        colors = OutlinedTextFieldDefaults.colors(
                            unfocusedBorderColor = MaterialTheme.colorScheme.outlineVariant,
                        ),
                    )
                },
            )
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
internal fun urlImportMessage(code: String): Int = when (code) {
    "IMPORT_INVALID_URL" -> R.string.url_import_invalid
    "IMPORT_SINGLE_ITEM_REQUIRED" -> R.string.url_import_single
    "IMPORT_UNSUPPORTED_PROVIDER", "IMPORT_UNSUPPORTED_AUDIO_SOURCE" -> R.string.url_import_unsupported
    "IMPORT_DISABLED", "PROCESSING_UNAVAILABLE" -> R.string.url_import_disabled
    "IMPORT_QUEUE_FULL", "PROCESSING_LIMIT_REACHED" -> R.string.url_import_queue_full
    "IMPORT_TOO_LARGE", "IMPORT_TOO_LONG", "IMPORT_INVALID_AUDIO" -> R.string.url_import_media_invalid
    "IMPORT_SOURCE_UNAVAILABLE", "IMPORT_UPSTREAM_REFUSED" -> R.string.url_import_source_unavailable
    "IMPORT_DEPENDENCY_FAILED", "IMPORT_DISK_FULL" -> R.string.url_import_dependency
    "IMPORT_REQUEST_CONFLICT" -> R.string.url_import_conflict
    "IMPORT_NOT_FOUND" -> R.string.url_import_expired
    "PROCESSING_ALLOWANCE_EXHAUSTED", "UPLOAD_GRANT_LIMIT_REACHED",
    "UPLOAD_BYTE_LIMIT_REACHED", "RETAINED_STORAGE_LIMIT_REACHED",
    "SERVICE_BANDWIDTH_LIMIT_REACHED" -> R.string.url_import_allowance
    "ACCOUNT_RESTRICTED", "ACCOUNT_DISABLED", "ACCOUNT_DELETION_PENDING",
    "EMAIL_VERIFICATION_REQUIRED", "PROFILE_SYNC_REQUIRED", "DEVICE_SYNC_REQUIRED",
    "POLICY_DENIED", "APP_UPDATE_REQUIRED" -> R.string.processing_error_policy
    "UNAUTHENTICATED" -> R.string.processing_error_auth
    "OFFLINE" -> R.string.processing_error_offline
    "RATE_LIMITED" -> R.string.processing_error_rate
    else -> R.string.processing_error_service
}
