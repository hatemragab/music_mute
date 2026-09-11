import FirebaseCore
import SwiftUI
import UserNotifications

@MainActor private final class PushCoordinatorReference {
  weak var coordinator: PushRegistrationCoordinator?
}

@main struct VocalApp: App {
  @UIApplicationDelegateAdaptor(ProcessingAppDelegate.self) private var appDelegate
  var body: some Scene {
    WindowGroup {
      #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--processing-ui-fixture") {
          ProcessingUITestHarness()
        } else {
          ProductionVocalView()
        }
      #else
        ProductionVocalView()
      #endif
    }
  }
}

private struct ProductionVocalView: View {
  // StateObject evaluates this graph only for a new SwiftUI identity, never on a value rebuild.
  @StateObject private var graph = ProductionAppGraph()
  var body: some View { ProductionContentView(graph: graph) }
}

@MainActor private final class ProductionAppGraph: ObservableObject {
  let preferences = AppPreferences()
  let player: AudioPlayer
  let downloads: DownloadModel
  let auth: AuthSessionModel
  let processing: ProcessingModel
  let artifacts: JobArtifactRepository
  let push: PushRegistrationCoordinator
  let notificationDelegate: NotificationDelegate
  let files: AudioFiles

  init() {
    if FirebaseApp.app() == nil { FirebaseApp.configure() }
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[
      0
    ]
    .appendingPathComponent("Vocal", isDirectory: true)
    let files = AudioFiles(root: support.appendingPathComponent("Audio", isDirectory: true))
    self.files = files
    let audioService = YouTubeAudioService(
      files: files, sourceTransfers: BackgroundSourceTransferCoordinator.shared)
    downloads = DownloadModel(
      service: audioService,
      history: HistoryStore(file: support.appendingPathComponent("history.json")))
    let firebase = FirebaseAuthGateway()
    let installationStore = InstallationStore.applicationStore()
    let configuration = try? AuthConfiguration.load()
    let api = configuration.map {
      AuthAPIClient(configuration: $0, tokenSource: firebase)
    }
    let pushReference = PushCoordinatorReference()
    let auth = AuthSessionModel(
      firebase: firebase, apple: AppleCredentialProvider(),
      installationStore: installationStore, api: api,
      beforeSignOut: { uid, installationID in
        await pushReference.coordinator?.beforeSignOut(uid: uid, installationID: installationID)
      })
    self.auth = auth
    let jobs: JobsAPI =
      configuration.map {
        JobsAPIClient(
          configuration: $0, tokenSource: firebase,
          installationId: { [weak auth] in auth?.currentInstallationID }) as JobsAPI
      } ?? UnavailableJobsAPI()
    let staging = support.appendingPathComponent("ProcessingInputs", isDirectory: true)
    let repository = ProcessingRepository(
      api: jobs,
      store: ProcessingStore(
        root: support.appendingPathComponent("Processing", isDirectory: true), stagingRoot: staging),
      transfers: BackgroundTransferCoordinator.shared)
    let diagnostics = ClientErrorOutbox(
      root: support.appendingPathComponent("ProcessingDiagnostics", isDirectory: true))
    let reportFailure: AudioPipelineCoordinator.FailureReporter = {
      fence, operationID, jobID, stage, error in
      let version =
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        ?? "unknown"
      let event = ClientErrorOutbox.makeEvent(
        operationId: operationID, jobId: jobID, stage: stage, error: error,
        appVersion: version, osVersion: UIDevice.current.systemVersion)
      try? await diagnostics.enqueue(event, ownerUid: fence.uid)
      await diagnostics.flush(
        fence: fence, api: jobs, currentSession: { [weak repository] in repository?.session })
    }
    repository.onFailure = reportFailure
    let preparer = AudioInputPreparer(root: staging)
    let pipeline = AudioPipelineCoordinator(
      store: repository.store, repository: repository, preparer: preparer,
      download: { videoID, operationID, ownerUid, stage, progress in
        let saved = try await audioService.downloadForProcessing(
          videoID: videoID, id: operationID, ownerUid: ownerUid, stage: stage, progress: progress)
        guard let url = files.url(for: saved.relativePath) else { throw AudioFailure.storage }
        return PipelineSourceFile(url: url, title: saved.title)
      },
      reportFailure: reportFailure,
      flushDiagnostics: { fence in
        await diagnostics.flush(
          fence: fence, api: jobs, currentSession: { [weak repository] in repository?.session })
      },
      sourceSessionChanged: { await BackgroundSourceTransferCoordinator.shared.bind(ownerUid: $0) },
      cancelSourceTransfer: {
        await BackgroundSourceTransferCoordinator.shared.cancel(ownerUid: $0, operationId: $1)
      })
    let artifacts = JobArtifactRepository(
      api: jobs,
      root: support.appendingPathComponent("ProcessingOutputs", isDirectory: true),
      sessionProvider: { [weak repository] in repository?.session })
    let pushAPI: PushRegistrationAPI =
      configuration.map {
        PushRegistrationAPIClient(
          configuration: $0, tokenSource: firebase,
          identityUID: { [weak firebase] in firebase?.identity?.uid }) as PushRegistrationAPI
      } ?? UnavailablePushRegistrationAPI()
    let push = PushRegistrationCoordinator(
      api: pushAPI, jobs: jobs,
      session: { [weak repository, weak auth] in
        guard auth?.phase == .authenticated, auth?.isOffline == false,
          let fence = repository?.session,
          let installationID = auth?.currentInstallationID
        else { return nil }
        return PushSession(uid: fence.uid, epoch: fence.epoch, installationID: installationID)
      }, identityUID: { [weak firebase] in firebase?.identity?.uid },
      tokenSource: { await firebaseProcessingToken() },
      enabled: nativeProcessingPushTransportEnabled())
    pushReference.coordinator = push
    self.push = push
    let notificationDelegate = NotificationDelegate(coordinator: push)
    self.notificationDelegate = notificationDelegate
    notificationDelegate.install()
    self.artifacts = artifacts
    let player = AudioPlayer()
    self.player = player
    processing = ProcessingModel(
      api: jobs, repository: repository,
      preparer: preparer, pipeline: pipeline, player: player,
      outputFile: { try await artifacts.preparedOutput(jobId: $0, displayName: $1) },
      removeOutput: { await artifacts.removeCached(jobId: $0) },
      sessionDidChange: {
        artifacts.onSessionChanged()
        push.sessionChanged()
      }, reportFailure: reportFailure)
    let processing = self.processing
    auth.purgeAccountData = { uid in
      var owned: [AudioPipelineIntent] = []
      var jobs: [Job] = []
      do {
        owned = try await repository.store.pipelines(ownerUid: uid)
        jobs = try await repository.store.cachedJobs(ownerUid: uid)
      } catch ProcessingStoreFailure.missingOperation {
        owned = []
        jobs = []
      }
      let ownedJobIDs = Set(owned.compactMap(\.jobId) + jobs.map(\.id))
      let notifications = UNUserNotificationCenter.current()
      let delivered = await notifications.deliveredNotifications()
      let pending = await notifications.pendingNotificationRequests()
      notifications.removeDeliveredNotifications(
        withIdentifiers: delivered.filter {
          processingJobHint($0.request.content.userInfo).map { ownedJobIDs.contains($0.jobID) }
            == true
        }.map { $0.request.identifier })
      notifications.removePendingNotificationRequests(
        withIdentifiers: pending.filter {
          processingJobHint($0.content.userInfo).map { ownedJobIDs.contains($0.jobID) } == true
        }.map(\.identifier))
      if repository.session?.uid == uid { await processing.bindOwner(nil) }
      if repository.session == nil { player.stopAndClear() }
      try await BackgroundSourceTransferCoordinator.shared.purge(ownerUid: uid)
      try await artifacts.purge(ownerUid: uid)
      for intent in owned where intent.sourceKind == .url {
        try await files.purgePrivateAttempt(intent.operationId)
      }
      try await preparer.purge(ownerUid: uid)
      try await diagnostics.purge(ownerUid: uid)
      try await repository.store.purge(ownerUid: uid)
    }
  }

}

