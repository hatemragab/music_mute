package com.hatem.musicmute.ui

import android.Manifest
import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.hatem.musicmute.BuildConfig
import com.hatem.musicmute.R
import com.hatem.musicmute.data.*
import com.hatem.musicmute.download.audioExportName
import com.hatem.musicmute.download.audioMimeType
import com.hatem.musicmute.download.resolveAudioFile
import com.hatem.musicmute.processing.*
import java.io.File
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.hatem.musicmute.state.*
import kotlin.math.roundToInt
import kotlinx.coroutines.launch

private enum class Destination(val label: Int, val icon: ImageVector) {
    Home(R.string.home, Icons.Outlined.Home),
    Processing(R.string.audio_task_processed_library, Icons.Outlined.GraphicEq),
    Settings(R.string.settings, Icons.Outlined.Tune),
}

@Composable
fun VocalApp(
    state: VocalUiState,
    model: VocalViewModel,
    downloadModel: DownloadsViewModel,
    processingModel: ProcessingViewModel,
    processingSession: ProcessingSession?,
    artifactProgress: Map<String, ArtifactProgress>,
    originalRoot: File,
    openHistory: Boolean = false,
    openProcessing: Boolean = false,
    openProcessingJob: String? = null,
    openProcessingOperation: String? = null,
    onProcessingOpened: () -> Unit = {},
    onProcessingNotifications: () -> Unit = {},
    onAccount: () -> Unit = {},
    onHistoryOpened: () -> Unit = {},
) {
    val nav = rememberNavController()
    val entry by nav.currentBackStackEntryAsState()
    val route = entry?.destination?.route ?: Destination.Home.name
    val detail = route == "processing_detail"
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val processing by processingModel.state.collectAsStateWithLifecycle()
    val jobs by processingModel.history.state.collectAsStateWithLifecycle()
    val audioTasks = audioTaskPresentations(processing.operations, jobs.jobs, System.currentTimeMillis())
    val selectedTask = audioTasks.firstOrNull {
        (processing.selectedOperationId != null && it.operationId == processing.selectedOperationId) ||
            (jobs.selectedId != null && it.jobId == jobs.selectedId)
    }
    val voicePlayback by processingModel.playback.state.collectAsStateWithLifecycle()
    val voiceTrackTitle = stringResource(R.string.voice_track)
    val lifecycleOwner = LocalLifecycleOwner.current
    LaunchedEffect(Unit) { model.selectSource(AudioSource.SAMPLE) }
    DisposableEffect(route, lifecycleOwner, processingSession) {
        fun update() { processingModel.history.setVisible(
            (route == Destination.Processing.name || detail) && lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) }
        val observer = LifecycleEventObserver { _, _ -> update() }
        lifecycleOwner.lifecycle.addObserver(observer)
        update()
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer); processingModel.history.setVisible(false) }
    }
    val importAudio = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) processingModel.importAudio(uri)
    }
    val processingNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { onProcessingNotifications() }
    var pendingOutput by remember { mutableStateOf<Pair<File, ProcessingSession>?>(null) }
    val exportOutput = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("audio/mpeg")) { uri ->
        val output = pendingOutput
        pendingOutput = null
        if (uri != null && output != null && output.second == processingSession)
            processingModel.export(output.first, uri, output.second)
    }
    val openImport: () -> Unit = {
        nav.navigate(Destination.Processing.name) { launchSingleTop = true }
        importAudio.launch(arrayOf("audio/mp4", "audio/webm", "audio/ogg", "audio/aac", "audio/mpeg"))
    }
    LaunchedEffect(openProcessing, openProcessingJob, openProcessingOperation) {
        if (openProcessing || openProcessingJob != null || openProcessingOperation != null) {
            nav.navigate(Destination.Processing.name) { launchSingleTop = true }
            if (openProcessingJob != null || openProcessingOperation != null) {
                processingModel.selectTask(openProcessingOperation, openProcessingJob)
                nav.navigate("processing_detail") { launchSingleTop = true }
            }
            onProcessingOpened()
        }
    }
    LaunchedEffect(openHistory) {
        if (openHistory) {
            nav.navigate(Destination.Processing.name) {
                popUpTo(Destination.Home.name) { saveState = true }
                launchSingleTop = true
                restoreState = true
            }
            onHistoryOpened()
        }
    }
    val noClipboardText = stringResource(R.string.clipboard_empty)
    val downloads by downloadModel.state.collectAsStateWithLifecycle()
    val playback by downloadModel.playback.state.collectAsStateWithLifecycle()
    var pendingSaveId by rememberSaveable { mutableStateOf<String?>(null) }
    val saveAudio =
        rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result
            ->
            val id = pendingSaveId
            pendingSaveId = null
            if (result.resultCode == Activity.RESULT_OK && id != null) {
                result.data?.data?.let { downloadModel.saveToDevice(id, it) }
            }
        }
    var permissionUrl by rememberSaveable { mutableStateOf<String?>(null) }
    val queue: (String) -> Unit = { url ->
        downloadModel.download(url) {
            nav.navigate(Destination.Processing.name) {
                popUpTo(Destination.Home.name) { saveState = true }
                launchSingleTop = true
                restoreState = true
            }
        }
    }
    val notificationPermission =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
            // Notifications are optional: downloads remain visible in the app when permission is
            // denied.
            permissionUrl?.let(queue)
            permissionUrl = null
        }
    var confirmYoutube by remember { mutableStateOf(false) }
    val start: () -> Unit = {
        if (model.validateYoutubeUrl()) confirmYoutube = true
    }
    val downloadConfirmed: () -> Unit = {
        if (model.validateYoutubeUrl()) {
            val acceptedUrl = state.url
            model.updateUrl("")
            processingModel.submitUrl(acceptedUrl) {
                nav.navigate(Destination.Processing.name) { launchSingleTop = true }
            }
        }
    }
    if (confirmYoutube) {
        var rights by remember { mutableStateOf(false) }
        AlertDialog(
            onDismissRequest = { confirmYoutube = false },
            title = { Text(stringResource(R.string.youtube_download_action)) },
            text = { Column {
                Text(stringResource(R.string.youtube_rights_disclosure))
                Row { Checkbox(rights, { rights = it }); Text(stringResource(R.string.audio_rights_confirmation)) }
            } },
            confirmButton = { TextButton(enabled = rights, onClick = { confirmYoutube = false; downloadConfirmed() }) {
                Text(stringResource(R.string.youtube_download_action))
            } },
            dismissButton = { TextButton(onClick = { confirmYoutube = false }) { Text(stringResource(R.string.auth_cancel)) } },
        )
    }
    processing.operations.firstOrNull { it.awaitingCloudConsent && !it.pendingDelete && !it.cancellationRequested }?.let { review ->
        key(processingSession, review.operationId) {
            var rights by remember { mutableStateOf(false) }
            AlertDialog(
                onDismissRequest = {},
                title = { Text(stringResource(R.string.audio_review_title)) },
                text = { Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(review.displayName + "." + review.input?.extension.orEmpty())
                    Text(stringResource(R.string.audio_review_metadata, review.input?.bytes ?: 0L, review.input?.durationSeconds ?: 0.0))
                    if (review.sourceKind == com.hatem.musicmute.processing.SourceKind.URL) Text(stringResource(R.string.youtube))
                    Text(stringResource(R.string.audio_cloud_disclosure))
                    Row { Checkbox(rights, { rights = it }); Text(stringResource(R.string.audio_rights_confirmation)) }
                } },
                confirmButton = { TextButton(enabled = rights && !processing.busy, onClick = {
                    processingModel.confirmCloudProcessing(review.operationId, rights)
                }) { Text(stringResource(R.string.audio_remove_music)) } },
                dismissButton = { TextButton(enabled = !processing.busy, onClick = { processingModel.discardReview(review.operationId) }) {
                    Text(stringResource(R.string.auth_cancel))
                } },
            )
        }
    }
    BackHandler(enabled = detail) { processingModel.clearSelection(); nav.popBackStack() }
    BoxWithConstraints {
        val wide = maxWidth >= 600.dp
        val navigate: (Destination) -> Unit = { destination ->
            nav.navigate(destination.name) {
                popUpTo(Destination.Home.name) { saveState = true }
                launchSingleTop = true
                // Home anchors the stack. Restoring its saved state can reopen the
                // destination previously popped above it instead of showing Home.
                restoreState = destination != Destination.Home
            }
        }
        Scaffold(
            snackbarHost = { SnackbarHost(snackbar) },
            bottomBar = {
                if (!detail && !wide)
                    NavigationBar {
                        Destination.entries.forEach { destination ->
                            NavigationBarItem(
                                selected = route == destination.name,
                                onClick = { navigate(destination) },
                                icon = { Icon(destination.icon, null) },
                                label = { Text(stringResource(destination.label)) },
                            )
                        }
                    }
            },
        ) { padding ->
            Row(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)) {
                if (!detail && wide)
                    NavigationRail {
                        Destination.entries.forEach { destination ->
                            NavigationRailItem(
                                selected = route == destination.name,
                                onClick = { navigate(destination) },
                                icon = { Icon(destination.icon, null) },
                                label = { Text(stringResource(destination.label)) },
                            )
                        }
                    }
                NavHost(
                    nav,
                    startDestination = Destination.Home.name,
                    modifier = Modifier.weight(1f),
                ) {
                    composable(Destination.Home.name) {
                        HomeScreen(
                            state,
                            model::updateUrl,
                            { source -> if (source == AudioSource.SAMPLE) openImport() else model.selectSource(source) },
                            onPaste = {
                                val clipboard =
                                    context.getSystemService(Context.CLIPBOARD_SERVICE)
                                        as ClipboardManager
                                val clip = clipboard.primaryClip
                                val text =
                                    if (clip != null && clip.itemCount > 0)
                                        clip.getItemAt(0).text?.toString()
                                    else null
                                if (text.isNullOrBlank())
                                    scope.launch { snackbar.showSnackbar(noClipboardText) }
                                else {
                                    model.updateUrl(text)

                                }
                            },
                            onStart = { if (state.source == AudioSource.SAMPLE) openImport() else start() },
                            onCommitUrl = {},
                            addingDownload = downloads.adding,
                            downloadError = downloads.actionError,
                        )
                    }
                    composable("legacy_library") {
                        DownloadHistoryScreen(
                            downloads,
                            playback,
                            onStart = { navigate(Destination.Home) },
                            onPlay = downloadModel::play,
                            onSeek = downloadModel.playback::seek,
                            onCancel = downloadModel::cancel,
                            onRetry = downloadModel::retry,
                            onReload = downloadModel::reload,
                            canSave = pendingSaveId == null && downloads.savingId == null,
                            onRemoveMusic = { record ->
                                resolveAudioFile(originalRoot, record.relativePath)?.let { file ->
                                    processingModel.removeMusic(record, file)
                                    nav.navigate(Destination.Processing.name) { launchSingleTop = true }
                                }
                            },
                            onSave = { record ->
                                pendingSaveId = record.id
                                saveAudio.launch(
                                    Intent(Intent.ACTION_CREATE_DOCUMENT)
                                        .addCategory(Intent.CATEGORY_OPENABLE)
                                        .setType(audioMimeType(record.extension))
                                        .putExtra(Intent.EXTRA_TITLE, audioExportName(record))
                                )
                            },
                        )
                    }
                    composable(Destination.Settings.name) {
                        SettingsScreen(
                            state,
                            model::setTheme,
                            model::setLanguage,
                            model::loadPreferences,
                            onAccount,
                        )
                    }
                    composable(Destination.Processing.name) {
                        ProcessingHistoryScreen(jobs, audioTasks, processing.preparing, processing.message,
                            onImport = openImport,
                            onRefresh = processingModel.history::refresh, onMore = processingModel.history::loadMore,
                            onOpen = { task ->
                                processingModel.selectTask(task.operationId, task.jobId)
                                nav.navigate("processing_detail") { launchSingleTop = true }
                            },
                            onCancel = { task ->
                                processingModel.selectTask(task.operationId, task.jobId)
                                if (task.operationId != null) processingModel.cancelOperation(task.operationId)
                                else processingModel.cancelSelected()
                            },
                            onRetry = { task ->
                                processingModel.selectTask(task.operationId, task.jobId)
                                if (task.jobId != null) processingModel.retrySelected()
                                else task.operationId?.let(processingModel::resume)
                            },
                            onDelete = { task ->
                                processingModel.selectTask(task.operationId, task.jobId)
                                nav.navigate("processing_detail") { launchSingleTop = true }
                            },
                            onNotifications = {
                                if (Build.VERSION.SDK_INT >= 33) processingNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                                else onProcessingNotifications()
                            })
                    }
                    composable("processing_detail") {
                        val progress = jobs.selectedId?.let { artifactProgress[it] }
                        val activeVoice = voicePlayback.trackId == "processing:${processingSession?.uid}:${jobs.selectedId}"
                        ProcessingDetailScreen(jobs, selectedTask, processing.busy,
                            progress?.totalBytes?.takeIf { it > 0 }?.let { (progress.bytes.toDouble() / it).toFloat().coerceIn(0f, 1f) },
                            processing.message, playing = activeVoice && voicePlayback.playing,
                            positionMs = if (activeVoice) voicePlayback.positionMs else 0,
                            durationMs = if (activeVoice) voicePlayback.durationMs else 0,
                            onSeek = processingModel.playback::seek,
                            onBack = { processingModel.clearSelection(); nav.popBackStack() },
                            onRefresh = processingModel.history::refresh,
                            onCancel = { processingModel.cancelSelected() }, onRetry = { processingModel.retrySelected() },
                            onPlay = { processingModel.playSelected(voiceTrackTitle) }, onDownload = { processingModel.downloadSelected() },
                            onSave = { processingModel.downloadSelected { file, name ->
                                processingSession?.let { pendingOutput = file to it; exportOutput.launch(name) }
                            } },
                            onShare = { processingModel.shareSelected { share ->
                                context.startActivity(Intent.createChooser(share, null))
                            } },
                            onRename = processingModel::renameSelected,
                            onDelete = { processingModel.deleteSelected { nav.popBackStack() } })
                    }
                }
            }
        }
    }
}

