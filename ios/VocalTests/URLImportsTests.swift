import Foundation
import XCTest

@testable import Vocal

@MainActor final class URLImportsTests: XCTestCase {
  private struct Case: Decodable {
    let url: String
    let accepted: Bool
  }
  func testSharedOfflinePolicy() throws {
    let file = try XCTUnwrap(
      Bundle(for: Self.self).url(forResource: "url-policy-cases", withExtension: "json"))
    let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: file))
    XCTAssertEqual(SupportedAudioSites.names.count, 12)
    for item in cases {
      XCTAssertEqual((try? SupportedAudioSites.canonical(item.url)) != nil, item.accepted, item.url)
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
  var rejection: URLImportFailure?
  var suspend = false
  var pending: CheckedContinuation<URLImportView, Error>?
  func createURLImport(url: String, requestId: UUID) async throws -> URLImportView {
    requests.append(requestId)
    if suspend { return try await withCheckedThrowingContinuation { pending = $0 } }
    if let rejection { throw rejection }
    if fail { throw URLError(.networkConnectionLost) }
    return URLImportView(
      importId: "68c000000000000000000001", status: "submitted", jobId: "68c000000000000000000002",
      error: nil)
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
