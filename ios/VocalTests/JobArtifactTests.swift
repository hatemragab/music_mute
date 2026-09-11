import Foundation
import XCTest

@testable import Vocal

@MainActor final class JobArtifactTests: XCTestCase {
  private var root: URL!
  private var api: ArtifactJobsFixture!
  private var transfer: ArtifactDownloadFixture!
  private var fence: SessionFence?
  private let jobId = "68c000000000000000000001"

  override func setUp() async throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    api = ArtifactJobsFixture()
    transfer = ArtifactDownloadFixture()
    fence = SessionFence(uid: "owner-a", epoch: 1)
  }

  override func tearDown() async throws {
    try? FileManager.default.removeItem(at: root)
  }

  private func repository() -> JobArtifactRepository {
    JobArtifactRepository(
      api: api, root: root, sessionProvider: { [weak self] in self?.fence }, transport: transfer,
      validate: { file in
        guard try Data(contentsOf: file) == Data("fixture-mp3".utf8) else {
          throw JobArtifactFailure.invalidOutput
        }
      })
  }

  func testReadyStateDoesNotDownloadAndExplicitActionsReuseValidatedCache() async throws {
    let repository = repository()
    XCTAssertEqual(transfer.calls, 0)
    XCTAssertEqual(api.downloadCalls, 0)
    let first = try await repository.ensureOutput(jobId: jobId)
    let second = try await repository.ensureOutput(jobId: jobId)
    XCTAssertEqual(first, second)
    XCTAssertEqual(transfer.calls, 1)
    XCTAssertEqual(api.downloadCalls, 1)
    XCTAssertEqual(try Data(contentsOf: first), Data("fixture-mp3".utf8))
    XCTAssertTrue(
      try first.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
  }

  func testConcurrentActionsCoalesce() async throws {
    let repository = repository()
    var resume: CheckedContinuation<Void, Error>?
    transfer.handler = { _, destination, progress in
      try await withCheckedThrowingContinuation { resume = $0 }
      try Data("fixture-mp3".utf8).write(to: destination)
      progress(11, nil)
    }
    let first = Task { try await repository.ensureOutput(jobId: jobId) }
    let second = Task { try await repository.ensureOutput(jobId: jobId) }
    while resume == nil { await Task.yield() }
    XCTAssertEqual(transfer.calls, 1)
    resume?.resume()
    let firstURL = try await first.value
    let secondURL = try await second.value
    XCTAssertEqual(firstURL, secondURL)
    XCTAssertEqual(api.downloadCalls, 1)
  }

  func testExpiredStorageGrantRefreshesAuthoritativeStateWithinBudget() async throws {
    let repository = repository()
    transfer.handler = { [weak transfer] _, destination, _ in
      if transfer?.calls == 1 { throw ArtifactDownloadFailure.httpStatus(403) }
      try Data("fixture-mp3".utf8).write(to: destination)
    }
    _ = try await repository.ensureOutput(jobId: jobId)
    XCTAssertEqual(transfer.calls, 2)
    XCTAssertEqual(api.detailCalls, 2)
    XCTAssertEqual(api.downloadCalls, 2)
  }

  func testGrantRenewalStopsWhenJobIsNoLongerReady() async throws {
    let repository = repository()
    transfer.handler = { [weak api] _, _, _ in
      api?.status = "failed"
      throw ArtifactDownloadFailure.httpStatus(403)
    }
    do {
      _ = try await repository.ensureOutput(jobId: jobId)
      XCTFail("Expected unavailable output")
    } catch {
      XCTAssertEqual(error as? JobArtifactFailure, .unavailable)
    }
    XCTAssertEqual(transfer.calls, 1)
    XCTAssertEqual(api.downloadCalls, 1)
  }

  func testRepeatedForbiddenResponseHasBoundedRenewal() async throws {
    let repository = repository()
    transfer.handler = { _, _, _ in throw ArtifactDownloadFailure.httpStatus(403) }
    do {
      _ = try await repository.ensureOutput(jobId: jobId)
      XCTFail("Expected transfer failure")
    } catch {
      XCTAssertEqual(error as? ArtifactDownloadFailure, .httpStatus(403))
    }
    XCTAssertEqual(transfer.calls, 2)
    XCTAssertEqual(api.downloadCalls, 2)
  }

  func testInvalidOutputAndInterruptedPartialNeverBecomeCache() async throws {
    for content in [Data(), Data("<html>unavailable</html>".utf8), Data("not an mp3".utf8)] {
      let repository = repository()
      transfer.payload = content
      do {
        _ = try await repository.ensureOutput(jobId: jobId)
        XCTFail("Expected invalid output")
      } catch {
        XCTAssertEqual(error as? JobArtifactFailure, .invalidOutput)
      }
      XCTAssertFalse(FileManager.default.fileExists(atPath: outputURL().path))
    }
    let repository = repository()
    transfer.handler = { _, destination, _ in
      try Data("partial".utf8).write(to: destination)
      throw ArtifactDownloadFailure.interrupted
    }
    do {
      _ = try await repository.ensureOutput(jobId: jobId)
      XCTFail("Expected interrupted output")
    } catch {}
    XCTAssertFalse(FileManager.default.fileExists(atPath: outputURL().path))
    let files = try FileManager.default.contentsOfDirectory(
      atPath: outputURL().deletingLastPathComponent().path)
    XCTAssertFalse(files.contains { $0.hasSuffix(".partial") })
  }

  func testCorruptCacheIsReplacedOnlyAfterValidReplacementArrives() async throws {
    let repository = repository()
    try FileManager.default.createDirectory(
      at: outputURL().deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("broken".utf8).write(to: outputURL())
    transfer.handler = { _, _, _ in throw ArtifactDownloadFailure.interrupted }
    do { _ = try await repository.ensureOutput(jobId: jobId) } catch {}
    XCTAssertEqual(try Data(contentsOf: outputURL()), Data("broken".utf8))
    transfer.handler = nil
    let result = try await repository.ensureOutput(jobId: jobId)
    XCTAssertEqual(try Data(contentsOf: result), Data("fixture-mp3".utf8))
  }

  func testSameUidNewEpochFencesLateBytesAndClearsProgress() async throws {
    let repository = repository()
    var resume: CheckedContinuation<Void, Error>?
    transfer.handler = { _, destination, progress in
      progress(3, nil)
      try await withCheckedThrowingContinuation { resume = $0 }
      try Data("fixture-mp3".utf8).write(to: destination)
      progress(11, 11)
    }
    let task = Task { try await repository.ensureOutput(jobId: jobId) }
    while resume == nil { await Task.yield() }
    fence = SessionFence(uid: "owner-a", epoch: 2)
    repository.onSessionChanged()
    resume?.resume()
    do {
      _ = try await task.value
      XCTFail("Expected session fence")
    } catch {
      XCTAssertTrue(error is CancellationError)
    }
    XCTAssertTrue(repository.progress.isEmpty)
    XCTAssertFalse(FileManager.default.fileExists(atPath: outputURL().path))
  }

  func testAnotherOwnerCannotReuseRetainedCache() async throws {
    let repository = repository()
    let original = try await repository.ensureOutput(jobId: jobId)
    XCTAssertEqual(try Data(contentsOf: original), Data("fixture-mp3".utf8))
    fence = SessionFence(uid: "owner-b", epoch: 2)
    repository.onSessionChanged()
    let other = try await repository.ensureOutput(jobId: jobId)
    XCTAssertNotEqual(original, other)
    XCTAssertEqual(transfer.calls, 2)
    XCTAssertTrue(FileManager.default.fileExists(atPath: original.path))
  }

  func testDiskFailureDoesNotCallTheNetwork() async throws {
    try FileManager.default.removeItem(at: root)
    try Data("not a directory".utf8).write(to: root)
    let repository = repository()
    do {
      _ = try await repository.ensureOutput(jobId: jobId)
      XCTFail("Expected storage failure")
    } catch {
      XCTAssertEqual(error as? JobArtifactFailure, .storage)
    }
    XCTAssertEqual(api.downloadCalls, 0)
    XCTAssertEqual(transfer.calls, 0)
  }

  private func outputURL() -> URL {
    root.appendingPathComponent(ProcessingStore.ownerDirectoryName("owner-a"))
      .appendingPathComponent(jobId).appendingPathComponent("output.mp3")
  }
}

@MainActor private final class ArtifactDownloadFixture: ArtifactDownloading {
  var calls = 0
  var payload = Data("fixture-mp3".utf8)
  var handler: ((URL, URL, @escaping @Sendable (Int64, Int64?) -> Void) async throws -> Void)?
  func download(
    from source: URL, to destination: URL, progress: @escaping @Sendable (Int64, Int64?) -> Void
  ) async throws {
    calls += 1
    if let handler {
      try await handler(source, destination, progress)
      return
    }
    try payload.write(to: destination)
    progress(Int64(payload.count), nil)
  }
}

@MainActor private final class ArtifactJobsFixture: JobsAPI {
  var status = "ready"
  var detailCalls = 0
  var downloadCalls = 0
  func detail(id: String) async throws -> Job {
    detailCalls += 1
    return processingJob(id: id, status: status)
  }
  func download(id: String, artifact: String) async throws -> DownloadGrant {
    XCTAssertEqual(artifact, "output")
    downloadCalls += 1
    return DownloadGrant(
      url: URL(string: "https://storage.fixture.invalid/output?attempt=\(downloadCalls)")!,
      expiresAt: Date().addingTimeInterval(60))
  }
  func create(requestId: UUID, input: InputDeclaration) async throws -> CreateReservation {
    fatalError("Unused")
  }
  func renewUpload(id: String) async throws -> UploadGrant { fatalError("Unused") }
  func confirmUpload(id: String) async throws -> JobMutation { fatalError("Unused") }
  func list(cursor: String?, status: String?) async throws -> JobPage { fatalError("Unused") }
  func cancel(id: String) async throws -> JobMutation { fatalError("Unused") }
  func retry(id: String, requestId: UUID) async throws -> JobMutation { fatalError("Unused") }
}