@Composable
private fun Page(content: @Composable ColumnScope.() -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Column(
            Modifier.widthIn(max = 680.dp)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .imePadding()
                .padding(horizontal = 24.dp, vertical = 20.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp),
            content = content,
        )
    }
}

@Composable
private fun Brand() {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            Modifier.size(44.dp)
                .background(MaterialTheme.colorScheme.primaryContainer, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Outlined.GraphicEq, null, tint = MaterialTheme.colorScheme.primary)
        }
        Column {
            Text(stringResource(R.string.app_name), style = MaterialTheme.typography.titleLarge)
            Text(
                stringResource(R.string.brand_caption),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun DemoNotice(message: Int = R.string.demo_notice) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = CircleShape) {
            Text(
                stringResource(R.string.demo_badge),
                Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                style = MaterialTheme.typography.labelSmall,
            )
        }
        Text(
            stringResource(message),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun Heading(title: Int, subtitle: Int) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(stringResource(title), style = MaterialTheme.typography.headlineLarge)
        Text(
            stringResource(subtitle),
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun Panel(content: @Composable ColumnScope.() -> Unit) {
    Card(
        colors =
            CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow)
    ) {
        Column(
            Modifier.fillMaxWidth().padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            content = content,
        )
    }
}

@Composable
private fun Waveform(
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.primary,
) {
    Canvas(modifier.fillMaxWidth().height(64.dp)) {
        val bars = 49
        val gap = size.width / bars
        repeat(bars) { index ->
            val envelope = 1f - kotlin.math.abs(index - bars / 2f) / bars
            val amplitude = (0.12f + ((index * 17 + 9) % 23) / 28f) * envelope
            val height = size.height * amplitude
            drawLine(
                color.copy(alpha = if (index % 4 == 0) 0.45f else 0.9f),
                Offset(gap * (index + 0.5f), (size.height - height) / 2),
                Offset(gap * (index + 0.5f), (size.height + height) / 2),
                strokeWidth = gap * 0.4f,
                cap = StrokeCap.Round,
            )
        }
    }
}

@Composable
fun HomeScreen(
    state: VocalUiState,
    onUrl: (String) -> Unit = {},
    onSource: (AudioSource) -> Unit = {},
    onPaste: () -> Unit = {},
    onStart: () -> Unit = {},
    onCommitUrl: () -> Unit = {},
    addingDownload: Boolean = false,
    downloadError: Boolean = false,
) {
    var urlWasFocused by remember { mutableStateOf(false) }
    var committedWhileFocused by remember { mutableStateOf(false) }
    Page {
        Brand()
        Card(
            colors =
                CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)
        ) {
            Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text(
                    stringResource(R.string.voice_first),
                    style = MaterialTheme.typography.labelMedium,
                )
                Text(
                    stringResource(R.string.hero_title),
                    style = MaterialTheme.typography.headlineLarge,
                )
                Text(
                    stringResource(R.string.hero_description),
                    style = MaterialTheme.typography.bodyLarge,
                )
                Waveform()
            }
        }
        Panel {
            Text(
                stringResource(R.string.choose_source),
                style = MaterialTheme.typography.titleLarge,
            )
            Text(
                stringResource(R.string.choose_source_description),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Button(onClick = { onSource(AudioSource.SAMPLE) }, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.processing_import))
            }
            TextButton(onClick = { onSource(AudioSource.YOUTUBE) }) {
                Text(stringResource(R.string.youtube_secondary))
            }
            if (state.source == AudioSource.YOUTUBE) {
                OutlinedTextField(
                    value = state.url,
                    onValueChange = onUrl,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text(stringResource(R.string.link_label)) },
                    placeholder = { Text(stringResource(R.string.link_placeholder)) },
                    singleLine = true,
                    isError = state.invalidUrl,
                    textStyle = LocalTextStyle.current.copy(textDirection = TextDirection.Ltr),
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Uri,
                        imeAction = ImeAction.Done,
                    ),
                    keyboardActions = KeyboardActions(onDone = {
                        if (!committedWhileFocused) {
                            committedWhileFocused = true
                            onCommitUrl()
                        }
                    }),
                    supportingText = {
                        Text(
                            stringResource(
                                if (state.invalidUrl) R.string.invalid_url else R.string.link_hint
                            )
                        )
                    },
                )
                TextButton(onClick = {
                    committedWhileFocused = true
                    onPaste()
                }, modifier = Modifier.align(Alignment.End)) {
                    Icon(Icons.Outlined.ContentPaste, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.paste))
                }
            } else {
                Icon(
                    Icons.Outlined.AudioFile,
                    null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(32.dp),
                )
                Text(
                    stringResource(R.string.sample_title),
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(
                    stringResource(R.string.sample_subtitle),
                    style = MaterialTheme.typography.labelMedium,
                )
                Text(
                    stringResource(R.string.sample_notice),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            if (downloadError)
                Text(
                    stringResource(R.string.download_action_error),
                    color = MaterialTheme.colorScheme.error,
                )
            Button(
                onClick = onStart,
                enabled = !addingDownload,
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
            ) {
                Text(stringResource(if (state.source == AudioSource.SAMPLE) R.string.processing_import else R.string.youtube_download_action), modifier = Modifier.weight(1f))
                Icon(Icons.AutoMirrored.Outlined.ArrowForward, null)
            }

            if (state.source == AudioSource.YOUTUBE)
                Text(
                    stringResource(R.string.original_quality_notice),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
        }
        Text(stringResource(R.string.how_it_works), style = MaterialTheme.typography.titleLarge)
        Text(
            stringResource(R.string.future_steps),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        listOf(
                Triple(Icons.Outlined.Link, R.string.step_source, R.string.step_source_body),
                Triple(Icons.Outlined.GraphicEq, R.string.step_clean, R.string.step_clean_body),
                Triple(Icons.Outlined.Headphones, R.string.step_save, R.string.step_save_body),
            )
            .forEach { (icon, title, body) ->
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    Icon(icon, null, tint = MaterialTheme.colorScheme.primary)
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(stringResource(title), style = MaterialTheme.typography.titleMedium)
                        Text(
                            stringResource(body),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
    }
}

@Composable
fun WorkflowScreen(
    state: VocalUiState,
    onCancel: () -> Unit = {},
    onRetry: () -> Unit = {},
    onHome: () -> Unit = {},
) {
    Page {
        TextButton(onClick = onHome) {
            Icon(Icons.AutoMirrored.Outlined.ArrowBack, null)
            Spacer(Modifier.width(8.dp))
            Text(stringResource(R.string.back))
        }
        DemoNotice()
        when (val workflow = state.workflow) {
            is WorkflowState.Running -> {
                Heading(R.string.processing_title, R.string.processing_description)
                Panel {
                    Waveform(Modifier.padding(vertical = 24.dp))
                    Text(
                        stringResource(
                            R.string.progress_percent,
                            (workflow.progress * 100).roundToInt(),
                        ),
                        style = MaterialTheme.typography.headlineLarge,
                    )
                    LinearProgressIndicator(
                        progress = { workflow.progress },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    val stages =
                        if (state.source == AudioSource.SAMPLE) WorkflowStage.entries.drop(1)
                        else WorkflowStage.entries
                    stages.forEach { stage ->
                        val active = stage == workflow.stage
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                if (stage.ordinal < workflow.stage.ordinal)
                                    Icons.Outlined.CheckCircle
                                else Icons.Outlined.RadioButtonUnchecked,
                                null,
                                tint =
                                    if (active) MaterialTheme.colorScheme.primary
                                    else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(
                                stringResource(stage.label()),
                                fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                            )
                        }
                    }
                    OutlinedButton(onClick = onCancel, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.cancel_preview))
                    }
                }
            }
            else -> {
                val cancelled = workflow == WorkflowState.Cancelled
                Icon(
                    if (cancelled) Icons.Outlined.PauseCircle else Icons.Outlined.ErrorOutline,
                    null,
                    Modifier.size(56.dp),
                    tint = MaterialTheme.colorScheme.primary,
                )
                Heading(
                    if (cancelled) R.string.cancelled_title else R.string.failed_title,
                    if (cancelled) R.string.cancelled_body else R.string.failed_body,
                )
                Button(onClick = onRetry, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.retry))
                }
                TextButton(onClick = onHome, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.back_home))
                }
            }
        }
    }
}

