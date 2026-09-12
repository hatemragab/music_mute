import Foundation
import XCTest

@testable import Vocal

@MainActor final class AudioPipelineCoordinatorTests: XCTestCase {
  func testPastePersistsReferenceBeforeWorkAndDuplicateEventStartsOnce() async throws {
    let fixture = try PipelineFixture()
    await fixture.bind()
    let event = UUID()
    let first = try await fixture.coordinator.acceptURL(
      "https://youtu.be/jNQXAC9IVRw", eventID: event)
    let duplicate = try await fixture.coordinator.acceptURL(
      "https://youtu.be/jNQXAC9IVRw", eventID: event)

    XCTAssertEqual(first, event)
    XCTAssertEqual(duplicate, event)
    XCTAssertEqual(fixture.coordinator.pipelines.map(\.operationId), [event])
    XCTAssertEqual(fixture.coordinator.pipelines.first?.phase, .resolvingSource)
    XCTAssertTrue(fixture.api.creates.isEmpty)

    try await fixture.waitForDownload(event)
    fixture.downloadGate.downloads[event]?.resume(returning: ())
    try await fixture.waitForReview(event)
    XCTAssertTrue(fixture.api.creates.isEmpty)
    await fixture.coordinator.resume(event)
    XCTAssertTrue(fixture.api.creates.isEmpty)
    try await fixture.coordinator.confirmProcessing(event, rightsConfirmed: true)
    try await fixture.waitForCreates(1)
    XCTAssertEqual(fixture.api.creates.first?.requestId, event)
    XCTAssertEqual(fixture.api.creates.first?.metadata.sourceKind, .url)
    XCTAssertEqual(fixture.api.creates.first?.metadata.sourceTitle, "Downloaded title")
    XCTAssertEqual(
      fixture.api.creates.first?.metadata.sourceURL,
      "https://www.youtube.com/watch?v=jNQXAC9IVRw")
  }

  func testExplicitURLAndFileSubmissionsRunAsIndependentPipelines() async throws {
    let fixture = try PipelineFixture()
    await fixture.bind()
    let urlEvent = UUID()
    let fileEvent = UUID()
    let imported = fixture.root.appendingPathComponent("Meeting.mp3")
    try Data([1, 2, 3, 4]).write(to: imported)

    _ = try await fixture.coordinator.acceptURL(
      "https://www.youtube.com/watch?v=jNQXAC9IVRw", eventID: urlEvent)
    _ = try await fixture.coordinator.acceptFile(imported, eventID: fileEvent)

    try await fixture.waitForDownload(urlEvent)
    fixture.downloadGate.downloads[urlEvent]?.resume(returning: ())
    try await fixture.waitForReview(urlEvent)
    try await fixture.waitForReview(fileEvent)
    XCTAssertTrue(fixture.api.creates.isEmpty)
    try await fixture.coordinator.confirmProcessing(urlEvent, rightsConfirmed: true)
    try await fixture.coordinator.confirmProcessing(fileEvent, rightsConfirmed: true)
    try await fixture.waitForCreates(2)
    try await fixture.waitForTransfers(2)
    XCTAssertEqual(Set(fixture.api.creates.map(\.requestId)), Set([urlEvent, fileEvent]))
    let file = try XCTUnwrap(fixture.api.creates.first { $0.requestId == fileEvent })
    XCTAssertEqual(file.metadata.sourceTitle, "Meeting")
    XCTAssertEqual(file.metadata.sourceKind, .file)
    XCTAssertEqual(fixture.transfers.started.count, 2)
  }

  func testReviewSurvivesRebindAndRejectsMissingRightsThenCancelPreservesOriginal() async throws {
    let fixture = try PipelineFixture()
    await fixture.bind()
    let original = fixture.root.appendingPathComponent("Owned.mp3")
    try Data([1, 2, 3, 4]).write(to: original)
    let id = try await fixture.coordinator.acceptFile(original)
    try await fixture.waitForReview(id)
    await fixture.coordinator.bind(nil)
    await fixture.coordinator.bind(fixture.repository.session)
    XCTAssertEqual(fixture.coordinator.pipelines.first?.phase, .awaitingConfirmation)
    XCTAssertTrue(fixture.api.creates.isEmpty)
    do {
      try await fixture.coordinator.confirmProcessing(id, rightsConfirmed: false)
      XCTFail("Rights required")
    } catch { XCTAssertEqual(error as? JobsFailure, .invalidInput) }
    let staged = try XCTUnwrap(fixture.coordinator.pipelines.first?.reviewInput?.fileURL)
    await fixture.coordinator.cancel(id)
    XCTAssertTrue(fixture.api.creates.isEmpty)
    XCTAssertTrue(FileManager.default.fileExists(atPath: original.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: staged.path))
    XCTAssertEqual(fixture.coordinator.pipelines.first?.phase, .cancelled)
  }

