package com.hatem.musicmute.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.processing.AudioTaskPresentation
import com.hatem.musicmute.processing.AudioTaskStage
import com.hatem.musicmute.ui.ProcessingConnectionStatus
import com.hatem.musicmute.ui.ProcessingQueueStatus
import com.hatem.musicmute.processing.JobHistoryState
import com.hatem.musicmute.processing.UrlImportRecord
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
    onRetry: (AudioTaskPresentation) -> Unit,
    trimEnabled: Boolean = false,
    onTrimEnabled: (Boolean) -> Unit = {},
    urlImports: List<UrlImportRecord> = emptyList(),
    urlImportText: String = "",
    urlImportError: String? = null,
    urlImportBusy: Boolean = false,
    onUrlImportText: (String) -> Unit = {},
    onUrlImport: () -> Unit = {},
    onUrlImportPaste: () -> Unit = {},
    onUrlImportRetry: (UrlImportRecord) -> Unit = {},
    message: String? = null,
    onNotifications: () -> Unit = {},
    miniPlayer: @Composable () -> Unit = {},
    onPhotos: () -> Unit = {},
    actionBusy: Boolean = false,
    notificationsNeeded: Boolean = false,
    onPlayReady: (AudioTaskPresentation) -> Unit = {},
    onOpenLibrary: () -> Unit = {},
) {
    var notificationDismissed by rememberSaveable { mutableStateOf(false) }
    var linkSource by rememberSaveable { mutableStateOf(true) }
    var showSites by rememberSaveable { mutableStateOf(false) }
    val openTasks = tasks.filter { it.stage != AudioTaskStage.READY }
    val readyTasks = tasks.filter { it.stage == AudioTaskStage.READY }
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
            contentPadding = PaddingValues(CreativeTokens.PagePadding),
            verticalArrangement = Arrangement.Top,
        ) {
            item {
                ProcessingConnectionStatus(history.connection)
                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(stringResource(R.string.creative_jobs_home_title), modifier = Modifier.fillMaxWidth(),
                        style = MaterialTheme.typography.headlineMedium, textAlign = TextAlign.Center)
                    Spacer(Modifier.height(8.dp))
                    Text(stringResource(R.string.listener_home_promise), modifier = Modifier.fillMaxWidth(),
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center)
                    Spacer(Modifier.height(4.dp))
                    Text(stringResource(R.string.processing_limits), modifier = Modifier.fillMaxWidth(),
                        style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary,
                        textAlign = TextAlign.Center)
                    Spacer(Modifier.height(16.dp))
                    CreativeCard(contentPadding = 16.dp, contentGap = 12.dp) {
                        SourceChoice(linkSource, enabled = !importBusy, onLink = { linkSource = true }, onFile = {
                            keyboard?.hide()
                            linkSource = false
                        })
                        if (linkSource) {
                            CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
                                CompactUrlImportField(
                                    value = urlImportText, onValueChange = onUrlImportText,
                                    enabled = !importBusy, isError = urlImportError != null,
                                    onPaste = onUrlImportPaste, onDone = startUrlImport,
                                )
                            }
                            urlImportError?.let { code ->
                                CreativeFeedback(stringResource(urlImportMessage(code)), error = true)
                            }
                            if (urlImportText.isNotBlank()) {
                                TextButton(onClick = startUrlImport, enabled = !importBusy,
                                    modifier = Modifier.align(Alignment.End)) {
                                    Text(stringResource(R.string.url_import_action))
                                }
                            }
                            TextButton(onClick = { showSites = true }, modifier = Modifier.heightIn(min = 48.dp)) {
                                Text(stringResource(R.string.listener_supported_sites))
                            }
                        } else {
                            OutlinedButton(onClick = onImport, enabled = !busy,
                                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
                                shape = RoundedCornerShape(14.dp)) {
                                Icon(Icons.Outlined.FolderOpen, null, Modifier.size(18.dp))
                                Spacer(Modifier.width(8.dp))
                                Text(stringResource(R.string.listener_choose_file))
                            }
                        }
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text(stringResource(R.string.trim_silence), Modifier.weight(1f),
                                style = MaterialTheme.typography.bodyLarge)
                            Switch(trimEnabled, onTrimEnabled, enabled = !importBusy)
                        }
                    }
                }
                Spacer(Modifier.height(20.dp))
            }
            if (readyTasks.isNotEmpty()) item {
                val latest = readyTasks.first()
                CreativeCard(contentPadding = 12.dp, contentGap = 8.dp) {
                    Text(stringResource(R.string.listener_ready_title), style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.primary)
                    Text(latest.displayName.ifBlank { stringResource(R.string.voice_track) },
                        style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = { onPlayReady(latest) }) { Text(stringResource(R.string.listener_ready_play)) }
                        if (readyTasks.size > 1) TextButton(onClick = onOpenLibrary) {
                            Text(stringResource(R.string.listener_ready_open_library))
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))
            }
            if (openTasks.any { it.active } && notificationsNeeded && !notificationDismissed) item {
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
            if (openTasks.isEmpty() && readyTasks.isEmpty() && !history.loading && history.failure == null && !busy) item {
                CreativeCard { CreativeFeedback(stringResource(R.string.creative_jobs_empty)) }
            }
            items(openTasks, key = { it.importRequestId?.let { id -> "url:$id" } ?: it.operationId ?: requireNotNull(it.jobId) }) { task ->
                Column {
                    JobCard(task, busy || actionBusy, { onOpen(task) }, { onCancel(task) }, {
                        val record = urlImports.firstOrNull { it.requestId == task.importRequestId }
                        if (task.importOnly && record != null) onUrlImportRetry(record) else onRetry(task)
                    })
                    ProcessingQueueStatus(history.jobs.firstOrNull { it.id == task.jobId }, history.connection)
                }
            }
            item {
                Spacer(Modifier.height(CreativeTokens.ContentGap))
                history.failure?.let {
                    CreativeFeedback(stringResource(processingFailureLabel(it)), error = true,
                        actionLabel = stringResource(R.string.retry),
                        onAction = if (history.nextCursor != null && tasks.isNotEmpty()) onLoadMore else onRefresh)
                }
                if (history.nextCursor != null) OutlinedButton(
                    onClick = onLoadMore, enabled = !history.loadingMore && !history.loading,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (history.loadingMore) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.creative_jobs_load_more))
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
}

