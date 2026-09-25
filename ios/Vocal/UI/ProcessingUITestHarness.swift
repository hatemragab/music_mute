#if DEBUG
  import Foundation
  import SwiftUI

  /// All mutable state is scoped to a test UUID. No production Firebase, HTTP or OS transfer
  /// object is constructed. The real views, models, store and action coordinator run unchanged.
  @MainActor struct ProcessingUITestHarness: View {
    @StateObject private var graph = ProcessingFixtureGraph()
    var body: some View { ProcessingFixtureContent(graph: graph, preferences: graph.preferences) }
  }

  @MainActor private struct ProcessingFixtureContent: View {
    let graph: ProcessingFixtureGraph
    @ObservedObject var preferences: AppPreferences
    @ObservedObject var api: ProcessingFixtureJobs

    init(graph: ProcessingFixtureGraph, preferences: AppPreferences) {
      self.graph = graph
      self.preferences = preferences
      api = graph.api
    }

    var body: some View {
      VocalRootView(
        preferences: preferences, player: graph.player,
        auth: graph.auth, processing: graph.processing,
        artifacts: graph.artifacts, push: graph.push, requestNotifications: {}
      )
      .environment(\.locale, preferences.locale)
      .environment(\.layoutDirection, preferences.direction)
      .preferredColorScheme(preferences.colorScheme)
      .overlay(alignment: .bottomTrailing) {
        VStack {
          fixtureMetric(api.createdCount, id: "fixtureCreatedJobs")
          fixtureMetric(api.outputRequestCount, id: "fixtureOutputRequests")
        }
        .opacity(0.01)
      }
      .task {
        await graph.processing.bindOwner("processing-ui-fixture")
      }
    }

    private func fixtureMetric(_ value: Int, id: String) -> some View {
      Color.clear.frame(width: 1, height: 1)
        .accessibilityElement(children: .ignore)
        .accessibilityIdentifier(id)
        .accessibilityLabel(String(value))
    }
  }

  @MainActor private final class ProcessingFixtureGraph: ObservableObject {
    let preferences: AppPreferences
    let player = AudioPlayer()
    let importDirectory: URL
    let auth: AuthSessionModel
    let processing: ProcessingModel
    let artifacts: JobArtifactRepository
    let push: PushRegistrationCoordinator
    let api: ProcessingFixtureJobs

    init() {
      let args = ProcessInfo.processInfo.arguments
      func value(_ key: String) -> String? {
        guard let index = args.firstIndex(of: key), args.indices.contains(index + 1) else {
          return nil
        }
        return args[index + 1]
      }
      let id = value("--processing-fixture-id").flatMap(UUID.init(uuidString:)) ?? UUID()
      let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("VocalProcessingUITests/" + id.uuidString)
      importDirectory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("UITestImports/" + id.uuidString, isDirectory: true)
      try? FileManager.default.createDirectory(
        at: importDirectory, withIntermediateDirectories: true)
      try? processingFixtureMP3().write(
        to: importDirectory.appendingPathComponent("Fixture input.mp3"), options: .atomic)
      let defaults = UserDefaults(suiteName: "VocalProcessingUITests." + id.uuidString)!
      defaults.set(value("-language") ?? "en", forKey: "language")
      defaults.set(value("-appearance") ?? "light", forKey: "appearance")
      preferences = AppPreferences(defaults: defaults)
      auth = AuthSessionModel(
        firebase: ProcessingFixtureAuth(), apple: AppleCredentialProvider(),
        installationStore: InstallationStore(file: root.appendingPathComponent("auth.json")),
        api: nil)
      let api = ProcessingFixtureJobs(offline: args.contains("--processing-fixture-offline"))
      self.api = api
      let inputRoot = root.appendingPathComponent("Inputs")
      let repository = ProcessingRepository(
        api: api,
        store: ProcessingStore(
          root: root.appendingPathComponent("Processing"), stagingRoot: inputRoot),
        transfers: ProcessingFixtureTransfers())
      let preparer = AudioInputPreparer(root: inputRoot)
      let pipeline = AudioPipelineCoordinator(
        store: repository.store, repository: repository, preparer: preparer)
      let artifactRepository = JobArtifactRepository(
        api: api, root: root.appendingPathComponent("Outputs"),
        sessionProvider: { repository.session },
        transport: ProcessingFixtureArtifacts())
      artifacts = artifactRepository
      push = PushRegistrationCoordinator(
        api: ProcessingFixturePush(), jobs: api, session: { nil }, identityUID: { nil },
        tokenSource: { nil }, enabled: false)
      processing = ProcessingModel(
        api: api, repository: repository, preparer: preparer, pipeline: pipeline, player: player,
        outputFile: { try await artifactRepository.preparedOutput(jobId: $0, displayName: $1) },
        removeOutput: { await artifactRepository.removeCached(jobId: $0) },
        sessionDidChange: { artifactRepository.onSessionChanged() })
    }

  }

  @MainActor private final class ProcessingFixtureJobs: ObservableObject, JobsAPI {
    private var jobs: [String: Job] = [:]
    private var retried: [UUID: String] = [:]
    private var created: [UUID: String] = [:]
    private let offline: Bool
    @Published private(set) var createdCount = 0
    @Published private(set) var outputRequestCount = 0
    init(offline: Bool) {
      self.offline = offline
      for (index, status) in ["ready", "processing", "failed", "interrupted"].enumerated() {
        let id = String(format: "%024d", index + 1)
        jobs[id] = Self.job(id, status: status)
      }
    }
    private static func job(
      _ id: String, status: String, retryOf: String? = nil, requestId: String? = nil,
      sourceTitle: String? = nil, displayName: String? = nil, sourceKind: JobSourceKind? = .file,
      clientStartedAt: Date? = nil
    ) -> Job {
      let now = Date()
      return Job(
        id: id, status: status, createdAt: Date(timeIntervalSince1970: 1_780_000_000),
        updatedAt: now, queuedAt: status == "awaiting_upload" ? nil : now,
        finishedAt: ["ready", "failed", "cancelled"].contains(status) ? now : nil,
        retryOfJobId: retryOf,
        input: .init(extension: "m4a", bytes: 4096, durationSeconds: 4),
        error: status == "failed" ? .init(code: "SEPARATOR_FAILED", at: Date()) : nil,
        canDownloadInput: false, canDownloadOutput: status == "ready", workerAvailable: false,
        requestId: requestId, sourceTitle: sourceTitle ?? "Fixture audio \(id.suffix(2))",
        displayName: displayName, sourceKind: sourceKind, serverTime: now,
        timing: JobTiming(
          processingElapsedMs: status == "ready" ? 2_000 : nil,
          processingElapsedApproximate: false,
          totalElapsedMs: clientStartedAt.map { Int64(max(0, now.timeIntervalSince($0)) * 1_000) },
          totalElapsedApproximate: clientStartedAt != nil),
        stages: nil)
    }
    func list(cursor: String?, status: String?) async throws -> JobPage {
      if offline { throw AuthFailure.offline }
      return JobPage(items: jobs.values.sorted { $0.id < $1.id }, nextCursor: nil)
    }
    func detail(id: String) async throws -> Job {
      if offline { throw AuthFailure.offline }
      guard let job = jobs[id] else { throw JobsFailure.notFound }
      return job
    }
    func cancel(id: String) async throws -> JobMutation {
      let job = try await detail(id: id)
      let status = job.status == "ready" ? "ready" : "cancel_requested"
      jobs[id] = Self.copy(job, status: status)
      return JobMutation(id: id, status: status, retryOfJobId: nil)
    }
    func retry(id: String, requestId: UUID) async throws -> JobMutation {
      guard try await detail(id: id).status == "failed" else {
        throw JobsFailure.conflict(code: "JOB_STATE_CONFLICT")
      }
      let child = retried[requestId] ?? String(format: "%024d", jobs.count + 1)
      retried[requestId] = child
      jobs[child] = Self.job(child, status: "queued", retryOf: id)
      return JobMutation(id: child, status: "queued", retryOfJobId: id)
    }
    func create(requestId: UUID, input: InputDeclaration) async throws -> CreateReservation {
      try await create(requestId: requestId, input: input, metadata: JobSourceMetadata())
    }
    func create(
      requestId: UUID, input: InputDeclaration, metadata: JobSourceMetadata
    ) async throws -> CreateReservation {
      let id = created[requestId] ?? String(format: "%024d", jobs.count + 1)
      created[requestId] = id
      createdCount = created.count
      jobs[id] = Self.job(
        id, status: "awaiting_upload", requestId: requestId.uuidString.lowercased(),
        sourceTitle: metadata.sourceTitle, displayName: metadata.sourceTitle,
        sourceKind: metadata.sourceKind, clientStartedAt: metadata.clientStartedAt)
      return CreateReservation(
        id: id, status: "awaiting_upload", upload: try await renewUpload(id: id),
        requestId: requestId.uuidString.lowercased())
    }
    func renewUpload(id: String) async throws -> UploadGrant {
      UploadGrant(
        method: .put, url: URL(string: "https://fixture.invalid/upload")!,
        headers: [
          "Content-Type": "audio/mpeg", "x-amz-checksum-sha256": "fixture", "If-None-Match": "*",
        ],
        expiresAt: Date().addingTimeInterval(60))
    }
    func confirmUpload(id: String) async throws -> JobMutation {
      guard let job = jobs[id] else { throw JobsFailure.notFound }
      jobs[id] = Self.copy(job, status: "queued")
      return JobMutation(id: id, status: "queued", retryOfJobId: nil)
    }
    func download(id: String, artifact: String) async throws -> DownloadGrant {
      outputRequestCount += 1
      return DownloadGrant(
        url: URL(string: "https://fixture.invalid/output")!,
        expiresAt: Date().addingTimeInterval(60))
    }
    func rename(id: String, displayName newName: String) async throws -> Job {
      guard let job = jobs[id] else { throw JobsFailure.notFound }
      let updated = Self.copy(job, displayName: newName)
      jobs[id] = updated
      return updated
    }
    func delete(id: String) async throws {
      guard jobs.removeValue(forKey: id) != nil else { throw JobsFailure.notFound }
    }

    private static func copy(
      _ job: Job, status: String? = nil, displayName: String? = nil
    ) -> Job {
      let nextStatus = status ?? job.status
      return Job(
        id: job.id, status: nextStatus, createdAt: job.createdAt, updatedAt: Date(),
        queuedAt: nextStatus == "awaiting_upload" ? nil : job.queuedAt ?? Date(),
        finishedAt: ["ready", "failed", "cancelled"].contains(nextStatus)
          ? job.finishedAt ?? Date() : nil,
        retryOfJobId: job.retryOfJobId, input: job.input,
        error: nextStatus == "failed" ? job.error : nil,
        canDownloadInput: job.canDownloadInput, canDownloadOutput: nextStatus == "ready",
        workerAvailable: job.workerAvailable, requestId: job.requestId,
        sourceTitle: job.sourceTitle, displayName: displayName ?? job.displayName,
        sourceKind: job.sourceKind, serverTime: Date(), timing: job.timing, stages: job.stages)
    }
  }

  @MainActor private final class ProcessingFixtureTransfers: BackgroundTransferring {
    var onCompletion: ((TransferCompletion) async -> Void)?
    var onProgress: ((TransferContext, TransferProgressSnapshot) -> Void)?
    func startUpload(file: S3MultipartFile, grant: UploadGrant, context: TransferContext)
      async throws -> Int
    {
      Task { @MainActor in
        await onCompletion?(TransferCompletion(context: context, statusCode: 204, succeeded: true))
      }
      return 1
    }
    func activeTransfers() async -> [TransferContext] { [] }
    func cancel(context: TransferContext) async {}
    func cancel(ownerUid: String, operationId: UUID?) async {}
  }
  @MainActor private final class ProcessingFixtureArtifacts: ArtifactDownloading {
    func download(
      from source: URL, to destination: URL, progress: @escaping @Sendable (Int64, Int64?) -> Void
    ) async throws {
      let payload = processingFixtureMP3()
      try payload.write(to: destination)
      progress(Int64(payload.count), Int64(payload.count))
    }
  }
  @MainActor private final class ProcessingFixturePush: PushRegistrationAPI {
    func register(installationID: String, token: String) async throws -> PushBinding {
      throw JobsFailure.serviceUnavailable
    }
    func deactivate(installationID: String, expectedBindingRevision: Int64) async throws {}
  }
  @MainActor private final class ProcessingFixtureAuth: FirebaseAuthenticating {
    var identity: IdentitySnapshot? { nil }
    var appleProviderUserID: String? { nil }
    func observe(_ listener: @escaping @MainActor (IdentitySnapshot?) -> Void) -> NSObjectProtocol {
      NSObject()
    }
    func removeObserver(_ handle: NSObjectProtocol) {}
    func idToken(forceRefresh: Bool) async throws -> String { throw AuthFailure.sessionExpired }
    func register(email: String, password: String) async throws -> IdentitySnapshot {
      throw AuthFailure.offline
    }
    func signIn(email: String, password: String) async throws -> IdentitySnapshot {
      throw AuthFailure.offline
    }
    func signIn(apple payload: AppleCredentialPayload) async throws -> IdentitySnapshot {
      throw AuthFailure.offline
    }
    func reload() async throws -> IdentitySnapshot { throw AuthFailure.offline }
    func reauthenticatePassword(_ password: String) async throws { throw AuthFailure.offline }
    func reauthenticateApple(_ payload: AppleCredentialPayload) async throws {
      throw AuthFailure.offline
    }
    func linkPassword(_ password: String) async throws -> IdentitySnapshot {
      throw AuthFailure.offline
    }
    func linkApple(_ payload: AppleCredentialPayload) async throws -> IdentitySnapshot {
      throw AuthFailure.offline
    }
    func unlink(_ provider: ProviderID) async throws -> IdentitySnapshot {
      throw AuthFailure.offline
    }
    func signOut() throws {}
  }
  // Repeated complete MPEG frames of synthetic silence; no user media or runtime encoder.
  private func processingFixtureMP3() -> Data {
    let frame = Data(
      base64Encoded:
        "//NAxAAAAANIAAAAAExBTUUzLjEwMFVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/80LEWwAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/80DEpAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsSjAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQMSkAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NCxKMAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NAxKQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/80LEowAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU="
    )!
    var result = Data()
    for _ in 0..<200 { result.append(frame) }
    return result
  }
#endif
