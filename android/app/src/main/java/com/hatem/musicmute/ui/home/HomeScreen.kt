package com.hatem.musicmute.ui.home

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
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.hatem.musicmute.R
import com.hatem.musicmute.processing.AudioTaskPresentation
import com.hatem.musicmute.processing.AudioTaskStage
import com.hatem.musicmute.processing.JobHistoryState
import com.hatem.musicmute.ui.design.*
import com.hatem.musicmute.ui.processingFailureLabel
import com.hatem.musicmute.ui.library.DeleteAudioSheet

@Composable
fun HomeScreen(
    tasks: List<AudioTaskPresentation>,
    history: JobHistoryState,
    busy: Boolean,
    onImport: () -> Unit,
    onYoutube: () -> Unit,
    onRefresh: () -> Unit,
    onLoadMore: () -> Unit,
    onOpen: (AudioTaskPresentation) -> Unit,
    onCancel: (AudioTaskPresentation) -> Unit,
    onRetry: (AudioTaskPresentation) -> Unit,
    onDelete: (AudioTaskPresentation, () -> Unit) -> Unit,
    message: String? = null,
    onNotifications: () -> Unit = {},
    miniPlayer: @Composable () -> Unit = {},
    onPhotos: () -> Unit = {},
    actionBusy: Boolean = false,
    youtubeUrl: String = "",
    invalidYoutubeUrl: Boolean = false,
    onYoutubeUrl: (String) -> Unit = {},
    onPasteYoutube: () -> Unit = {},
) {
    var pendingDelete by remember { mutableStateOf<AudioTaskPresentation?>(null) }
    val keyboard = LocalSoftwareKeyboardController.current
    val youtubeBusy = busy || actionBusy
    val continueYoutube = {
        if (!youtubeBusy && youtubeUrl.isNotBlank()) {
            keyboard?.hide()
            onYoutube()
        }
    }
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
        LazyColumn(
            Modifier.weight(1f).widthIn(max = CreativeTokens.ContentWidth).fillMaxWidth(),
            contentPadding = PaddingValues(CreativeTokens.PagePadding),
            verticalArrangement = Arrangement.Top,
        ) {
            item {
                Column(Modifier.fillMaxWidth()) {
                    val appName = stringResource(R.string.app_name)
                    val wordmark = buildAnnotatedString {
                        append(appName)
                        val muteStart = appName.indexOf("Mute")
                        if (muteStart >= 0) addStyle(SpanStyle(color = MaterialTheme.colorScheme.primary),
                            start = muteStart, end = muteStart + "Mute".length)
                    }
                    Text(wordmark, modifier = Modifier.fillMaxWidth(),
                        style = MaterialTheme.typography.headlineLarge.copy(fontSize = 40.sp, lineHeight = 48.sp, letterSpacing = (-1).sp),
                        textAlign = TextAlign.Center, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Spacer(Modifier.height(24.dp))
                    CreativeWave(Modifier.fillMaxWidth().height(56.dp).alpha(0.35f))
                    Spacer(Modifier.height(20.dp))
                    CreativeCard(
                        contentPadding = 10.dp,
                        contentGap = CreativeTokens.CompactGap,
                        shape = RoundedCornerShape(14.dp),
                    ) {
                        CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
                            CompactYoutubeField(
                                value = youtubeUrl, onValueChange = onYoutubeUrl,
                                enabled = !youtubeBusy, isError = invalidYoutubeUrl,
                                onPaste = onPasteYoutube, onDone = continueYoutube,
                            )
                        }
                        if (invalidYoutubeUrl) CreativeFeedback(stringResource(R.string.invalid_url), error = true)
                        if (youtubeUrl.isNotBlank()) {
                            TextButton(onClick = continueYoutube, enabled = !youtubeBusy,
                                modifier = Modifier.align(Alignment.End)) {
                                Text(stringResource(R.string.creative_jobs_continue))
                            }
                        }
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            OutlinedButton(onClick = onImport, enabled = !busy,
                                modifier = Modifier.weight(1f).heightIn(min = CreativeTokens.TouchTarget), shape = RoundedCornerShape(10.dp),
                                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 8.dp)) {
                                Icon(Icons.Outlined.FolderOpen, null, Modifier.size(18.dp))
                                Spacer(Modifier.width(8.dp))
                                Text(stringResource(R.string.creative_home_files), style = MaterialTheme.typography.labelMedium)
                            }
                            OutlinedButton(onClick = onPhotos, enabled = !busy,
                                modifier = Modifier.weight(1f).heightIn(min = CreativeTokens.TouchTarget), shape = RoundedCornerShape(10.dp),
                                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 8.dp)) {
                                Icon(Icons.Outlined.PhotoLibrary, null, Modifier.size(18.dp))
                                Spacer(Modifier.width(8.dp))
                                Text(stringResource(R.string.creative_home_photos), style = MaterialTheme.typography.labelMedium)
                            }
                        }
                    }
                }
                Spacer(Modifier.height(20.dp))
            }
            if (busy || message != null) item {
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (busy) CreativeFeedback(stringResource(R.string.processing_preparing))
                message?.let { CreativeFeedback(it) }
            }
            if (tasks.isEmpty() && !history.loading && history.failure == null && !busy) item {
                CreativeCard { CreativeFeedback(stringResource(R.string.creative_jobs_empty)) }
            }
            items(tasks, key = { it.operationId ?: requireNotNull(it.jobId) }) { task ->
                JobCard(task, busy || actionBusy, { onOpen(task) }, { onCancel(task) }, { onRetry(task) },
                    { pendingDelete = task })
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
                TextButton(onNotifications) { Text(stringResource(R.string.processing_notifications)) }
                Text(stringResource(R.string.processing_notifications_optional),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        miniPlayer()
    }
    val deleting = pendingDelete?.let { selected ->
        tasks.firstOrNull { it.operationId == selected.operationId && it.jobId == selected.jobId }
    }?.takeIf { it.stage == AudioTaskStage.FAILED && it.canDelete }
    if (deleting != null) DeleteAudioSheet(
        deleting.displayName, busy || actionBusy,
        onDismiss = { pendingDelete = null },
        onDelete = { onDelete(deleting) { pendingDelete = null } },
        message = message,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CompactYoutubeField(
    value: String,
    onValueChange: (String) -> Unit,
    enabled: Boolean,
    isError: Boolean,
    onPaste: () -> Unit,
    onDone: () -> Unit,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val errorMessage = stringResource(R.string.invalid_url)
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
                    Text(stringResource(R.string.creative_home_youtube_hint),
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