@Composable
private fun SourceChoice(link: Boolean, enabled: Boolean, onLink: () -> Unit, onFile: () -> Unit) {
    Row(Modifier.fillMaxWidth().height(48.dp).background(MaterialTheme.colorScheme.surfaceContainerLowest, RoundedCornerShape(12.dp))
        .padding(4.dp)) {
        SourceChoiceButton(stringResource(R.string.listener_source_link), link, enabled, Modifier.weight(1f), onLink)
        SourceChoiceButton(stringResource(R.string.listener_source_file), !link, enabled, Modifier.weight(1f), onFile)
    }
}

@Composable
private fun SourceChoiceButton(label: String, selected: Boolean, enabled: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val color = if (selected) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant
    Box(modifier.height(40.dp).clip(RoundedCornerShape(9.dp))
        .background(if (selected) MaterialTheme.colorScheme.surfaceContainerHigh else androidx.compose.ui.graphics.Color.Transparent)
        .clickable(enabled = enabled, onClick = onClick), contentAlignment = Alignment.Center) {
        Text(label, color = color, style = MaterialTheme.typography.labelLarge)
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
    val textColor = MaterialTheme.colorScheme.onSurface.copy(
        alpha = if (enabled) 1f else CreativeTokens.DisabledAlpha,
    )
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = Modifier.fillMaxWidth().heightIn(min = CreativeTokens.TouchTarget)
            .semantics { if (isError) error(errorMessage) },
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
