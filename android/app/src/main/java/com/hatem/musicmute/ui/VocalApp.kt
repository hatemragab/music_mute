package com.hatem.musicmute.ui

import android.Manifest
import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
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
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.hatem.musicmute.VocalApplication
import com.hatem.musicmute.library.*
import com.hatem.musicmute.playback.QueueTrack
import com.hatem.musicmute.ui.library.*
import com.hatem.musicmute.ui.player.*
import com.hatem.musicmute.state.*
import com.hatem.musicmute.ui.importing.*
import com.hatem.musicmute.ui.settings.*
import com.hatem.musicmute.ui.jobs.SourceDownloadDetailScreen
import com.hatem.musicmute.ui.design.CreativeMotion
import com.hatem.musicmute.ui.design.CreativePage
import com.hatem.musicmute.ui.design.CreativeFeedback
import com.hatem.musicmute.ui.design.rememberCreativeMotionEnabled
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.distinctUntilChanged

private enum class Destination(val label: Int, val icon: ImageVector) {
    Home(R.string.home, Icons.Outlined.Home),
    Library(R.string.creative_library_tab, Icons.Outlined.LibraryMusic),
    Settings(R.string.settings, Icons.Outlined.Tune),
}

private const val TrackDetailRoute = "track_detail/{jobId}"
private const val JobDetailRoute = "processing_detail/{jobId}?operationId={operationId}"
private const val SourceDetailRoute = "source_detail/{operationId}"

