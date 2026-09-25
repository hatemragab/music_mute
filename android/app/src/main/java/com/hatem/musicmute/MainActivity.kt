package com.hatem.musicmute

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalConfiguration
import androidx.core.os.LocaleListCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.hatem.musicmute.data.LanguageChoice
import com.hatem.musicmute.state.VocalViewModel
import com.hatem.musicmute.state.ProcessingViewModel
import com.hatem.musicmute.processing.processingNotificationData
import com.hatem.musicmute.processing.audioTaskNotificationTarget
import com.hatem.musicmute.ui.VocalApp
import com.hatem.musicmute.ui.VocalTheme
import com.hatem.musicmute.ui.auth.AuthGate
import com.hatem.musicmute.updates.UpdateGate
import com.hatem.musicmute.updates.UpdateDecision
import com.hatem.musicmute.updates.UpdateInstallState
import com.hatem.musicmute.updates.UpdateTrigger
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {
    private val openHistory = MutableStateFlow(false)
    private val openProcessing = MutableStateFlow(false)
    private val processingJob = MutableStateFlow<String?>(null)
    private val processingOperation = MutableStateFlow<String?>(null)
    private val audioTaskIntent = MutableStateFlow<Intent?>(null)
    private val sharedUrlText = MutableStateFlow<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        openHistory.value = intent.getBooleanExtra(OPEN_HISTORY, false)
        openProcessing.value = intent.getBooleanExtra(OPEN_PROCESSING, false)
        audioTaskIntent.value = intent
        if (savedInstanceState == null) sharedUrlText.value = sharedText(intent)
        (application as VocalApplication).processingPush.rememberTap(processingNotificationData(intent))
        enableEdgeToEdge()
        setContent {
            val app = application as VocalApplication
            val updateState by app.updateCoordinator.state.collectAsStateWithLifecycle()
            val updateInstallState by app.updateInstaller.state.collectAsStateWithLifecycle()
            val updateBlocked =
                updateState.restoring ||
                    updateState.decision == UpdateDecision.REQUIRED
            val updateScope = androidx.compose.runtime.rememberCoroutineScope()
            val model: VocalViewModel =
                viewModel(
                    factory =
                        viewModelFactory {
                            initializer {
                                VocalViewModel(
                                    app.preferencesRepository,
                                )
                            }
                        }
                )
            val state by model.state.collectAsStateWithLifecycle()
            val processingSession by app.processingSessions.collectAsStateWithLifecycle()
            val authState by app.authSession.state.collectAsStateWithLifecycle()
            val pushTap by app.processingPush.pendingTap.collectAsStateWithLifecycle()
            val requestedProcessing by openProcessing.collectAsStateWithLifecycle()
            val requestedJob by processingJob.collectAsStateWithLifecycle()
            val artifacts by app.processingArtifacts.progress.collectAsStateWithLifecycle()
            val processing: ProcessingViewModel = viewModel(factory = viewModelFactory {
                initializer {
                    ProcessingViewModel(app.jobsApi, app.processingRepository, app.audioPipelineCoordinator,
                        app::processingSession, app.contentResolver, app.audioPlayback,
                        app.processingArtifacts::ensureOutput,
                        app.processedAudioShare,
                        app.processingArtifacts::evict,
                        app.clientErrorOutbox)
                }
            })
            LaunchedEffect(processingSession) { processing.bindSession(processingSession) }
            val taskIntent by audioTaskIntent.collectAsStateWithLifecycle()
            LaunchedEffect(taskIntent, processingSession, updateBlocked) {
                if (updateBlocked) return@LaunchedEffect
                audioTaskNotificationTarget(taskIntent, processingSession)?.let { target ->
                    openProcessing.value = true
                    processingOperation.value = target.operationId
                    processingJob.value = target.jobId
                    audioTaskIntent.value = null
                }
            }
            LaunchedEffect(pushTap, processingSession, authState.offline, updateBlocked) {
                if (updateBlocked) return@LaunchedEffect
                app.processingPush.resolvePendingTap()?.let { processingJob.value = it.id }
            }
            LaunchedEffect(app, updateBlocked) {
                if (!updateBlocked) {
                    app.processingPush.refreshHints.collect { processing.history.refreshIfVisible() }
                }
            }
            val requestedHistory by openHistory.collectAsStateWithLifecycle()
            val requestedOperation by processingOperation.collectAsStateWithLifecycle()
            val sharedText by sharedUrlText.collectAsStateWithLifecycle()
            LaunchedEffect(Unit) {
                val style = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT)
                enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
            }
            LaunchedEffect(
                state.preferences.language,
                state.preferencesLoading,
                state.preferencesError,
            ) {
                if (!state.preferencesLoading && !state.preferencesError) {
                    val locales = LocaleListCompat.forLanguageTags(state.preferences.language.tag)
                    if (AppCompatDelegate.getApplicationLocales() != locales) {
                        AppCompatDelegate.setApplicationLocales(locales)
                    }
                }
            }
            VocalTheme(accentArgb = state.preferences.accentArgb) {
                val language = LocalConfiguration.current.locales[0].language
                UpdateGate(
                    state = updateState,
                    install = updateInstallState,
                    currentVersion = BuildConfig.VERSION_NAME,
                    currentBuild = BuildConfig.VERSION_CODE,
                    installer = app.updateInstaller,
                    onUpdate = {
                        val target = updateState.snapshot?.target ?: return@UpdateGate
                        updateScope.launch {
                            if (updateInstallState == UpdateInstallState.PermissionNeeded)
                                app.updateInstaller.onForeground()
                            else app.updateInstaller.start(target)
                        }
                    },
                    onLater = { updateScope.launch { app.updateCoordinator.deferOptional() } },
                    onRetryPolicy = { app.updateCoordinator.requestCheck(UpdateTrigger.RETRY) },
                    onCancelInstall = app.updateInstaller::cancel,
                ) {
                    AuthGate(
                        app.authSession,
                        app.googleCredentials,
                        this@MainActivity,
                        onToggleLanguage = {
                            model.setLanguage(
                                if (language == "ar") LanguageChoice.ENGLISH else LanguageChoice.ARABIC
                            )
                        },
                    ) { onAccount ->
                        VocalApp(state, model, processing, processingSession, artifacts,
                            requestedHistory,
                            sharedUrlText = sharedText,
                            onSharedUrlConsumed = { sharedUrlText.value = null },
                            openProcessing = requestedProcessing, openProcessingJob = requestedJob,
                            openProcessingOperation = requestedOperation,
                            onProcessingOpened = { openProcessing.value = false; processingJob.value = null; processingOperation.value = null; intent.removeExtra(OPEN_PROCESSING) },
                            onProcessingNotifications = { app.processingPush.onForeground() },
                            onAccount = onAccount) {
                            openHistory.value = false
                            intent.removeExtra(OPEN_HISTORY)
                        }
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openHistory.value = intent.getBooleanExtra(OPEN_HISTORY, false)
        openProcessing.value = intent.getBooleanExtra(OPEN_PROCESSING, false)
        audioTaskIntent.value = intent
        sharedUrlText.value = sharedText(intent)
        (application as VocalApplication).processingPush.rememberTap(processingNotificationData(intent))
    }

    override fun onStart() {
        super.onStart()
        val app = application as VocalApplication
        app.processingPush.onForeground()
        app.updateCoordinator.setForeground(true)
    }

    override fun onResume() {
        super.onResume()
        lifecycleScope.launch { (application as VocalApplication).updateInstaller.onForeground() }
    }

    override fun onStop() {
        (application as VocalApplication).updateCoordinator.setForeground(false)
        super.onStop()
    }

    companion object {
        private const val OPEN_HISTORY = "open_download_history"
        private const val OPEN_PROCESSING = "open_processing"

        internal fun sharedText(intent: Intent?): String? =
            if (intent?.action == Intent.ACTION_SEND && intent.type == "text/plain")
                intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString() else null

        fun processingPendingIntent(context: Context): PendingIntent = PendingIntent.getActivity(
            context, 1, Intent(context, MainActivity::class.java).putExtra(OPEN_PROCESSING, true)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        fun historyPendingIntent(context: Context): PendingIntent =
            PendingIntent.getActivity(
                context,
                0,
                Intent(context, MainActivity::class.java)
                    .putExtra(OPEN_HISTORY, true)
                    .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
    }
}