private struct ProductionContentView: View {
  @ObservedObject private var preferences: AppPreferences
  @ObservedObject private var player: AudioPlayer
  @ObservedObject private var downloads: DownloadModel
  @ObservedObject private var auth: AuthSessionModel
  @ObservedObject private var processing: ProcessingModel
  @ObservedObject private var artifacts: JobArtifactRepository
  @ObservedObject private var push: PushRegistrationCoordinator
  private let notificationDelegate: NotificationDelegate
  private let files: AudioFiles
  @Environment(\.scenePhase) private var scenePhase

  init(graph: ProductionAppGraph) {
    preferences = graph.preferences
    player = graph.player
    downloads = graph.downloads
    auth = graph.auth
    processing = graph.processing
    artifacts = graph.artifacts
    push = graph.push
    notificationDelegate = graph.notificationDelegate
    files = graph.files
  }

  var body: some View {
    AuthGate(model: auth) {
      VocalRootView(
        preferences: preferences, downloads: downloads, player: player, files: files, auth: auth,
        processing: processing, artifacts: artifacts, push: push,
        requestNotifications: { Task { await notificationDelegate.requestPermission() } })
    }
    .environment(\.locale, preferences.locale)
    .environment(\.layoutDirection, preferences.direction)
    .preferredColorScheme(preferences.colorScheme)
    .task {
      auth.start()
      await downloads.load()
      await notificationDelegate.refreshAuthorization()
    }
    .task(id: "\(auth.phase):\(auth.identity?.uid ?? "")") {
      if auth.phase == .authenticated {
        await processing.bindOwner(auth.identity?.uid)
      } else if processing.repository.session != nil || auth.phase == .signedOut
        || auth.phase == .blocked
      {
        await processing.bindOwner(nil)
      }
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active {
        auth.validateOnForeground()
        Task {
          await notificationDelegate.refreshAuthorization()
          await processing.resumePending()
        }
      }
    }
    .onChange(of: auth.currentInstallationID) { _, _ in push.sessionChanged() }
    .onChange(of: auth.isOffline) { _, _ in push.sessionChanged() }
  }
}