private fun WorkflowStage.label() =
    when (this) {
        WorkflowStage.DOWNLOADING -> R.string.downloading
        WorkflowStage.PREPARING -> R.string.preparing
        WorkflowStage.REMOVING -> R.string.removing
    }

@Composable
fun ResultScreen(onHome: () -> Unit = {}) {
    var explanation by rememberSaveable { mutableStateOf<Int?>(null) }
    Page {
        Brand()
        Heading(R.string.result_title, R.string.result_description)
        DemoNotice(R.string.result_notice)
        Card(
            colors =
                CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)
        ) {
            Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Icon(Icons.Outlined.GraphicEq, null, modifier = Modifier.size(32.dp))
                Text(
                    stringResource(R.string.voice_track),
                    style = MaterialTheme.typography.headlineMedium,
                )
                Text(stringResource(R.string.voice_track_description))
                Waveform()
                FilledTonalButton(
                    onClick = { explanation = R.string.playback_later },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Icon(Icons.Outlined.PlayArrow, null)
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.listen))
                }
            }
        }
        Panel {
            Text(
                stringResource(R.string.original_track),
                style = MaterialTheme.typography.titleLarge,
            )
            Text(
                stringResource(R.string.original_description),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Waveform(color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedButton(
                onClick = { explanation = R.string.playback_later },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.listen))
            }
        }
        Button(
            onClick = { explanation = R.string.export_later },
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
        ) {
            Icon(Icons.Outlined.FileDownload, null)
            Spacer(Modifier.width(8.dp))
            Text(stringResource(R.string.save_voice))
        }
        TextButton(onClick = onHome, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.new_preview))
        }
    }
    explanation?.let { message ->
        AlertDialog(
            onDismissRequest = { explanation = null },
            title = { Text(stringResource(R.string.coming_later_title)) },
            text = { Text(stringResource(message)) },
            confirmButton = {
                TextButton(onClick = { explanation = null }) {
                    Text(stringResource(R.string.got_it))
                }
            },
        )
    }
}

