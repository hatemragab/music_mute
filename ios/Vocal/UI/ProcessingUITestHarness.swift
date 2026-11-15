#if DEBUG
  import Foundation
  import SwiftUI
  import UIKit

  /// A synthetic landscape cover for offline artwork screenshots; no URL is fetched.
  private func processingArtworkFixture() -> UIImage {
    UIGraphicsImageRenderer(size: CGSize(width: 480, height: 270)).image { context in
      UIColor(red: 0.09, green: 0.38, blue: 0.62, alpha: 1).setFill()
      context.fill(CGRect(x: 0, y: 0, width: 480, height: 270))
      UIColor(red: 1, green: 0.7, blue: 0.25, alpha: 1).setFill()
      context.cgContext.fillEllipse(in: CGRect(x: 250, y: 45, width: 86, height: 86))
      UIColor(red: 0.05, green: 0.22, blue: 0.3, alpha: 1).setFill()
      context.cgContext.move(to: CGPoint(x: 0, y: 270))
      context.cgContext.addLine(to: CGPoint(x: 180, y: 125))
      context.cgContext.addLine(to: CGPoint(x: 355, y: 270))
      context.cgContext.closePath()
      context.cgContext.fillPath()
    }
  }

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
        artifacts: graph.artifacts, push: graph.push, requestNotifications: {},
        libraryOwnerUID: graph.ownerUID
      )
      .environment(\.locale, preferences.locale)
      .environment(\.layoutDirection, preferences.direction)
      .preferredColorScheme(preferences.colorScheme)
      .environment(\.artworkFixturePhase, graph.artworkPhase)
      .overlay(alignment: .bottomTrailing) {
        VStack {
          if ProcessInfo.processInfo.arguments.contains("--processing-fixture-policy-controls") {
            Button(api.linkImportVisible ? "Hide link import" : "Show link import") {
              api.toggleLinkVisibility()
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("fixtureToggleLinkImport")
          }
          VStack {
            fixtureMetric(api.createdCount, id: "fixtureCreatedJobs")
            fixtureMetric(api.outputRequestCount, id: "fixtureOutputRequests")
            fixtureMetric(api.importRequestCount, id: "fixtureImportRequests")
            fixtureMetric(api.importReadCount, id: "fixtureImportReads")
            fixtureMetric(
              FileManager.default.fileExists(
                atPath: graph.importDirectory.appendingPathComponent("Fixture input.mp3").path)
                ? 1 : 0,
              id: "fixtureNativeInputReady")
          }.opacity(0.01)
        }
      }
      .task {
        await graph.processing.bindOwner(graph.ownerUID)
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
    let ownerUID: String
    let importDirectory: URL
    let auth: AuthSessionModel
    let processing: ProcessingModel
    let artifacts: JobArtifactRepository
    let push: PushRegistrationCoordinator
    let api: ProcessingFixtureJobs
    let artworkPhase: AsyncImagePhase?

    init() {
      let args = ProcessInfo.processInfo.arguments
      func value(_ key: String) -> String? {
        guard let index = args.firstIndex(of: key), args.indices.contains(index + 1) else {
          return nil
        }
        return args[index + 1]
      }
      let id = value("--processing-fixture-id").flatMap(UUID.init(uuidString:)) ?? UUID()
      let artworkState = value("--processing-fixture-artwork")
      switch artworkState {
      case "loaded":
        artworkPhase = .success(Image(uiImage: processingArtworkFixture()))
      case "failed":
        artworkPhase = .failure(URLError(.cannotDecodeContentData))
      case "loading":
        artworkPhase = .empty
      default:
        artworkPhase = nil
      }
      ownerUID = "processing-ui-fixture-\(id.uuidString)"
      let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("VocalProcessingUITests/" + id.uuidString)
      let importRoot = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("UITestImports", isDirectory: true)
      // Files keeps every prior fixture visible across launches. Reset only the
      // harness-owned children while retaining the indexed root folder.
      try? FileManager.default.createDirectory(
        at: importRoot, withIntermediateDirectories: true)
      importDirectory = importRoot.appendingPathComponent(id.uuidString, isDirectory: true)
      for staleFixture
        in (try? FileManager.default.contentsOfDirectory(
          at: importRoot, includingPropertiesForKeys: nil)) ?? []
      where UUID(uuidString: staleFixture.lastPathComponent) != nil {
        try? FileManager.default.removeItem(at: staleFixture)
      }
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
      let api = ProcessingFixtureJobs(
        offline: args.contains("--processing-fixture-offline"),
        offlineAfterCache: args.contains("--processing-fixture-offline-after-cache"),
        paginated: args.contains("--processing-fixture-paginated"),
        linkImportVisible: !args.contains("--processing-fixture-link-hidden"),
        legacyPolicy: args.contains("--processing-fixture-legacy-policy"),
        emptyHistory: args.contains("--processing-fixture-empty-history"),
        thumbnailFixture: artworkState != nil)
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
      let originalRepository = JobArtifactRepository(
        api: api, root: root.appendingPathComponent("Originals"),
        sessionProvider: { repository.session },
        transport: ProcessingFixtureArtifacts(), original: true)
      artifacts = artifactRepository
      push = PushRegistrationCoordinator(
        api: ProcessingFixturePush(), jobs: api, session: { nil }, identityUID: { nil },
        tokenSource: { nil }, enabled: false)
      processing = ProcessingModel(
        api: api, repository: repository, preparer: preparer, pipeline: pipeline, player: player,
        outputFile: { try await artifactRepository.preparedOutput(jobId: $0, displayName: $1) },
        libraryPreferences: LibraryPreferencesStore(defaults: defaults),
        originalFile: { try await originalRepository.preparedOutput(jobId: $0, displayName: $1) },
        removeOutput: { await artifactRepository.removeCached(jobId: $0) },
        sessionDidChange: { artifactRepository.onSessionChanged() },
        policyCacheFile: root.appendingPathComponent("Policy/policy.json"))
    }

  }

  @MainActor private final class ProcessingFixtureJobs: ObservableObject, JobsAPI {
    private var jobs: [String: Job] = [:]
    private var retried: [UUID: String] = [:]
    private var created: [UUID: String] = [:]
    private let offline: Bool
    private let offlineAfterCache: Bool
    private let paginated: Bool
    private let legacyPolicy: Bool
    private var policyRevision = 1
    private var policyContinuation: AsyncThrowingStream<Data, Error>.Continuation?
    @Published private(set) var linkImportVisible: Bool
    @Published private(set) var importRequestCount = 0
    @Published private(set) var importReadCount = 0
    @Published private(set) var createdCount = 0
    @Published private(set) var outputRequestCount = 0
    init(
      offline: Bool, offlineAfterCache: Bool = false, paginated: Bool = false,
      linkImportVisible: Bool = true, legacyPolicy: Bool = false, emptyHistory: Bool = false,
      thumbnailFixture: Bool = false
    ) {
      self.offline = offline
      self.offlineAfterCache = offlineAfterCache
      self.paginated = paginated
      self.linkImportVisible = linkImportVisible
      self.legacyPolicy = legacyPolicy
      if !emptyHistory {
        for (index, status) in ["ready", "processing", "failed", "interrupted"].enumerated() {
          let id = String(format: "%024d", index + 1)
          jobs[id] = Self.job(id, status: status)
        }
        if thumbnailFixture {
          let id = String(format: "%024d", 1)
          jobs[id] = Self.job(
            id, status: "ready", sourceTitle: "Fixture video", sourceKind: .url,
            thumbnailUrl: "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg")
          let missingID = String(format: "%024d", 5)
          jobs[missingID] = Self.job(
            missingID, status: "ready", sourceTitle: "Fixture without cover")
        }
      }
    }

    func processingPolicy() async throws -> ProcessingPolicyResponse {
      if offline { throw AuthFailure.offline }
      return try policyResponse()
    }

    func watchProcessingPolicy() -> AsyncThrowingStream<Data, Error>? {
      guard !offline else { return nil }
      return AsyncThrowingStream { policyContinuation = $0 }
    }

    func toggleLinkVisibility() {
      linkImportVisible.toggle()
      policyRevision += 1
      if let response = try? policyResponse(), let data = try? JSONEncoder().encode(response) {
        policyContinuation?.yield(data)
      }
    }

    private func policyResponse() throws -> ProcessingPolicyResponse {
      var payload: [String: Any] = [
        "schemaVersion": 2, "acceptNewJobs": true, "acceptLongJobs": true,
        "limits": [
          "maxDurationSeconds": 1200, "maxPreparedAudioBytes": 50_000_000,
          "maxLocalSourceBytes": 200_000_000, "maxPreparationSeconds": 120,
          "longJobThresholdSeconds": 600,
        ],
        "preparationProfile": [
          "id": "audio-cap-aac-lc-160-v1", "preserveCompatibleAudio": true,
          "fallbackConversion": [
            "codec": "aac-lc", "outputContentType": "audio/mp4", "targetBitrate": 160_000,
          ],
        ],
      ]
      if !legacyPolicy {
        payload["linkImportVisible"] = linkImportVisible
        payload["linkImportPolicyRevision"] = policyRevision
      }
      return try JSONDecoder().decode(
        ProcessingPolicyResponse.self, from: JSONSerialization.data(withJSONObject: payload))
    }

    func createURLImport(url: String, requestId: UUID) async throws -> URLImportView {
      importRequestCount += 1
      return URLImportView(
        importId: String(format: "%024d", 100), status: "downloading", jobId: nil, error: nil)
    }

    func urlImport(id: String) async throws -> URLImportView {
      importReadCount += 1
      return URLImportView(importId: id, status: "downloading", jobId: nil, error: nil)
    }
    private static func job(
      _ id: String, status: String, retryOf: String? = nil, requestId: String? = nil,
      sourceTitle: String? = nil, displayName: String? = nil, sourceKind: JobSourceKind? = .file,
      clientStartedAt: Date? = nil, thumbnailUrl: String? = nil
    ) -> Job {
      let now = Date()
      var result = Job(
        id: id, status: status, createdAt: Date(timeIntervalSince1970: 1_780_000_000),
        updatedAt: now, queuedAt: status == "awaiting_upload" ? nil : now,
        finishedAt: ["ready", "failed", "cancelled"].contains(status) ? now : nil,
        retryOfJobId: retryOf,
        input: .init(extension: "m4a", bytes: 4096, durationSeconds: 4),
        error: status == "failed" ? .init(code: "SEPARATOR_FAILED", at: Date()) : nil,
        canDownloadInput: status == "ready", canDownloadOutput: status == "ready",
        workerAvailable: false,
        requestId: requestId, sourceTitle: sourceTitle ?? "Fixture audio \(id.suffix(2))",
        displayName: displayName, sourceKind: sourceKind, serverTime: now,
        timing: JobTiming(
          processingElapsedMs: status == "ready" ? 2_000 : nil,
          processingElapsedApproximate: false,
          totalElapsedMs: clientStartedAt.map { Int64(max(0, now.timeIntervalSince($0)) * 1_000) },
          totalElapsedApproximate: clientStartedAt != nil),
        stages: nil, thumbnailUrl: thumbnailUrl)
      result.trimEnabled = false
      return result
    }
    func list(cursor: String?, status: String?) async throws -> JobPage {
      if offline || (offlineAfterCache && outputRequestCount >= 2) { throw AuthFailure.offline }
      if paginated {
        if cursor == nil {
          return JobPage(items: jobs.values.sorted { $0.id < $1.id }, nextCursor: "older")
        }
        return JobPage(
          items: [Self.job(String(format: "%024d", 6), status: "ready")], nextCursor: nil)
      }
      return JobPage(items: jobs.values.sorted { $0.id < $1.id }, nextCursor: nil)
    }
    func detail(id: String) async throws -> Job {
      if offline || (offlineAfterCache && outputRequestCount >= 2) { throw AuthFailure.offline }
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
          "Content-Type": "audio/mpeg", "x-amz-checksum-sha256": "fixture",
          "x-amz-meta-sha256": "fixture", "If-None-Match": "*",
        ],
        expiresAt: Date().addingTimeInterval(60))
    }
    func confirmUpload(id: String) async throws -> JobMutation {
      guard let job = jobs[id] else { throw JobsFailure.notFound }
      jobs[id] = Self.copy(job, status: "queued")
      return JobMutation(id: id, status: "queued", retryOfJobId: nil)
    }
    func download(id: String, artifact: String) async throws -> DownloadGrant {
      if offline || (offlineAfterCache && outputRequestCount >= 2) { throw AuthFailure.offline }
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
        sourceKind: job.sourceKind, serverTime: Date(), timing: job.timing, stages: job.stages,
        thumbnailUrl: job.thumbnailUrl)
    }
  }

  @MainActor private final class ProcessingFixtureTransfers: BackgroundTransferring {
    var onCompletion: ((TransferCompletion) async -> Void)?
    var onProgress: ((TransferContext, TransferProgressSnapshot) -> Void)?
    func startUpload(file: ObjectStorageUploadFile, grant: UploadGrant, context: TransferContext)
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
