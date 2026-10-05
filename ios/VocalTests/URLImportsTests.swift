import Foundation
import XCTest

@testable import Vocal

@MainActor final class URLImportsTests: XCTestCase {
  private struct Case: Decodable {
    let url: String
    let accepted: Bool
    let canonicalUrl: String?
  }
  func testSharedOfflinePolicy() throws {
    let file = try XCTUnwrap(
      Bundle(for: Self.self).url(forResource: "url-policy-cases", withExtension: "json"))
    let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: file))
    XCTAssertEqual(SupportedAudioSites.names.count, 12)
    for item in cases {
      let canonical = try? SupportedAudioSites.canonical(item.url)
      XCTAssertEqual(canonical != nil, item.accepted, item.url)
      if let expected = item.canonicalUrl {
        XCTAssertEqual(canonical, expected, item.url)
      }
    }
  }

  func testUnsupportedURLCreatesNoDurableIntentOrRequest() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = ProcessingStore(root: root, stagingRoot: root.appendingPathComponent("staging"))
    let api = URLImportFixtureAPI()
    let model = URLImportsModel(api: api, store: store)
    await model.bindOwner("owner")
    await model.submit("https://unknown.example/audio")
    XCTAssertEqual(model.messageKey, "url_import_unsupported")
    XCTAssertTrue(api.requests.isEmpty)
    let record = try await store.urlImport(ownerUid: "owner")
    XCTAssertNil(record)
  }

  func testAmbiguousWriteSurvivesRestartWithSameIdentityAndIsOwnerScoped() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = ProcessingStore(root: root, stagingRoot: root.appendingPathComponent("staging"))
    let api = URLImportFixtureAPI()
    let model = URLImportsModel(api: api, store: store)
    await model.bindOwner("owner")
    await model.submit("https://youtu.be/UXqq0ZvbOnk")
    for _ in 0..<200 where model.busy { try await Task.sleep(for: .milliseconds(10)) }
    XCTAssertEqual(api.requests.count, 1)
    XCTAssertNotNil(model.messageKey)
    XCTAssertEqual(model.record?.trimEnabled, true)
    await model.bindOwner(nil)
    let reopened = ProcessingStore(root: root, stagingRoot: root.appendingPathComponent("staging"))
    let restored = URLImportsModel(api: api, store: reopened)
    await restored.bindOwner("other")
    XCTAssertNil(restored.record)
    XCTAssertEqual(api.requests.count, 1)
    api.fail = false
    await restored.bindOwner("owner")
    for _ in 0..<200 where restored.busy { try await Task.sleep(for: .milliseconds(10)) }
    XCTAssertEqual(api.requests.count, 2)
    XCTAssertEqual(api.requests.first, api.requests.last)
    XCTAssertEqual(restored.record?.status, "submitted")
    XCTAssertEqual(restored.record?.trimEnabled, true)
    XCTAssertEqual(restored.record?.jobId, "68c000000000000000000002")
  }

  func testDefinitiveRejectionAllowsAnotherLink() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = ProcessingStore(root: root, stagingRoot: root.appendingPathComponent("staging"))
    let api = URLImportFixtureAPI()
    api.rejection = .server("IMPORT_UNSUPPORTED_AUDIO_SOURCE")
    let model = URLImportsModel(api: api, store: store)
    await model.bindOwner("owner")
    await model.submit("https://youtu.be/UXqq0ZvbOnk")
    for _ in 0..<200 where model.busy { try await Task.sleep(for: .milliseconds(10)) }
    XCTAssertEqual(model.record?.status, "failed")
    let rejectedID = model.record?.requestId
    api.rejection = nil
    api.fail = false
    await model.submit("https://clyp.it/iynkjk4b")
    for _ in 0..<200 where model.busy { try await Task.sleep(for: .milliseconds(10)) }
    XCTAssertEqual(model.record?.status, "submitted")
    XCTAssertNotEqual(model.record?.requestId, rejectedID)
  }

  func testAccountSwitchFencesLateImportResponse() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = ProcessingStore(root: root, stagingRoot: root.appendingPathComponent("staging"))
    let api = URLImportFixtureAPI()
    api.suspend = true
    let model = URLImportsModel(api: api, store: store)
    await model.bindOwner("owner")
    await model.submit("https://youtu.be/UXqq0ZvbOnk")
    for _ in 0..<200 where api.pending == nil { try await Task.sleep(for: .milliseconds(10)) }
    let pending = try XCTUnwrap(api.pending)
    await model.bindOwner("other")
    pending.resume(
      returning: URLImportView(
        importId: "68c000000000000000000001", status: "submitted",
        jobId: "68c000000000000000000002", error: nil))
    await Task.yield()
    XCTAssertNil(model.record)
    let foreign = try await store.urlImport(ownerUid: "other")
    XCTAssertNil(foreign)
    let original = try await store.urlImport(ownerUid: "owner")
    XCTAssertEqual(original?.status, "pending")
  }

  func testTwoPendingImportsPersistAndAccountSwitchFencesBothResponses() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = ProcessingStore(root: root, stagingRoot: root.appendingPathComponent("staging"))
    let api = URLImportFixtureAPI()
    api.suspend = true
    let model = URLImportsModel(api: api, store: store)
    await model.bindOwner("owner")
    await model.submit("https://youtu.be/UXqq0ZvbOnk", trimEnabled: false)
    for _ in 0..<200 where api.requests.count < 1 { await Task.yield() }
    XCTAssertTrue(model.busy)
    XCTAssertFalse(model.submitting)
    await model.submit("https://youtu.be/dQw4w9WgXcQ")
    for _ in 0..<200 where api.requests.count < 2 { await Task.yield() }
    XCTAssertEqual(api.requests.count, 2)
    XCTAssertNotEqual(api.requests.first, api.requests.last)
    let saved = try await store.urlImports(ownerUid: "owner")
    XCTAssertEqual(saved.count, 2)
    XCTAssertEqual(saved.map(\.trimEnabled), [false, true])
    await model.bindOwner("other")
    for pending in api.pendingWrites.values {
      pending.resume(
        returning: URLImportView(
          importId: "68c000000000000000000001",
          status: "submitted", jobId: "68c000000000000000000002", error: nil))
    }
    for _ in 0..<20 { await Task.yield() }
    XCTAssertTrue(model.records.isEmpty)
    let foreign = try await store.urlImports(ownerUid: "other")
    let original = try await store.urlImports(ownerUid: "owner")
    XCTAssertTrue(foreign.isEmpty)
    XCTAssertEqual(original.map(\.status), ["pending", "pending"])
  }

  func testDurableStoreKeepsAllUnfinishedImportsBeyondTwenty() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = ProcessingStore(root: root, stagingRoot: root.appendingPathComponent("staging"))
    for _ in 0..<25 {
      try await store.saveURLImport(
        URLImportRecord(url: "https://youtu.be/UXqq0ZvbOnk", requestId: UUID()), ownerUid: "owner")
    }
    let reopened = ProcessingStore(root: root, stagingRoot: root.appendingPathComponent("staging"))
    let saved = try await reopened.urlImports(ownerUid: "owner")
    XCTAssertEqual(saved.count, 25)
    XCTAssertEqual(Set(saved.map(\.requestId)).count, 25)
  }

  func testAcceptedImportUsesPushedSnapshotsWithoutHTTPPolling() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = ProcessingStore(root: root, stagingRoot: root.appendingPathComponent("staging"))
    let api = URLImportFixtureAPI()
    api.fail = false
    api.responseStatus = "queued"
    let socket = URLImportSocket()
    let realtime = ProcessingRealtime(
      configuration: AuthConfiguration(apiOrigin: URL(string: "https://api.example.invalid")!),
      makeSocket: { _ in socket },
      ticket: {
        RealtimeTicket(
          ticket: String(repeating: "a", count: 43), path: "/realtime/socket",
          protocol: "musicmute.realtime.v1")
      })
    api.live = realtime
    realtime.bindOwner("owner")
    realtime.setForeground(true)
    let model = URLImportsModel(api: api, store: store)
    await model.bindOwner("owner")
    await model.submit("https://youtu.be/UXqq0ZvbOnk")
    for _ in 0..<200 where !socket.sent.contains(where: { $0.contains("subscribe") }) {
      await Task.yield()
    }
    XCTAssertTrue(socket.sent.contains(where: { $0.contains("import") }))
    socket.frame(
      #"{"type":"snapshot","protocol_version":1,"stream_id":"imports","subscription_id":"s1","sequence":1,"data":{"import_id":"68c000000000000000000001","status":"submitted","job_id":"68c000000000000000000002","error":null}}"#
    )
    for _ in 0..<200 where model.busy { await Task.yield() }
    XCTAssertEqual(model.record?.status, "submitted")
    XCTAssertEqual(api.requests.count, 1)
    XCTAssertEqual(api.importReads, 0)
    realtime.bindOwner(nil)
  }

  func testExistingSingleImportSnapshotMigratesWithoutLosingIdentity() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let directory = root.appendingPathComponent(ProcessingStore.ownerDirectoryName("owner"))
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let requestId = UUID()
    let snapshot = Data(
      """
      {"version":2,"ownerUid":"owner","operations":[],"jobs":[],"urlImport":{"url":"https://youtu.be/UXqq0ZvbOnk","requestId":"\(requestId.uuidString)","status":"pending"}}
      """.utf8)
    try snapshot.write(to: directory.appendingPathComponent("processing.json"))
    let store = ProcessingStore(root: root, stagingRoot: root.appendingPathComponent("staging"))
    let migrated = try await store.urlImports(ownerUid: "owner")
    XCTAssertEqual(migrated.map(\.requestId), [requestId])
    let reopened = ProcessingStore(root: root, stagingRoot: root.appendingPathComponent("staging"))
    let restored = try await reopened.urlImports(ownerUid: "owner")
    XCTAssertEqual(restored.map(\.requestId), [requestId])
    XCTAssertEqual(restored.map(\.status), ["pending"])
  }

  func testMalformedSubmittedViewRejected() {
    let bad = URLImportView(
      importId: "68c000000000000000000001", status: "submitted", jobId: nil, error: nil)
    XCTAssertThrowsError(try bad.validated())
  }

  func testFailedImportRemovalSurvivesRestartAndKeepsOtherOwner() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = ProcessingStore(root: root, stagingRoot: root.appendingPathComponent("staging"))
    var failed = URLImportRecord(url: "https://youtu.be/UXqq0ZvbOnk", requestId: UUID())
    failed.status = "failed"
    try await store.saveURLImport(failed, ownerUid: "owner")
    try await store.saveURLImport(failed, ownerUid: "other")
    let api = URLImportFixtureAPI()
    let model = URLImportsModel(api: api, store: store)
    await model.bindOwner("owner")
    await model.removeFailedImport()
    XCTAssertNil(model.record)
    let reopened = ProcessingStore(root: root, stagingRoot: root.appendingPathComponent("staging"))
    let removed = try await reopened.urlImport(ownerUid: "owner")
    let other = try await reopened.urlImport(ownerUid: "other")
    XCTAssertNil(removed)
    XCTAssertEqual(other?.requestId, failed.requestId)
    XCTAssertTrue(api.requests.isEmpty)
  }

  func testFailureRetentionAndActiveRemovalGuard() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = ProcessingStore(root: root, stagingRoot: root.appendingPathComponent("staging"))
    let now = Date()
    var failed = URLImportRecord(url: "https://youtu.be/UXqq0ZvbOnk", requestId: UUID())
    failed.status = "failed"
    failed.failedAt = now.addingTimeInterval(-7 * 86_400)
    try await store.saveURLImport(failed, ownerUid: "owner")
    let retained = try await store.urlImport(ownerUid: "owner", now: now.addingTimeInterval(-1))
    XCTAssertEqual(retained?.requestId, failed.requestId)
    try await store.removeFailedURLImport(requestId: UUID(), ownerUid: "owner")
    let unmatched = try await store.urlImport(ownerUid: "owner", now: now.addingTimeInterval(-1))
    XCTAssertEqual(unmatched?.requestId, failed.requestId)
    let expired = try await store.urlImport(ownerUid: "owner", now: now)
    XCTAssertNil(expired)
    failed.status = "pending"
    try await store.saveURLImport(failed, ownerUid: "owner")
    try await store.removeFailedURLImport(requestId: failed.requestId, ownerUid: "owner")
    let active = try await store.urlImport(
      ownerUid: "owner", now: now.addingTimeInterval(8 * 86_400))
    XCTAssertEqual(active?.status, "pending")
  }

  func testLegacyFailedRecordGetsBoundedRetentionWindow() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = ProcessingStore(root: root, stagingRoot: root.appendingPathComponent("staging"))
    let legacy = Data(
      """
      {"url":"https://youtu.be/UXqq0ZvbOnk","requestId":"\(UUID().uuidString)","status":"failed"}
      """.utf8)
    let record = try JSONDecoder().decode(URLImportRecord.self, from: legacy)
    XCTAssertNil(record.failedAt)
    try await store.saveURLImport(record, ownerUid: "owner")
    let first = try await store.urlImport(ownerUid: "owner")
    XCTAssertNotNil(first?.failedAt)
    try await store.saveURLImport(record, ownerUid: "owner")
    let repeated = try await store.urlImport(ownerUid: "owner")
    XCTAssertEqual(first?.failedAt, repeated?.failedAt)
    let expired = try await store.urlImport(
      ownerUid: "owner", now: try XCTUnwrap(first?.failedAt).addingTimeInterval(7 * 86_400))
    XCTAssertNil(expired)
  }
}