  func testStaleCloudStatusCannotRegressPersistedTerminalPipeline() async throws {
    let fixture = try PipelineFixture()
    let event = UUID()
    let jobID = "68c000000000000000000001"
    _ = try await fixture.repository.store.createPipeline(
      operationId: event, ownerUid: "owner-a", sourceKind: .url,
      sourceVideoID: "jNQXAC9IVRw", clientStartedAt: Date())
    _ = try await fixture.repository.store.updatePipeline(id: event, ownerUid: "owner-a") {
      $0.jobId = jobID
      $0.jobStatus = "ready"
      $0.phase = .ready
      $0.completedAt = Date()
    }
    await fixture.bind()

    await fixture.coordinator.reconcile([processingJob(id: jobID, status: "processing")])

    let stored = try await fixture.repository.store.pipeline(id: event, ownerUid: "owner-a")
    let saved = try XCTUnwrap(stored)
    XCTAssertEqual(saved.phase, .ready)
    XCTAssertEqual(saved.jobStatus, "ready")
    await fixture.coordinator.bind(nil)
  }

  func testAwaitingUploadKeepsLocalRecoverableFailure() async throws {
    let fixture = try PipelineFixture()
    let event = UUID()
    let jobID = "68c000000000000000000002"
    _ = try await fixture.repository.store.createPipeline(
      operationId: event, ownerUid: "owner-a", sourceKind: .file,
      sourceTitle: "Unavailable local file", clientStartedAt: Date())
    await fixture.bind()
    _ = try await fixture.repository.store.updatePipeline(id: event, ownerUid: "owner-a") {
      $0.jobId = jobID
      $0.jobStatus = "awaiting_upload"
      $0.phase = .failed
      $0.lastFailureCode = "processing_upload_error"
    }

    await fixture.coordinator.reconcile([processingJob(id: jobID, status: "awaiting_upload")])

    let stored = try await fixture.repository.store.pipeline(id: event, ownerUid: "owner-a")
    let saved = try XCTUnwrap(stored)
    XCTAssertEqual(saved.phase, .failed)
    XCTAssertEqual(saved.lastFailureCode, "processing_upload_error")
    await fixture.coordinator.bind(nil)
  }
}

@MainActor private final class PipelineFixture {
  struct Create {
    let requestId: UUID
    let metadata: JobSourceMetadata
  }
  let root: URL
  let api = API()
  let transfers = Transfers()
  let repository: ProcessingRepository
  let coordinator: AudioPipelineCoordinator
  let downloadGate: DownloadGate

