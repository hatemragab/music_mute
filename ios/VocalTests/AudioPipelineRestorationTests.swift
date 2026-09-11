import Foundation
import XCTest

@testable import Vocal

@MainActor final class AudioPipelineRestorationTests: XCTestCase {
  func testCapturedReceiptRestoresAfterCoordinatorReplacementAndConsumes() async throws {
    let fixture = try RestorationFixture()
    let context = fixture.context(owner: "owner-a")
    let coordinator = fixture.coordinator()
    await coordinator.bind(ownerUid: context.ownerUid)
    try coordinator.claim(context)
    let temporary = try fixture.temporary(bytes: [1, 2, 3, 4])
    let task = fixture.task(context)

    coordinator.capture(temporary, task: task)
    let replacement = fixture.coordinator()
    await replacement.bind(ownerUid: context.ownerUid)
    let restored = try await replacement.restoredDownload(
      ownerUid: context.ownerUid, operationId: context.operationId, progress: { _ in })

    let result = try XCTUnwrap(restored)
    XCTAssertEqual(result.context, context)
    XCTAssertEqual(try Data(contentsOf: result.fileURL), Data([1, 2, 3, 4]))
    replacement.consume(result)
    let consumed = try await replacement.restoredDownload(
      ownerUid: context.ownerUid, operationId: context.operationId, progress: { _ in })
    XCTAssertNil(consumed)
  }

  func testLateOldCaptureCannotReplaceNewTransferReceipt() async throws {
    let fixture = try RestorationFixture()
    let operation = UUID()
    let old = fixture.context(owner: "owner-a", operation: operation)
    let current = fixture.context(owner: "owner-a", operation: operation)
    let coordinator = fixture.coordinator()
    await coordinator.bind(ownerUid: "owner-a")
    try coordinator.claim(old)
    try coordinator.claim(current)

    let oldTemporary = try fixture.temporary(bytes: [9, 9, 9])
    coordinator.capture(oldTemporary, task: fixture.task(old))
    let currentTemporary = try fixture.temporary(bytes: [4, 5, 6])
    coordinator.capture(currentTemporary, task: fixture.task(current))

    let restoredValue = try await coordinator.restoredDownload(
      ownerUid: "owner-a", operationId: operation, progress: { _ in })
    let restored = try XCTUnwrap(restoredValue)
    XCTAssertEqual(restored.context.transferId, current.transferId)
    XCTAssertEqual(try Data(contentsOf: restored.fileURL), Data([4, 5, 6]))
    XCTAssertTrue(FileManager.default.fileExists(atPath: oldTemporary.path))
  }

  func testDuplicateCaptureAndMissingFileAreHandledWithoutPublishingInvalidBytes() async throws {
    let fixture = try RestorationFixture()
    let context = fixture.context(owner: "owner-a")
    let coordinator = fixture.coordinator()
    await coordinator.bind(ownerUid: context.ownerUid)
    try coordinator.claim(context)
    let task = fixture.task(context)
    coordinator.capture(try fixture.temporary(bytes: [7, 8]), task: task)
    let duplicate = try fixture.temporary(bytes: [0])
    coordinator.capture(duplicate, task: task)

    let restoredValue = try await coordinator.restoredDownload(
      ownerUid: context.ownerUid, operationId: context.operationId, progress: { _ in })
    let restored = try XCTUnwrap(restoredValue)
    XCTAssertEqual(try Data(contentsOf: restored.fileURL), Data([7, 8]))
    XCTAssertTrue(FileManager.default.fileExists(atPath: duplicate.path))
    try FileManager.default.removeItem(at: restored.fileURL)
    do {
      _ = try await coordinator.restoredDownload(
        ownerUid: context.ownerUid, operationId: context.operationId, progress: { _ in })
      XCTFail("Expected missing durable bytes to fail")
    } catch {
      XCTAssertEqual(error as? AudioFailure, .storage)
    }
  }

  func testAccountChangeRejectsAnotherOwnersReceipt() async throws {
    let fixture = try RestorationFixture()
    let context = fixture.context(owner: "owner-a")
    let coordinator = fixture.coordinator()
    await coordinator.bind(ownerUid: context.ownerUid)
    try coordinator.claim(context)
    coordinator.capture(try fixture.temporary(bytes: [1]), task: fixture.task(context))
    await coordinator.bind(ownerUid: "owner-b")

    do {
      _ = try await coordinator.restoredDownload(
        ownerUid: context.ownerUid, operationId: context.operationId, progress: { _ in })
      XCTFail("Expected account fence")
    } catch {
      XCTAssertEqual(error as? AudioPipelineFailure, .sessionChanged)
    }
  }
}

@MainActor private final class RestorationFixture {
  let root: URL
  private let session = URLSession(configuration: .ephemeral)

  init() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  }

  func coordinator() -> BackgroundSourceTransferCoordinator {
    BackgroundSourceTransferCoordinator(
      identifier: "fixture.\(UUID().uuidString)", root: root,
      configurationFactory: { URLSessionConfiguration.ephemeral })
  }

  func context(owner: String, operation: UUID = UUID()) -> SourceTransferContext {
    SourceTransferContext(
      ownerUid: owner, operationId: operation, transferId: UUID(), title: "Source",
      codec: "AAC", fileExtension: "m4a", bitrate: 128_000)
  }

  func task(_ context: SourceTransferContext) -> URLSessionDownloadTask {
    let task = session.downloadTask(with: URL(string: "https://fixture.invalid/audio.m4a")!)
    task.taskDescription = String(data: try! JSONEncoder().encode(context), encoding: .utf8)
    return task
  }

  func temporary(bytes: [UInt8]) throws -> URL {
    let url = root.appendingPathComponent(UUID().uuidString)
    try Data(bytes).write(to: url)
    return url
  }

  deinit {
    session.invalidateAndCancel()
    try? FileManager.default.removeItem(at: root)
  }
}