@MainActor private final class URLImportFixtureAPI: JobsAPI {
  var requests: [UUID] = []
  var fail = true
  var responseStatus = "submitted"
  var importReads = 0
  var live: ProcessingRealtime?
  var realtime: ProcessingRealtime? { live }
  var rejection: URLImportFailure?
  var suspend = false
  var pending: CheckedContinuation<URLImportView, Error>?
  var pendingWrites: [UUID: CheckedContinuation<URLImportView, Error>] = [:]
  func createURLImport(url: String, requestId: UUID) async throws -> URLImportView {
    requests.append(requestId)
    if suspend {
      return try await withCheckedThrowingContinuation {
        pending = $0
        pendingWrites[requestId] = $0
      }
    }
    if let rejection { throw rejection }
    if fail { throw URLError(.networkConnectionLost) }
    return URLImportView(
      importId: "68c000000000000000000001", status: responseStatus,
      jobId: responseStatus == "submitted" ? "68c000000000000000000002" : nil, error: nil)
  }
  func urlImport(id: String) async throws -> URLImportView {
    importReads += 1
    throw JobsFailure.serviceUnavailable
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

@MainActor private final class URLImportSocket: RealtimeSocket {
  var sent: [String] = []
  private var queued = [#"{"type":"ready","protocol_version":1,"stream_id":"imports"}"#]
  private var waiting: CheckedContinuation<String, Error>?
  func receive() async throws -> String {
    if !queued.isEmpty { return queued.removeFirst() }
    return try await withCheckedThrowingContinuation { waiting = $0 }
  }
  func send(_ text: String) async throws { sent.append(text) }
  func frame(_ text: String) {
    if let continuation = waiting {
      waiting = nil
      continuation.resume(returning: text)
    } else {
      queued.append(text)
    }
  }
  func cancel() {
    waiting?.resume(throwing: CancellationError())
    waiting = nil
  }
}