  init() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let staging = root.appendingPathComponent("staging")
    let store = ProcessingStore(root: root.appendingPathComponent("store"), stagingRoot: staging)
    let repository = ProcessingRepository(api: api, store: store, transfers: transfers)
    self.repository = repository
    let preparer = AudioInputPreparer(
      root: staging,
      inspect: { _ in
        AudioInputInspection(
          duration: 4, hasAudio: true, hasVideo: false, isPlayable: true, container: .mp3)
      },
      startAccess: { _ in true }, stopAccess: { _ in }, availableCapacity: { _ in 100_000_000 })
    let downloadGate = DownloadGate(root: root)
    self.downloadGate = downloadGate
    coordinator = AudioPipelineCoordinator(
      store: store, repository: repository, preparer: preparer,
      download: { _, operationID, _, stage, progress in
        stage(.resolving)
        await withCheckedContinuation { downloadGate.downloads[operationID] = $0 }
        stage(.downloading)
        progress(DownloadProgress(downloadedBytes: 4, totalBytes: 4))
        let file = downloadGate.root.appendingPathComponent("\(operationID.uuidString).mp3")
        try Data([1, 2, 3, 4]).write(to: file)
        return PipelineSourceFile(url: file, title: "Downloaded title")
      },
      retrySleep: { _ in })
  }

  func bind() async {
    await repository.setSession(uid: "owner-a")
    await coordinator.bind(repository.session)
  }

  func waitForReview(_ id: UUID) async throws {
    for _ in 0..<2_000 {
      if coordinator.pipelines.first(where: { $0.operationId == id })?.phase
        == .awaitingConfirmation
      {
        return
      }
      try await Task.sleep(for: .milliseconds(1))
    }
    XCTFail("Timed out waiting for review")
  }

  func waitForCreates(_ count: Int) async throws {
    for _ in 0..<2_000 {
      if api.creates.count == count { return }
      try await Task.sleep(for: .milliseconds(1))
    }
    XCTFail("Timed out waiting for creates")
  }

  func waitForTransfers(_ count: Int) async throws {
    for _ in 0..<2_000 {
      if transfers.started.count == count { return }
      try await Task.sleep(for: .milliseconds(1))
    }
    XCTFail("Timed out waiting for transfers")
  }

  func waitForDownload(_ id: UUID) async throws {
    for _ in 0..<2_000 {
      if downloadGate.downloads[id] != nil { return }
      try await Task.sleep(for: .milliseconds(1))
    }
    XCTFail("Timed out waiting for download")
  }

  deinit { try? FileManager.default.removeItem(at: root) }

  @MainActor final class DownloadGate {
    let root: URL
    var downloads: [UUID: CheckedContinuation<Void, Never>] = [:]
    init(root: URL) { self.root = root }
  }

  @MainActor final class API: JobsAPI {
    var creates: [Create] = []
    func create(requestId: UUID, input: InputDeclaration) async throws -> CreateReservation {
      try await create(requestId: requestId, input: input, metadata: JobSourceMetadata())
    }
    func create(
      requestId: UUID, input: InputDeclaration, metadata: JobSourceMetadata
    ) async throws -> CreateReservation {
      creates.append(Create(requestId: requestId, metadata: metadata))
      let id = String(format: "%024d", creates.count)
      return CreateReservation(
        id: id, status: "awaiting_upload",
        upload: UploadGrant(
          method: .put, url: URL(string: "https://storage.fixture.invalid")!,
          headers: [
            "Content-Type": "audio/mpeg", "x-amz-checksum-sha256": "fixture", "If-None-Match": "*",
          ],
          expiresAt: Date().addingTimeInterval(60)),
        requestId: requestId.uuidString.lowercased())
    }
    func renewUpload(id: String) async throws -> UploadGrant {
      UploadGrant(
        method: .put, url: URL(string: "https://storage.fixture.invalid")!,
        headers: [
          "Content-Type": "audio/mpeg", "x-amz-checksum-sha256": "fixture", "If-None-Match": "*",
        ],
        expiresAt: Date().addingTimeInterval(60))
    }
    func confirmUpload(id: String) async throws -> JobMutation {
      JobMutation(id: id, status: "queued", retryOfJobId: nil)
    }
    func list(cursor: String?, status: String?) async throws -> JobPage {
      JobPage(items: [], nextCursor: nil)
    }
    func detail(id: String) async throws -> Job { throw JobsFailure.notFound }
    func cancel(id: String) async throws -> JobMutation {
      JobMutation(id: id, status: "cancelled", retryOfJobId: nil)
    }
    func retry(id: String, requestId: UUID) async throws -> JobMutation {
      throw JobsFailure.notFound
    }
    func download(id: String, artifact: String) async throws -> DownloadGrant {
      throw JobsFailure.notFound
    }
  }

  @MainActor final class Transfers: BackgroundTransferring {
    var onCompletion: ((TransferCompletion) async -> Void)?
    var onProgress: ((TransferContext, TransferProgressSnapshot) -> Void)?
    var started: [TransferContext] = []
    func startUpload(
      file: S3MultipartFile, grant: UploadGrant, context: TransferContext
    ) async throws -> Int {
      started.append(context)
      return started.count
    }
    func activeTransfers() async -> [TransferContext] { started }
    func cancel(ownerUid: String, operationId: UUID?) async {}
    func cancel(context: TransferContext) async {}
  }
}
