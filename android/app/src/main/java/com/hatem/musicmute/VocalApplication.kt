package com.hatem.musicmute

import android.app.Application
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import androidx.datastore.core.DataStoreFactory
import androidx.datastore.dataStoreFile
import androidx.datastore.preferences.preferencesDataStore
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.hatem.musicmute.auth.*
import com.hatem.musicmute.data.DataStorePreferencesRepository
import com.hatem.musicmute.data.DemoWorkflowRepository
import com.hatem.musicmute.download.DownloadRepository
import com.hatem.musicmute.download.HistorySerializer
import com.hatem.musicmute.download.HistoryStore
import com.hatem.musicmute.download.YoutubeAudioDownloader
import com.hatem.musicmute.processing.*
import com.hatem.musicmute.playback.AudioPlaybackService
import com.hatem.musicmute.updates.*
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

private val Context.preferencesStore by preferencesDataStore(name = "vocal_preferences")

class VocalApplication : Application(), ProcessingWorkerHost, ProcessingPushHost,
    com.hatem.musicmute.playback.PlaybackDependencies {
    private val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var processingEpoch = System.currentTimeMillis()
    private val mutableProcessingSession = MutableStateFlow<ProcessingSession?>(null)
    val processingSessions = mutableProcessingSession.asStateFlow()
    fun processingSession(): ProcessingSession? = mutableProcessingSession.value
    override fun currentPlaybackSession() = processingSession()
    override val playbackSessions get() = processingSessions
    override val playbackQueueStore by lazy {
        com.hatem.musicmute.playback.PlaybackQueueStore(File(noBackupFilesDir, "playback"))
    }
    val audioPlayback by lazy { com.hatem.musicmute.playback.AudioPlaybackController(this) }
    override suspend fun resolvePlaybackFile(key: com.hatem.musicmute.library.LibraryKey): File =
        libraryRepository.ensureLocal(key)
    val googleCredentials by lazy { GoogleCredentialProvider(this) }
    private val firebaseIdentity by lazy {
        val firebase =
            if (BuildConfig.DEBUG && BuildConfig.AUTH_EMULATOR_HOST.isNotBlank()) {
                require(
                    BuildConfig.AUTH_EMULATOR_HOST in setOf("127.0.0.1", "localhost", "10.0.2.2")
                )
                require(BuildConfig.AUTH_EMULATOR_PORT in 1..65535)
                val options =
                    FirebaseOptions.Builder()
                        .setProjectId("demo-musicmute")
                        .setApplicationId("1:1234567890:android:0000000000000000")
                        .setApiKey("fake-api-key")
                        .build()
                val app =
                    FirebaseApp.getApps(this).firstOrNull { it.name == "auth-emulator" }
                        ?: FirebaseApp.initializeApp(this, options, "auth-emulator")
                FirebaseAuth.getInstance(app).also {
                    it.useEmulator(BuildConfig.AUTH_EMULATOR_HOST, BuildConfig.AUTH_EMULATOR_PORT)
                }
            } else FirebaseAuth.getInstance()
        FirebaseAuthGateway(firebase)
    }
    private val installations by lazy {
            InstallationStore(noBackupFilesDir) {
                InstallationMetadata(
                    appVersion = BuildConfig.VERSION_NAME,
                    buildNumber = BuildConfig.VERSION_CODE,
                    osVersion = Build.VERSION.RELEASE,
                    deviceModel = "${Build.MANUFACTURER} ${Build.MODEL}".take(100),
                )
            }
    }
    val authApi by lazy {
            AuthApiClient(
                AuthConfiguration(BuildConfig.AUTH_API_URL, BuildConfig.DEBUG),
                { firebaseIdentity.identity()?.uid },
                { firebaseIdentity.token(it) },
            )
    }
    private val updateDataStore by lazy {
        DataStoreFactory.create(UpdateStateSerializer) { dataStoreFile("app_updates.json") }
    }
    val updateApi: UpdatePolicyApi by lazy {
        UpdateApiClient(
            AuthConfiguration(BuildConfig.AUTH_API_URL, BuildConfig.DEBUG),
            BuildConfig.UPDATE_DISTRIBUTION,
        )
    }
    val updateCoordinator by lazy {
        UpdateCoordinator(
            applicationScope,
            updateApi,
            DataStoreUpdateStateStore(updateDataStore),
            installedBuild = { installedBuildNumber(this) },
            distribution = BuildConfig.UPDATE_DISTRIBUTION,
            online = ::updatesOnline,
        )
    }
    val updateAdmission by lazy { UpdateAdmission(updateCoordinator.state) }
    val updateInstaller by lazy {
        createUpdateInstaller(this, updateApi) { installedBuildNumber(this) }
    }
    val authSession: AuthSessionCoordinator by lazy {
        AuthSessionCoordinator(firebaseIdentity, authApi, installations, googleCredentials,
            sessionInvalidated = { uid ->
                try { deletionJournal.invalidated(uid) } finally { scheduleOwnerPurge(uid) }
            },
            deletionRejected = { uid -> deletionJournal.rejected(uid) },
            deletionRequested = { uid -> deletionJournal.requested(uid) },
            deletionAccepted = { uid, receipt ->
                try { deletionJournal.accepted(uid, receipt) } finally { scheduleOwnerPurge(uid) }
            },
            hasUnconfirmedDeletion = { deletionJournal.all().any { !it.requiresPurge } },
            afterSignOut = { deletionJournal.all().filter { it.requiresPurge }.forEach { purgeDeletedAccount(it.uid) } },
            beforeSignOut = { uid, installation -> processingPush.beforeSignOut(uid, installation) })
    }
    val processingRoot by lazy { File(noBackupFilesDir, "processing") }
    val processingStore by lazy { ProcessingStore(File(processingRoot, "metadata")) }
    val processingStagingRoot by lazy { File(processingRoot, "staging") }
    val jobsApi: JobsApiClient by lazy {
        JobsApiClient(
            authApi,
            { authSession.state.value.installationId.orEmpty() },
            updateCoordinator::reportProcessingRejected,
        )
    }
    val audioInputPreparer by lazy { AudioInputPreparer(processingStagingRoot, validateDecoded = { file, policy -> com.hatem.musicmute.processing.validateDecodedProcessingAudio(file, policy) }, inspect = ::inspectProcessingAudio) }
    override val processingRepository by lazy {
        ProcessingRepository(
            processingStore,
            processingStagingRoot,
            jobsApi,
            ::processingSession,
            WorkManagerProcessingScheduler(this),
            updateBlocked = updateAdmission::isBlocked,
        )
    }
    val processingUsage by lazy { com.hatem.musicmute.processing.ProcessingUsageRepository(jobsApi, ::processingSession) }
    val audioPipelineCoordinator by lazy {
        AudioPipelineCoordinator(processingRepository, audioInputPreparer, ::processingSession, downloadRepository, processingUsage, com.hatem.musicmute.processing.WorkManagerMediaPreparationScheduler(this), jobsApi::mediaPolicy)
    }
    val clientErrorOutbox by lazy {
        val scheduler = WorkManagerClientErrorScheduler(this)
        ClientErrorOutbox(processingStore, ::processingSession, jobsApi, schedule = scheduler::enqueue)
    }
    val processingArtifacts by lazy {
        JobArtifactRepository(File(processingRoot, "artifacts"), jobsApi, ::processingSession)
    }
    val libraryRepository by lazy {
        com.hatem.musicmute.library.DefaultLibraryRepository(
            processingStore, processingArtifacts, processingSessions, applicationScope,
        )
    }
    val processedAudioShare by lazy {
        ProcessedAudioShare(this, File(filesDir, "processed_audio_share"))
    }
    private fun pushSession(): PushSession? {
        val state = authSession.state.value
        val current = processingSession() ?: return null
        val installation = state.installationId ?: return null
        return if (state.phase == AuthPhase.AUTHENTICATED && !state.offline)
            PushSession(current.uid, current.epoch, installation) else null
    }
    override val processingPush: PushRegistrationCoordinator by lazy {
        PushRegistrationCoordinator(AuthPushRegistrationApi(authApi), jobsApi, ::pushSession,
            { firebaseIdentity.identity()?.uid }, ::firebaseProcessingToken,
            { processingNotificationsPermitted(this) }, processingPushEnabled())
    }

    private val deletionJournal by lazy { AccountDeletionJournal(File(noBackupFilesDir, "pending-account-deletion")) }

    private val privateCleanupLock = Mutex()

    private fun scheduleOwnerPurge(uid: String) {
        applicationScope.launch {
            try { purgeDeletedAccount(uid) }
            catch (_: Exception) { /* Durable marker retries on restart. */ }
        }
    }

    private suspend fun purgeDeletedAccount(uid: String) = privateCleanupLock.withLock {
        require(uid.isNotBlank())
        if (mutableProcessingSession.value?.uid == uid) {
            mutableProcessingSession.value = null
            stopService(android.content.Intent(this, com.hatem.musicmute.playback.AudioPlaybackService::class.java))
        }
        processingRepository.purgeOwner(uid)
        audioPipelineCoordinator.onSessionChanged(uid)
        processingArtifacts.purgeOwner(uid)
        downloadRepository.purgeOwner(uid)
        kotlinx.coroutines.withContext(Dispatchers.IO) {
            listOf(processingStagingRoot, File(filesDir, "processed_audio_share")).forEach { root ->
                purgePrivateOwnerDirectory(root, uid)
            }
        }
        processingStore.clearOwner(uid)
        kotlinx.coroutines.withContext(Dispatchers.IO) { playbackQueueStore.clear(uid) }
        val notifications = getSystemService(android.app.NotificationManager::class.java)
        notifications.activeNotifications.filter { it.notification.group == audioTaskNotificationGroup(uid) }
            .forEach { notifications.cancel(it.tag, it.id) }
        deletionJournal.completed(uid)
    }

    override fun onCreate() {
        super.onCreate()
        val connectivity = getSystemService(ConnectivityManager::class.java)
        val updateNetworkAvailable = AtomicBoolean(updatesOnline())
        connectivity.registerDefaultNetworkCallback(
            object : ConnectivityManager.NetworkCallback() {
                private fun refreshUpdateConnectivity() {
                    val current = updatesOnline()
                    val previous = updateNetworkAvailable.getAndSet(current)
                    if (current && !previous)
                        updateCoordinator.requestCheck(UpdateTrigger.RECONNECT)
                }

                override fun onAvailable(network: Network) {
                    refreshUpdateConnectivity()
                }

                override fun onLost(network: Network) {
                    updateNetworkAvailable.set(false)
                }

                override fun onCapabilitiesChanged(
                    network: Network,
                    capabilities: NetworkCapabilities,
                ) {
                    refreshUpdateConnectivity()
                }
            }
        )
        applicationScope.launch { updateCoordinator.initialize() }
        applicationScope.launch {
            var previouslyRequired = false
            var previouslyBlocked = true
            updateCoordinator.state.collect { state ->
                val required = state.decision == UpdateDecision.REQUIRED
                val blocked = state.restoring || required
                if (required && !previouslyRequired) {
                    stopService(Intent(this@VocalApplication, AudioPlaybackService::class.java))
                    try {
                        audioPipelineCoordinator.pauseForUpdate()
                    } catch (error: CancellationException) {
                        throw error
                    } catch (_: Exception) {
                        // The durable update gate stays authoritative; retained work is retried after update.
                    }
                }
                if (!blocked && previouslyBlocked && processingSession() != null) {
                    try {
                        processingRepository.resumePending()
                        audioPipelineCoordinator.resumePendingSources()
                    } catch (error: CancellationException) {
                        throw error
                    } catch (_: Exception) {
                        // Retained operations remain visible and can be resumed explicitly.
                    }
                }
                previouslyRequired = required
                previouslyBlocked = blocked
            }
        }
        createProcessingNotificationChannel(this, getString(R.string.cloud_processing_title))
        applicationScope.launch {
            recoverAccountPrivateData(
                deletionJournal.all(),
                { firebaseIdentity.identity()?.uid },
                { firebaseIdentity.signOut() },
                ::purgeDeletedAccount,
            )
            var lastPushSession: PushSession? = null
            authSession.state.collect { state ->
                val uid = state.identity?.uid?.takeIf { state.phase == AuthPhase.AUTHENTICATED }
                if (uid != mutableProcessingSession.value?.uid) {
                    val previousUid = mutableProcessingSession.value?.uid
                    mutableProcessingSession.value = uid?.let { ProcessingSession(it, ++processingEpoch) }
                    processingArtifacts.onSessionChanged()
                    try {
                        processingRepository.onSessionChanged()
                        audioPipelineCoordinator.onSessionChanged(previousUid)
                        if (uid != null) {
                            processingRepository.resumePending()
                            audioPipelineCoordinator.resumePendingSources()
                        }
                    } catch (error: CancellationException) { throw error }
                    catch (_: Exception) { /* The processing screen surfaces retained operation errors. */ }
                }
                val updatedPushSession = pushSession()
                if (updatedPushSession != lastPushSession) {
                    lastPushSession = updatedPushSession
                    processingPush.onSessionChanged()
                }
            }
        }
    }

    private fun updatesOnline(): Boolean {
        val connectivity = getSystemService(ConnectivityManager::class.java)
        val network = connectivity.activeNetwork ?: return false
        val capabilities = connectivity.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }
    val preferencesRepository by lazy { DataStorePreferencesRepository(preferencesStore) }
    val workflowRepository by lazy { DemoWorkflowRepository() }
    private val historyStore by lazy {
        HistoryStore(
            DataStoreFactory.create(HistorySerializer) { dataStoreFile("download_history.json") }
        )
    }
    val downloadRepository by lazy {
        DownloadRepository(this, historyStore, File(filesDir, "audio_downloads"), processingStore)
    }
    val audioDownloader by lazy { YoutubeAudioDownloader(this) { jobsApi.mediaPolicy() } }
}
