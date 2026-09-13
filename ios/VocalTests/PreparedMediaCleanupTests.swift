import XCTest

@testable import Vocal

final class PreparedMediaCleanupTests: XCTestCase {
  func testReceiptRequiredBeforeTemporaryInputDeletion() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let staging = root.appendingPathComponent("staging")
    let input = try processingPrepared(root: staging)
    let store = ProcessingStore(root: root.appendingPathComponent("store"), stagingRoot: staging)
    _ = try await store.createOperation(prepared: input)
    try await store.update(id: input.operationId, ownerUid: input.ownerUid) {
      $0.phase = .confirmationPending
      $0.jobStatus = "awaiting_upload"
    }
    try await store.cleanupConfirmedInput(id: input.operationId, ownerUid: input.ownerUid)
    XCTAssertTrue(FileManager.default.fileExists(atPath: input.fileURL.path))
    try await store.update(id: input.operationId, ownerUid: input.ownerUid) {
      $0.phase = .submitted
      $0.jobStatus = "queued"
    }
    try await store.cleanupConfirmedInput(id: input.operationId, ownerUid: "another-owner")
    XCTAssertTrue(FileManager.default.fileExists(atPath: input.fileURL.path))
    try await store.cleanupConfirmedInput(id: input.operationId, ownerUid: input.ownerUid)
    XCTAssertFalse(FileManager.default.fileExists(atPath: input.fileURL.path))
    let persisted = try await store.operation(id: input.operationId, ownerUid: input.ownerUid)
    XCTAssertEqual(persisted?.phase, .submitted)
    try await store.cleanupConfirmedInput(id: input.operationId, ownerUid: input.ownerUid)
  }

  func testPhotoCleanupNeverDeletesOriginalOutsideOwnedDirectory() throws {
    let original = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: original) }
    try Data([1, 2, 3]).write(to: original)
    PreparedMediaCleanup.discardPhotoCopy(original)
    XCTAssertTrue(FileManager.default.fileExists(atPath: original.path))
  }
}