private fun taskDetailRoute(operationId: String?, jobId: String?): String = when {
    jobId != null -> "processing_detail/${android.net.Uri.encode(jobId)}" +
        (operationId?.let { "?operationId=${android.net.Uri.encode(it)}" } ?: "")
    operationId != null -> "source_detail/${android.net.Uri.encode(operationId)}"
    else -> Destination.Home.name
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
    val detail = route == JobDetailRoute
    val mainDestination = Destination.entries.any { it.name == route }
    val motionEnabled = rememberCreativeMotionEnabled()
    val motionOffset = with(LocalDensity.current) { 16.dp.roundToPx() } *
        if (LocalLayoutDirection.current == LayoutDirection.Rtl) -1 else 1
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val app = context.applicationContext as VocalApplication
    val libraryModel: LibraryViewModel = viewModel(key = "library:${processingSession?.uid}",
        factory = viewModelFactory { initializer { LibraryViewModel(app.libraryRepository) } })
    val library by libraryModel.state.collectAsStateWithLifecycle()
    val libraryEntries by app.libraryRepository.entries.collectAsStateWithLifecycle()
    val libraryTitles = remember(libraryEntries) { libraryEntries.associate { it.key to it.title } }
    LaunchedEffect(libraryTitles) { app.audioPlayback.updateLibraryTitles(libraryTitles) }
    val selectedLibraryId = when (route) {
        TrackDetailRoute, JobDetailRoute -> entry?.arguments?.getString("jobId")
        else -> null
    }
    var showPlaybackQueue by rememberSaveable(processingSession) { mutableStateOf(false) }
    val processing by processingModel.state.collectAsStateWithLifecycle()
    val jobs by processingModel.history.state.collectAsStateWithLifecycle()
    LaunchedEffect(entry?.id, processingSession) {
        val operationId = entry?.arguments?.getString("operationId")
        if (route in setOf(TrackDetailRoute, JobDetailRoute, SourceDetailRoute) &&
            (jobs.selectedId != selectedLibraryId || processing.selectedOperationId != operationId)) {
            processingModel.clearMessage()
            processingModel.selectTask(operationId, selectedLibraryId)
        }
    }
    val audioTasks = audioTaskPresentations(processing.operations, jobs.jobs, System.currentTimeMillis())
    val selectedTask = audioTasks.firstOrNull {
        (processing.selectedOperationId != null && it.operationId == processing.selectedOperationId) ||
            (jobs.selectedId != null && it.jobId == jobs.selectedId)
    }
    LaunchedEffect(route, selectedTask?.jobId) {
        if (route == SourceDetailRoute && selectedTask?.jobId != null &&
            selectedTask.operationId == entry?.arguments?.getString("operationId")) {
            nav.navigate(taskDetailRoute(selectedTask.operationId, selectedTask.jobId)) {
                popUpTo(SourceDetailRoute) { inclusive = true }
                launchSingleTop = true
            }
        }
    }
    // Progress belongs to the active Player/mini-player, not the entire navigation
    // tree or the lazy Library. Queue and playback-mode changes still reach routes.
    val navigationPlayback = remember(app.audioPlayback) {
        app.audioPlayback.state.map { it.copy(positionMs = 0) }.distinctUntilChanged()
    }
    val voicePlayback by navigationPlayback.collectAsStateWithLifecycle(
        initialValue = com.hatem.musicmute.playback.PlaybackState())
    val currentTrackKey = voicePlayback.queue.getOrNull(voicePlayback.currentIndex)?.key
    val currentLibraryEntry = libraryEntries.firstOrNull { it.key == currentTrackKey }
    val openTrackDetails: (LibraryKey) -> Unit = { key ->
        processingModel.clearMessage()
        processingModel.selectTask(null, key.jobId)
        nav.navigate("track_detail/${android.net.Uri.encode(key.jobId)}") { launchSingleTop = true }
    }
    val playLibraryTrack: (LibraryEntry) -> Unit = { track ->
        if (currentTrackKey == track.key) {
            if (!voicePlayback.playing) app.audioPlayback.togglePlayback()
        } else {
            val tracks = library.entries.filter { !it.hidden }.let { visible ->
                if (visible.any { it.key == track.key }) visible else listOf(track)
            }
            app.audioPlayback.playQueue(tracks.map { QueueTrack(it.key, it.title) }, track.key)
        }
        nav.navigate("player") { launchSingleTop = true }
    }
    val voiceTrackTitle = stringResource(R.string.voice_track)
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(route, lifecycleOwner, processingSession) {
        fun update() { processingModel.history.setVisible(
            (mainDestination || detail || route == SourceDetailRoute || route == TrackDetailRoute) && lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) }
        val observer = LifecycleEventObserver { _, _ -> update() }
        lifecycleOwner.lifecycle.addObserver(observer)
        update()
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer); processingModel.history.setVisible(false) }
    }
    val usage by app.processingUsage.usage.collectAsStateWithLifecycle()
    LaunchedEffect(processingSession) {
        app.processingUsage.clear()
        while (processingSession != null) {
            try { app.processingUsage.refresh() } catch (error: kotlinx.coroutines.CancellationException) { throw error } catch (_: Exception) { }
            kotlinx.coroutines.delay(30_000)
        }
    }
    val importVideo = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) processingModel.importAudio(uri)
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
        nav.navigate(Destination.Home.name) { launchSingleTop = true }
        importAudio.launch(arrayOf("audio/*", "video/*"))
    }
    LaunchedEffect(openProcessing, openProcessingJob, openProcessingOperation) {
        if (openProcessing || openProcessingJob != null || openProcessingOperation != null) {
            nav.navigate(Destination.Home.name) { launchSingleTop = true }
            if (openProcessingJob != null || openProcessingOperation != null) {
                processingModel.selectTask(openProcessingOperation, openProcessingJob)
                nav.navigate(taskDetailRoute(openProcessingOperation, openProcessingJob)) { launchSingleTop = true }
            }
            onProcessingOpened()
        }
    }
    LaunchedEffect(openHistory) {
        if (openHistory) {
            nav.navigate(Destination.Home.name) {
                popUpTo(Destination.Home.name) { saveState = true }
                launchSingleTop = true
                restoreState = true
            }
            onHistoryOpened()
        }
    }
    val noClipboardText = stringResource(R.string.clipboard_empty)
    val downloads by downloadModel.state.collectAsStateWithLifecycle()
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
    var confirmYoutube by remember { mutableStateOf(false) }
    var showYoutubeLink by rememberSaveable { mutableStateOf(false) }
    val start: () -> Unit = {
        if (model.validateYoutubeUrl()) { showYoutubeLink = false; confirmYoutube = true }
    }
    val downloadConfirmed: () -> Unit = {
        if (model.validateYoutubeUrl()) {
            val acceptedUrl = state.url
            model.updateUrl("")
            processingModel.submitUrl(acceptedUrl) {
                nav.navigate(Destination.Home.name) { launchSingleTop = true }
            }
        }
    }
    if (showYoutubeLink) {
        YoutubeLinkSheet(state.url, state.invalidUrl, processing.busy,
            onUrl = model::updateUrl,
            onPaste = {
                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                val clip = clipboard.primaryClip
                val text = if (clip != null && clip.itemCount > 0) clip.getItemAt(0).text?.toString() else null
                if (text.isNullOrBlank()) scope.launch { snackbar.showSnackbar(noClipboardText) }
                else model.updateUrl(text)
            },
            onContinue = start, onDismiss = { showYoutubeLink = false })
    }
    if (confirmYoutube) {
        YoutubeConfirmationSheet(state.url, processing.busy,
            onDismiss = { confirmYoutube = false; showYoutubeLink = true },
            onConfirm = { confirmYoutube = false; downloadConfirmed() })
    }
    if (showPlaybackQueue) {
        PlaybackQueueSheet(voicePlayback, libraryEntries,
            onDismiss = { showPlaybackQueue = false }, onSelect = app.audioPlayback::selectQueueTrack,
            onRemove = app.audioPlayback::removeTrack, onAutoNext = app.audioPlayback::setAutoNext,
            onShuffle = app.audioPlayback::setShuffle, onRepeat = app.audioPlayback::setRepeat,
            orderedTracks = voicePlayback.orderedQueue)
    }
    processing.operations.firstOrNull { it.awaitingCloudConsent && !it.pendingDelete && !it.cancellationRequested }?.let { review ->
        key(processingSession, review.operationId) {
            ImportReviewSheet(
                title = review.displayName + "." + review.input?.extension.orEmpty(),
                bytes = review.input?.bytes,
                durationMs = review.input?.durationSeconds?.let { (it * 1000).toLong() },
                busy = processing.busy,
                onDismiss = { processingModel.discardReview(review.operationId) },
                onConfirm = { processingModel.confirmCloudProcessing(review.operationId, true) },
                error = processing.message?.let { stringResource(it) })
        }
    }
    val backFromJob: () -> Unit = {
        if (nav.previousBackStackEntry?.destination?.route != TrackDetailRoute) processingModel.clearSelection()
        nav.popBackStack()
    }
    BackHandler(enabled = detail, onBack = backFromJob)
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
                if (mainDestination && !wide)
                    NavigationBar {
                        Destination.entries.forEach { destination ->
                            NavigationBarItem(
                                colors = NavigationBarItemDefaults.colors(
                                    selectedIconColor = MaterialTheme.colorScheme.primary,
                                    selectedTextColor = MaterialTheme.colorScheme.primary,
                                    indicatorColor = MaterialTheme.colorScheme.primaryContainer),
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
                if (mainDestination && wide)
                    NavigationRail {
                        Destination.entries.forEach { destination ->
                            NavigationRailItem(
                                colors = NavigationRailItemDefaults.colors(
                                    selectedIconColor = MaterialTheme.colorScheme.primary,
                                    selectedTextColor = MaterialTheme.colorScheme.primary,
                                    indicatorColor = MaterialTheme.colorScheme.primaryContainer),
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
                    enterTransition = { CreativeMotion.enter(motionEnabled, motionOffset) },
                    exitTransition = { CreativeMotion.exit(motionEnabled, motionOffset) },
                    popEnterTransition = { CreativeMotion.enter(motionEnabled, -motionOffset) },
                    popExitTransition = { CreativeMotion.exit(motionEnabled, -motionOffset) },
                ) {
                    composable(Destination.Home.name) {
                        com.hatem.musicmute.ui.home.HomeScreen(
                            tasks = audioTasks, history = jobs, busy = processing.preparing,
                            message = processing.message?.let { stringResource(it) },
                            onNotifications = {
                                if (Build.VERSION.SDK_INT >= 33) processingNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                                else onProcessingNotifications()
                            },
                            onImport = openImport, onYoutube = { showYoutubeLink = true },
                            onPhotos = { importVideo.launch(androidx.activity.result.PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.VideoOnly)) },
                            usage = usage,
                            onRefresh = processingModel.history::refresh,
                            onLoadMore = processingModel.history::loadMore,
                            onOpen = { task ->
                                processingModel.selectTask(task.operationId, task.jobId)
                                nav.navigate(taskDetailRoute(task.operationId, task.jobId)) { launchSingleTop = true }
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
                            miniPlayer = {
                                val miniPlayback by app.audioPlayback.state.collectAsStateWithLifecycle()
                                MiniPlayer(miniPlayback, { nav.navigate("player") },
                                    app.audioPlayback::togglePlayback, app.audioPlayback::next)
                            },
                        )
                    }
                    composable("legacy_library") {
                        val playback by downloadModel.playback.state.collectAsStateWithLifecycle()
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
                                    nav.navigate(Destination.Home.name) { launchSingleTop = true }
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
                        CreativeSettingsScreen(
                            state = state, onProfile = onAccount,
                            onAccent = { nav.navigate("accent") }, onAbout = { nav.navigate("about") },
                            onLanguage = model::setLanguage, onRetry = model::loadPreferences,
                        )
                    }
                    composable("accent") {
                        AccentPickerScreen(state.preferences.accentArgb,
                            onBack = { nav.popBackStack() },
                            onApply = { model.setAccent(it); nav.popBackStack() })
                    }
                    composable("about") { AboutScreen(onBack = { nav.popBackStack() }) }
                    composable(SourceDetailRoute) { sourceBackStack ->
                        audioTasks.firstOrNull { it.operationId == sourceBackStack.arguments?.getString("operationId") }?.let { task ->
                            SourceDownloadDetailScreen(task, processing.busy,
                                onBack = { processingModel.clearSelection(); nav.popBackStack() },
                                onCancel = { task.operationId?.let(processingModel::cancelOperation) },
                                onRetry = { task.operationId?.let(processingModel::resume) },
                                onRefresh = processingModel.history::refresh,
                                onReview = { processingModel.selectTask(task.operationId, task.jobId) },
                                message = processing.message?.let { stringResource(it) })
                        } ?: CreativePage {
                            TextButton({ processingModel.clearSelection(); nav.popBackStack() }) { Text(stringResource(R.string.back)) }
                            CreativeFeedback(stringResource(R.string.creative_jobs_details_unavailable),
                                actionLabel = stringResource(R.string.processing_refresh), onAction = processingModel.history::refresh)
                        }
                    }
                    composable(Destination.Library.name) {
                        LibraryScreen(library, LibraryActions(
                            query = libraryModel::setQuery, filter = libraryModel::setFilter,
                            sort = libraryModel::setSort, play = playLibraryTrack,
                            star = libraryModel::toggleStar, details = openTrackDetails,
                            download = libraryModel::download, hidden = libraryModel::setHidden,
                            home = { navigate(Destination.Home) }, refresh = {
                                libraryModel.refreshLocal(); processingModel.history.refresh()
                            }, openPlayer = { nav.navigate("player") },
                            togglePlayback = app.audioPlayback::togglePlayback, next = app.audioPlayback::next),
                            miniPlayer = {
                                val miniPlayback by app.audioPlayback.state.collectAsStateWithLifecycle()
                                MiniPlayer(miniPlayback, { nav.navigate("player") },
                                    app.audioPlayback::togglePlayback, app.audioPlayback::next)
                            })
                    }
                    composable("player") {
                        val playerState by app.audioPlayback.state.collectAsStateWithLifecycle()
                        PlayerScreen(playerState, currentLibraryEntry, PlayerActions(
                            back = { nav.popBackStack() }, toggle = app.audioPlayback::togglePlayback,
                            seek = app.audioPlayback::seek, next = app.audioPlayback::next,
                            previous = app.audioPlayback::previous, shuffle = app.audioPlayback::setShuffle,
                            repeat = app.audioPlayback::setRepeat, autoNext = app.audioPlayback::setAutoNext,
                            queue = { showPlaybackQueue = true },
                            info = { currentTrackKey?.let(openTrackDetails) },
                            star = { currentTrackKey?.let(libraryModel::toggleStar) }))
                    }
                    composable(TrackDetailRoute) { trackBackStack ->
                        val trackId = trackBackStack.arguments?.getString("jobId")
                        val routeTrack = libraryEntries.firstOrNull { it.key.jobId == trackId }
                        val storedTrackJob by produceState<Job?>(null, routeTrack, processingSession) {
                            value = null
                            routeTrack?.let { track ->
                                try { value = app.libraryRepository.storedJob(track.key) }
                                catch (error: kotlinx.coroutines.CancellationException) { throw error }
                                catch (_: Exception) { /* Retain media actions while metadata is unavailable. */ }
                            }
                        }
                        TrackDetailsScreen(routeTrack,
                            jobs.detail?.takeIf { it.id == trackId } ?: storedTrackJob,
                            processing.busy, processing.message?.let { stringResource(it) },
                            TrackDetailsActions(
                                back = { nav.popBackStack() },
                                play = { routeTrack?.let(playLibraryTrack) },
                                star = { routeTrack?.key?.let(libraryModel::toggleStar) },
                                download = { routeTrack?.let { processingModel.downloadLibraryTrack(it.key, it.title) } },
                                save = { routeTrack?.let { track ->
                                    processingModel.downloadLibraryTrack(track.key, track.title) { file, name ->
                                        processingSession?.let { pendingOutput = file to it; exportOutput.launch(name) }
                                    }
                                } },
                                share = { routeTrack?.let { track ->
                                    processingModel.shareLibraryTrack(track.key, track.title) {
                                        context.startActivity(Intent.createChooser(it, null))
                                    }
                                } },
                                rename = { title -> routeTrack?.let { processingModel.renameLibraryTrack(it.key, title) } },
                                delete = { routeTrack?.let { track ->
                                    processingModel.deleteLibraryTrack(track.key) {
                                        if (nav.currentBackStackEntry == trackBackStack) nav.popBackStack()
                                    }
                                } },
                                hidden = { hidden -> routeTrack?.key?.let { libraryModel.setHidden(it, hidden) } },
                                viewJob = { processingModel.selectTask(null, trackId); nav.navigate(taskDetailRoute(null, trackId)) },
                                refresh = { libraryModel.refreshLocal(); processingModel.history.refresh() }))
                    }
                    composable(JobDetailRoute, arguments = listOf(navArgument("operationId") { nullable = true; defaultValue = null })) { jobBackStack ->
                        val jobId = jobBackStack.arguments?.getString("jobId")
                        val operationId = jobBackStack.arguments?.getString("operationId")
                        val resultTrack = libraryEntries.firstOrNull { it.key.jobId == jobId }
                        val storedJob by produceState<Job?>(null, resultTrack, processingSession) {
                            value = null
                            resultTrack?.let { track ->
                                try { value = app.libraryRepository.storedJob(track.key) }
                                catch (error: kotlinx.coroutines.CancellationException) { throw error }
                                catch (_: Exception) { /* Cached media actions remain available. */ }
                            }
                        }
                        val detailState = jobs.copy(selectedId = jobId, detail = jobs.detail?.takeIf { it.id == jobId } ?: storedJob)
                        val jobTask = audioTasks.firstOrNull { it.jobId == jobId }
                            ?: detailState.detail?.let { audioTaskPresentations(emptyList(), listOf(it), System.currentTimeMillis()).firstOrNull() }
                        val resultKey = jobId?.let { id -> processingSession?.let { LibraryKey(it.uid, id) } }
                        val resultTitle = resultTrack?.title ?: jobTask?.displayName ?: voiceTrackTitle
                        val progress = jobId?.let { artifactProgress[it] }
                        val activeVoice = voicePlayback.queue.getOrNull(voicePlayback.currentIndex)?.key?.let {
                            it.ownerUid == processingSession?.uid && it.jobId == jobId
                        } == true
                        ProcessingDetailScreen(detailState, jobTask, processing.busy,
                            progress?.totalBytes?.takeIf { it > 0 }?.let { (progress.bytes.toDouble() / it).toFloat().coerceIn(0f, 1f) },
                            processing.message, playing = activeVoice && voicePlayback.playing,
                            positionMs = if (activeVoice) voicePlayback.positionMs else 0,
                            durationMs = if (activeVoice) voicePlayback.durationMs else 0,
                            onSeek = processingModel.playback::seek,
                            onBack = backFromJob,
                            onRefresh = processingModel.history::refresh,
                            onCancel = { jobId?.let(processingModel::cancelJob) }, onRetry = { jobId?.let(processingModel::retryJob) },
                            onPlay = {
                                if (resultTrack != null) playLibraryTrack(resultTrack)
                                else if (resultKey != null) {
                                    app.audioPlayback.playQueue(listOf(QueueTrack(resultKey, resultTitle)), resultKey)
                                    nav.navigate("player")
                                }
                            }, onDownload = {
                                resultKey?.let { processingModel.downloadLibraryTrack(it, resultTitle) }
                            },
                            onSave = {
                                val onReady: (File, String) -> Unit = { file, name ->
                                    processingSession?.let { pendingOutput = file to it; exportOutput.launch(name) }
                                }
                                resultKey?.let { processingModel.downloadLibraryTrack(it, resultTitle, onReady) }
                            },
                            onShare = {
                                val onReady: (Intent) -> Unit = { context.startActivity(Intent.createChooser(it, null)) }
                                resultKey?.let { processingModel.shareLibraryTrack(it, resultTitle, onReady) }
                            },
                            onRename = { title -> processingModel.renameTask(operationId, jobId, title) },
                            onDelete = { processingModel.deleteTask(operationId, jobId) {
                                if (nav.currentBackStackEntry == jobBackStack) nav.popBackStack()
                            } },
                            availableOffline = resultTrack?.offlineStatus == OfflineStatus.AVAILABLE)
                    }
                }
            }
        }
    }
}
