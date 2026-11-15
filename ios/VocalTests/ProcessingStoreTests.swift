import CryptoKit
import Foundation
import XCTest

@testable import Vocal

final class ProcessingStoreTests: XCTestCase {
  func testOwnerIsolationAndRestartPreserveImmutableIntentAndJobCache() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let staging = root.appendingPathComponent("staging")
    let prepared = try processingPrepared(root: staging, owner: "owner-a")
    let store = ProcessingStore(root: root.appendingPathComponent("store"), stagingRoot: staging)
    let first = try await store.createOperation(prepared: prepared)
    let repeated = try await store.createOperation(prepared: prepared)
    XCTAssertEqual(first.requestId, repeated.requestId)
    let restoredURL = try await store.inputURL(for: first)
    XCTAssertEqual(restoredURL, prepared.fileURL)
    try await store.saveJobs([processingJob(id: "68c000000000000000000001")], ownerUid: "owner-a")
    let restored = ProcessingStore(root: root.appendingPathComponent("store"), stagingRoot: staging)
    let operations = try await restored.operations(ownerUid: "owner-a")
    let foreign = try await restored.operations(ownerUid: "owner-b")
    let jobs = try await restored.cachedJobs(ownerUid: "owner-a")
    let foreignJobs = try await restored.cachedJobs(ownerUid: "owner-b")
    XCTAssertEqual(operations, [first])
    XCTAssertTrue(foreign.isEmpty)
    XCTAssertEqual(jobs.count, 1)
    XCTAssertTrue(foreignJobs.isEmpty)
  }

  func testPreparedOperationReusesReferenceAndPersistsSourceMetadata() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let staging = root.appendingPathComponent("staging")
    let base = try processingPrepared(root: staging)
    let started = Date(timeIntervalSince1970: 1_789_041_600)
    let prepared = PreparedInput(
      operationId: base.operationId, ownerUid: base.ownerUid, fileURL: base.fileURL,
      declaration: base.declaration, sourceTitle: "Interview", sourceKind: .url,
      clientStartedAt: started, displayName: "My interview")
    let store = ProcessingStore(root: root.appendingPathComponent("store"), stagingRoot: staging)

    let operation = try await store.createOperation(prepared: prepared)

    XCTAssertEqual(operation.requestId, prepared.operationId)
    XCTAssertEqual(operation.sourceTitle, "Interview")
    XCTAssertEqual(operation.sourceKind, .url)
    XCTAssertEqual(operation.clientStartedAt, started)
    XCTAssertEqual(operation.displayName, "My interview")
    let restored = try await ProcessingStore(
      root: root.appendingPathComponent("store"), stagingRoot: staging
    ).operations(ownerUid: base.ownerUid)
    XCTAssertEqual(restored, [operation])
  }

  func testCrossOwnerAndEscapingPreparedPathsAreRejected() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let input = try processingPrepared(root: root.appendingPathComponent("staging"), owner: "a")
    let foreign = PreparedInput(
      operationId: input.operationId, ownerUid: "b", fileURL: input.fileURL,
      declaration: input.declaration)
    let store = ProcessingStore(
      root: root.appendingPathComponent("store"),
      stagingRoot: root.appendingPathComponent("staging"))
    do {
      _ = try await store.createOperation(prepared: foreign)
      XCTFail("Expected owner path rejection")
    } catch { XCTAssertEqual(error as? ProcessingStoreFailure, .invalidPath) }
    let outside = PreparedInput(
      operationId: input.operationId, ownerUid: "a",
      fileURL: root.appendingPathComponent("outside.mp3"), declaration: input.declaration)
    do {
      _ = try await store.createOperation(prepared: outside)
      XCTFail("Expected path rejection")
    } catch { XCTAssertEqual(error as? ProcessingStoreFailure, .invalidPath) }
  }

  func testUnsupportedSnapshotVersionIsRejected() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let staging = root.appendingPathComponent("staging")
    let storeRoot = root.appendingPathComponent("store")
    let prepared = try processingPrepared(root: staging)
    let store = ProcessingStore(root: storeRoot, stagingRoot: staging)
    let operation = try await store.createOperation(prepared: prepared)
    let snapshot: [String: Any] = [
      "version": 1, "ownerUid": prepared.ownerUid,
      "operations": [try JSONSerialization.jsonObject(with: JSONEncoder().encode(operation))],
      "jobs": [],
    ]
    let file = storeRoot.appendingPathComponent(
      ProcessingStore.ownerDirectoryName(prepared.ownerUid)
    )
    .appendingPathComponent("processing.json")
    try JSONSerialization.data(withJSONObject: snapshot).write(to: file, options: .atomic)
    let restored = ProcessingStore(root: storeRoot, stagingRoot: staging)
    do {
      _ = try await restored.operations(ownerUid: prepared.ownerUid)
      XCTFail("Expected unsupported snapshot version to be rejected")
    } catch {
      XCTAssertEqual(error as? ProcessingStoreFailure, .corruptStore)
    }
  }

  func testCorruptStoreIsReportedWithoutOverwritingIt() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let directory = root.appendingPathComponent(ProcessingStore.ownerDirectoryName("a"))
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = directory.appendingPathComponent("processing.json")
    let bad = Data("not JSON".utf8)
    try bad.write(to: file)
    let store = ProcessingStore(root: root, stagingRoot: root.appendingPathComponent("staging"))
    do {
      _ = try await store.operations(ownerUid: "a")
      XCTFail("Expected corrupt store")
    } catch { XCTAssertEqual(error as? ProcessingStoreFailure, .corruptStore) }
    XCTAssertEqual(try Data(contentsOf: file), bad)
  }
}

func processingPrepared(root: URL, owner: String = "owner-a") throws -> PreparedInput {
  let operation = UUID()
  let directory = root.appendingPathComponent(ProcessingStore.ownerDirectoryName(owner))
    .appendingPathComponent(operation.uuidString.lowercased())
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let file = directory.appendingPathComponent("input.mp3")
  let data = Data([0x49, 0x44, 0x33, 1, 2, 3])
  try data.write(to: file)
  return PreparedInput(
    operationId: operation, ownerUid: owner, fileURL: file,
    declaration: InputDeclaration(
      extension: "mp3", contentType: "audio/mpeg", bytes: Int64(data.count),
      durationSeconds: 1, sha256: Data(SHA256.hash(data: data)).base64EncodedString()),
    policyVersion: 2, preparationProfileId: ProcessingMediaPolicy.standard.profileID,
    mediaSource: "audio_file")
}

func processingJob(id: String, status: String = "awaiting_upload") -> Job {
  Job(
    id: id, status: status, createdAt: Date(), updatedAt: Date(), queuedAt: nil,
    finishedAt: nil, retryOfJobId: nil,
    input: Job.Input(extension: "mp3", bytes: 6, durationSeconds: 1), error: nil,
    canDownloadInput: status != "awaiting_upload", canDownloadOutput: status == "ready",
    workerAvailable: nil)
}