@Composable
fun LibraryScreen(
    sessions: List<DemoSession>,
    onStart: () -> Unit = {},
    onOpen: (DemoSession) -> Unit = {},
) {
    Page {
        Heading(R.string.library, R.string.library_description)
        if (sessions.isEmpty()) {
            Panel {
                Waveform(Modifier.padding(vertical = 32.dp), MaterialTheme.colorScheme.outline)
                Text(
                    stringResource(R.string.library_empty_title),
                    style = MaterialTheme.typography.headlineMedium,
                )
                Text(
                    stringResource(R.string.library_empty_body),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Button(onClick = onStart, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.preview_workflow))
                }
            }
        } else {
            DemoNotice(R.string.library_memory_notice)
            sessions.forEachIndexed { index, session ->
                key(session.id) {
                    Panel {
                        Text(
                            stringResource(R.string.demo_session, sessions.size - index),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        Text(
                            stringResource(
                                if (session.source == AudioSource.SAMPLE) R.string.sample_title
                                else R.string.youtube_demo
                            ),
                            style = MaterialTheme.typography.titleLarge,
                        )
                        Text(
                            stringResource(R.string.result_notice),
                            style = MaterialTheme.typography.bodySmall,
                        )
                        TextButton(onClick = { onOpen(session) }) {
                            Text(stringResource(R.string.view_result))
                            Spacer(Modifier.width(8.dp))
                            Icon(Icons.AutoMirrored.Outlined.ArrowForward, null)
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun SettingsScreen(
    state: VocalUiState,
    onTheme: (ThemeChoice) -> Unit = {},
    onLanguage: (LanguageChoice) -> Unit = {},
    onRetry: () -> Unit = {},
    onAccount: () -> Unit = {},
) {
    Page {
        Heading(R.string.settings, R.string.settings_description)
        OutlinedButton(
            onClick = onAccount,
            modifier = Modifier.fillMaxWidth().testTag("auth-open-account"),
        ) {
            Column(Modifier.padding(vertical = 8.dp)) {
                Text(
                    stringResource(R.string.auth_account),
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(
                    stringResource(R.string.auth_account_description),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
        if (state.preferencesLoading) {
            LinearProgressIndicator(Modifier.fillMaxWidth())
            Text(stringResource(R.string.loading_preferences))
        }
        if (state.preferencesError) {
            Text(
                stringResource(R.string.preferences_error),
                color = MaterialTheme.colorScheme.error,
            )
            TextButton(onClick = onRetry) { Text(stringResource(R.string.retry)) }
        }
        Panel {
            Text(stringResource(R.string.appearance), style = MaterialTheme.typography.titleLarge)
            Column(Modifier.selectableGroup()) {
                ThemeChoice.entries.forEach { choice ->
                    ChoiceRow(
                        stringResource(
                            when (choice) {
                                ThemeChoice.SYSTEM -> R.string.system_default
                                ThemeChoice.LIGHT -> R.string.light
                                ThemeChoice.DARK -> R.string.dark
                            }
                        ),
                        choice == state.preferences.theme,
                        !state.preferencesLoading && !state.preferencesError,
                    ) {
                        onTheme(choice)
                    }
                }
            }
        }
        Panel {
            Text(stringResource(R.string.language), style = MaterialTheme.typography.titleLarge)
            Column(Modifier.selectableGroup()) {
                LanguageChoice.entries.forEach { choice ->
                    ChoiceRow(
                        stringResource(
                            when (choice) {
                                LanguageChoice.SYSTEM -> R.string.system_default
                                LanguageChoice.ENGLISH -> R.string.english
                                LanguageChoice.ARABIC -> R.string.arabic
                            }
                        ),
                        choice == state.preferences.language,
                        !state.preferencesLoading && !state.preferencesError,
                    ) {
                        onLanguage(choice)
                    }
                }
            }
        }
        Panel {
            Text(stringResource(R.string.about_vocal), style = MaterialTheme.typography.titleLarge)
            Text(stringResource(R.string.about_description))
            HorizontalDivider()
            Text(
                stringResource(R.string.future_flow_title),
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                stringResource(R.string.future_flow_body),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                stringResource(R.string.original_quality_notice),
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Text(
            stringResource(
                R.string.version_label,
                BuildConfig.VERSION_NAME,
                BuildConfig.VERSION_CODE,
            ),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ChoiceRow(label: String, selected: Boolean, enabled: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth()
            .heightIn(min = 52.dp)
            .selectable(selected, enabled = enabled, role = Role.RadioButton, onClick = onClick)
            .padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected, onClick = null, enabled = enabled)
        Text(label, Modifier.weight(1f))
    }
}