struct VocalRootView: View {
  @ObservedObject var preferences: AppPreferences
  @ObservedObject var downloads: DownloadModel
  @ObservedObject var player: AudioPlayer
  let files: AudioFiles
  @ObservedObject var auth: AuthSessionModel
  @ObservedObject var processing: ProcessingModel
  @ObservedObject var artifacts: JobArtifactRepository
  @ObservedObject var push: PushRegistrationCoordinator
  var requestNotifications: () -> Void
  @Environment(\.colorScheme) private var scheme
  @Environment(\.scenePhase) private var scenePhase
  @State private var tab = 0
  var body: some View {
    TabView(selection: $tab) {
      NavigationStack {
        HomeView(
          model: downloads, acceptURL: processing.acceptURL,
          beginImport: processing.beginSourceImport,
          importAudio: processing.importAudio, reportImportFailure: processing.reportImportFailure,
          showProcessing: { tab = 2 }
        ) { tab = 1 }
        .background(
          VocalStyle.background(scheme))
      }
      .tabItem { Label("home_tab", systemImage: "house") }.tag(0)
      NavigationStack {
        HistoryView(
          model: downloads, player: player, files: files,
          removeMusic: {
            if let url = files.url(for: $0.relativePath) {
              processing.removeMusic(from: url)
              tab = 2
            }
          }
        ) { tab = 0 }.background(
          VocalStyle.background(scheme))
      }
      .tabItem { Label("history_tab", systemImage: "music.note.list") }.tag(1)
      NavigationStack {
        ProcessingRootView(
          model: processing, repository: processing.repository, player: player,
          outputProgress: artifacts.progress.mapValues { progress in
            progress.totalBytes.map { Double(progress.receivedBytes) / Double($0) }
          }, requestNotifications: requestNotifications
        )
        .background(VocalStyle.background(scheme))
      }
      .tabItem { Label("processing_title", systemImage: "waveform") }.tag(2)
      NavigationStack {
        SettingsView(preferences: preferences, auth: auth).background(VocalStyle.background(scheme))
      }
      .tabItem { Label("settings_tab", systemImage: "slider.horizontal.3") }.tag(3)
    }.tint(scheme == .dark ? VocalStyle.mint : VocalStyle.teal)
      .task(id: tab == 2 && scenePhase == .active) {
        processing.history.setVisible(tab == 2 && scenePhase == .active)
      }
      .onDisappear { processing.history.setVisible(false) }
      .task(
        id:
          "\(push.pendingTap?.eventID ?? ""):\(processing.sessionReady):\(scenePhase == .active):\(auth.isOffline)"
      ) {
        guard processing.sessionReady, scenePhase == .active, !auth.isOffline else { return }
        if let job = try? await push.resolvePendingTap() {
          processing.selectedJobID = job.id
          tab = 2
        }
      }
      .onChange(of: push.refreshHint) { _, _ in
        guard tab == 2, scenePhase == .active else { return }
        Task { await processing.history.refresh() }
      }
  }
}
