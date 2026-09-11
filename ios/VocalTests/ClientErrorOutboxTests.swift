import Foundation
import XCTest

@testable import Vocal

@MainActor final class ClientErrorOutboxTests: XCTestCase {
  func testOfflineQueuePersistsIsBoundedAndFlushesWithOriginalEventIDs() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let outbox = ClientErrorOutbox(root: root, capacity: 2)
    let operation = UUID()
    let ids = [UUID(), UUID(), UUID()]
    for id in ids {
      let event = ClientErrorOutbox.makeEvent(
        operationId: operation, jobId: nil, stage: .downloadingSource,
        error: URLError(.notConnectedToInternet), appVersion: "0.1.0",
        osVersion: "26.0", eventId: id)
      try await outbox.enqueue(event, ownerUid: "owner-a")
    }
    let ownerAEvents = try await outbox.pending(ownerUid: "owner-a")
    let ownerBEvents = try await outbox.pending(ownerUid: "owner-b")
    XCTAssertEqual(ownerAEvents.map(\.eventId), Array(ids.suffix(2)))
    XCTAssertTrue(ownerBEvents.isEmpty)

    let api = DiagnosticAPI()
    var current: SessionFence? = SessionFence(uid: "owner-a", epoch: 7)
    await outbox.flush(
      fence: current!, api: api,
      currentSession: { current })

    XCTAssertEqual(api.reported.map(\.eventId), Array(ids.suffix(2)))
    let remaining = try await outbox.pending(ownerUid: "owner-a")
    XCTAssertTrue(remaining.isEmpty)
  }

  func testFailedFlushKeepsEventAndAccountChangeStopsRemoval() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let outbox = ClientErrorOutbox(root: root)
    let event = ClientErrorOutbox.makeEvent(
      operationId: UUID(), jobId: nil, stage: .reservingJob,
      error: JobsFailure.rateLimited(retryAfter: 12), appVersion: "0.1.0", osVersion: "26.0")
    try await outbox.enqueue(event, ownerUid: "owner-a")
    let api = DiagnosticAPI()
    api.failure = .serviceUnavailable
    let fence = SessionFence(uid: "owner-a", epoch: 1)
    await outbox.flush(fence: fence, api: api, currentSession: { fence })
    let remaining = try await outbox.pending(ownerUid: "owner-a")
    XCTAssertEqual(remaining.map(\.eventId), [event.eventId])
  }
}

@MainActor private final class DiagnosticAPI: JobsAPI {
  var reported: [ClientErrorEvent] = []
  var failure: JobsFailure?
  func report(_ event: ClientErrorEvent) async throws -> ClientErrorReceipt {
    if let failure { throw failure }
    reported.append(event)
    return ClientErrorReceipt(eventId: event.eventId.uuidString.lowercased())
  }
  func create(requestId: UUID, input: InputDeclaration) async throws -> CreateReservation {
    throw JobsFailure.serviceUnavailable
  }
  func renewUpload(id: String) async throws -> UploadGrant { throw JobsFailure.serviceUnavailable }
  func confirmUpload(id: String) async throws -> JobMutation {
    throw JobsFailure.serviceUnavailable
  }
  func list(cursor: String?, status: String?) async throws -> JobPage {
    throw JobsFailure.serviceUnavailable
  }
  func detail(id: String) async throws -> Job { throw JobsFailure.serviceUnavailable }
  func cancel(id: String) async throws -> JobMutation { throw JobsFailure.serviceUnavailable }
  func retry(id: String, requestId: UUID) async throws -> JobMutation {
    throw JobsFailure.serviceUnavailable
  }
  func download(id: String, artifact: String) async throws -> DownloadGrant {
    throw JobsFailure.serviceUnavailable
  }
}
