import Foundation
import XCTest

@testable import Vocal

final class AccountDeletionTests: XCTestCase {
  func testInterruptedRequestAndAcceptanceSurviveRestartWithoutCredentials() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let first = AccountDeletionStore(root: root)
    try await first.save(.init(uid: "owner-a"))
    let restored = try await AccountDeletionStore(root: root).pending("owner-a")
    XCTAssertEqual(restored?.uid, "owner-a")
    XCTAssertNil(restored?.receipt)
    let deadline = Date(timeIntervalSince1970: 1_790_380_800)
    let receipt = AccountDeletionReceipt(
      requestId: "request-one", status: "accepted", recoverUntil: deadline)
    try await first.save(.init(uid: "owner-a", receipt: receipt))
    let accepted = try await AccountDeletionStore(root: root).pending("owner-a")
    XCTAssertEqual(accepted?.receipt, receipt)
    XCTAssertEqual(accepted?.receipt?.recoverUntil, deadline)
    try await first.save(.init(uid: "owner-a", needsReauthentication: true))
    let notDowngraded = try await first.pending("owner-a")
    XCTAssertEqual(notDowngraded?.receipt, receipt)
    XCTAssertNil(notDowngraded?.needsReauthentication)
    let foreign = try await first.pending("owner-b")
    XCTAssertNil(foreign)
  }

  func testPurgeRemovesOnlyAccountPrivateFilesAndFencesLateWrites() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let staging = root.appendingPathComponent("staging")
    let store = ProcessingStore(root: root.appendingPathComponent("store"), stagingRoot: staging)
    for uid in ["owner-a", "owner-b"] {
      try await store.saveJobs([], ownerUid: uid)
      let directory = staging.appendingPathComponent(ProcessingStore.ownerDirectoryName(uid))
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try Data([1]).write(to: directory.appendingPathComponent("input.mp3"))
    }
    let original = root.appendingPathComponent("original.mp3")
    try Data([2]).write(to: original)
    try await store.purge(ownerUid: "owner-a")
    XCTAssertFalse(
      FileManager.default.fileExists(
        atPath: staging.appendingPathComponent(ProcessingStore.ownerDirectoryName("owner-a")).path))
    XCTAssertTrue(
      FileManager.default.fileExists(
        atPath: staging.appendingPathComponent(ProcessingStore.ownerDirectoryName("owner-b")).path))
    XCTAssertEqual(try Data(contentsOf: original), Data([2]))
    do {
      try await store.saveJobs([], ownerUid: "owner-a")
      XCTFail("Late writes must stay fenced")
    } catch { XCTAssertEqual(error as? ProcessingStoreFailure, .missingOperation) }
    let foreign = try await store.cachedJobs(ownerUid: "owner-b")
    XCTAssertTrue(foreign.isEmpty)
  }
}

@MainActor final class AccountRecoveryAPIClientTests: XCTestCase {
  func testDeviceHistoryRemovalRefreshesOnceAfterUnauthorized() async throws {
    let source = RecoveryTokenSource()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [RecoveryURLProtocol.self]
    let api = AuthAPIClient(
      configuration: AuthConfiguration(apiOrigin: URL(string: "https://api.example")!),
      tokenSource: source, sessionConfiguration: configuration)
    var calls = 0
    defer { RecoveryURLProtocol.handler = nil }
    RecoveryURLProtocol.handler = { _ in
      calls += 1
      return calls == 1 ? (401, Data()) : (204, Data())
    }
    try await api.removeDeviceHistory(id: "0e47b60a-4835-4cc3-a5b9-2d64d48f8c19")
    XCTAssertEqual(calls, 2)
    XCTAssertEqual(source.refreshRequests, [false, true])
    calls = 0
    source.refreshRequests = []
    RecoveryURLProtocol.handler = { _ in
      calls += 1
      return (401, Data())
    }
    do {
      try await api.removeDeviceHistory(id: "0e47b60a-4835-4cc3-a5b9-2d64d48f8c19")
      XCTFail("A repeated 401 must stop retrying")
    } catch { XCTAssertEqual(error as? AuthFailure, .sessionExpired) }
    XCTAssertEqual(calls, 2)
    XCTAssertEqual(source.refreshRequests, [false, true])
  }

  func testDeviceHistoryRemovalUsesAuthenticatedEmptyDeleteAndRequires204() async throws {
    let source = RecoveryTokenSource()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [RecoveryURLProtocol.self]
    let api = AuthAPIClient(
      configuration: AuthConfiguration(apiOrigin: URL(string: "https://api.example")!),
      tokenSource: source, sessionConfiguration: configuration)
    let id = "0e47b60a-4835-4cc3-a5b9-2d64d48f8c19"
    defer { RecoveryURLProtocol.handler = nil }
    RecoveryURLProtocol.handler = { request in
      XCTAssertEqual(request.url?.path, "/users/me/devices/\(id)")
      XCTAssertEqual(request.httpMethod, "DELETE")
      XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token")
      XCTAssertTrue(recoveryRequestData(request).isEmpty)
      return (204, Data())
    }
    try await api.removeDeviceHistory(id: id)
    RecoveryURLProtocol.handler = { _ in (200, Data("{}".utf8)) }
    do {
      try await api.removeDeviceHistory(id: id)
      XCTFail("Expected a 204 response")
    } catch { XCTAssertEqual(error as? AuthFailure, .malformedResponse) }
    do {
      try await api.removeDeviceHistory(id: "../me")
      XCTFail("Invalid IDs must not reach the transport")
    } catch { XCTAssertEqual(error as? AuthFailure, .invalidInput) }
  }

  func testPendingDeletionMapsToRecoveryGateAndOptionalReasonUsesEmptyBody() async throws {
    let source = RecoveryTokenSource()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [RecoveryURLProtocol.self]
    let api = AuthAPIClient(
      configuration: AuthConfiguration(apiOrigin: URL(string: "https://api.example")!),
      tokenSource: source, sessionConfiguration: configuration)
    var requests: [URLRequest] = []
    RecoveryURLProtocol.handler = { request in
      requests.append(request)
      if request.url?.path == "/users/me" {
        return (403, Data(#"{"code":"ACCOUNT_DELETION_PENDING"}"#.utf8))
      }
      return (
        202,
        Data(
          #"{"id":"recovery-1","status":"pending","reason":null,"requested_at":"2026-09-11T00:00:00.000Z","reviewed_at":null,"review_reason":null,"revision":0}"#
            .utf8)
      )
    }

    do {
      let _: AccountProfile = try await api.me()
      XCTFail("Expected the deletion fence")
    } catch {
      XCTAssertEqual(error as? AuthFailure, .accountDeletionPending)
    }
    let request = try await api.requestAccountRecovery(reason: nil)

    XCTAssertEqual(request.id, "recovery-1")
    XCTAssertEqual(request.status, "pending")
    XCTAssertEqual(requests.last?.httpMethod, "POST")
    XCTAssertEqual(requests.last?.url?.path, "/users/me/account-recovery")
    XCTAssertEqual(recoveryRequestData(requests.last!), Data("{}".utf8))
    XCTAssertEqual(requests.last?.value(forHTTPHeaderField: "Authorization"), "Bearer token")
  }
}

@MainActor final class AccountDeletionSessionTests: XCTestCase {
  func testReauthenticationFailureNeverRequestsDeletion() async {
    let fixture = DeletionFixture()
    await fixture.model.signInEmail(email: "owned@example.test", password: "password")
    fixture.firebase.reauthFailure = .cancelled
    await fixture.model.deleteAccount(password: "password")
    XCTAssertEqual(fixture.requests, 0)
    XCTAssertTrue(fixture.purged.isEmpty)
    XCTAssertEqual(fixture.model.lastFailure, .cancelled)
  }

  func testRevokedIdentityDuringReauthenticationClearsItsPrivateCopies() async {
    let fixture = DeletionFixture()
    await fixture.model.signInEmail(email: "owned@example.test", password: "password")
    fixture.firebase.reauthFailure = .accountDisabled
    await fixture.model.deleteAccount(password: "password")
    XCTAssertEqual(fixture.requests, 0)
    XCTAssertEqual(fixture.purged, ["owner-a"])
    XCTAssertEqual(fixture.model.phase, .signedOut)
  }

  func testAcceptedRequestSignsOutAndPurgesOnlyTheAuthenticatedOwner() async {
    let fixture = DeletionFixture()
    await fixture.model.signInEmail(email: "owned@example.test", password: "password")
    await fixture.model.deleteAccount(password: "password")
    XCTAssertEqual(fixture.requests, 1)
    XCTAssertEqual(fixture.firebase.reauthenticated, 1)
    XCTAssertEqual(fixture.purged, ["owner-a"])
    XCTAssertEqual(fixture.model.deletionReceipt?.status, "accepted")
    XCTAssertNotNil(fixture.model.deletionReceipt?.recoverUntil)
    XCTAssertEqual(fixture.model.phase, .signedOut)
  }

  func testLostResponseIsUncertainAndRetainsRestartMarker() async throws {
    let fixture = DeletionFixture()
    await fixture.model.signInEmail(email: "owned@example.test", password: "password")
    fixture.failure = .offline
    await fixture.model.deleteAccount(password: "password")
    XCTAssertTrue(fixture.model.deletionUncertain)
    XCTAssertNil(fixture.model.deletionReceipt)
    let pending = try await fixture.journal.pending("owner-a")
    XCTAssertNotNil(pending)
    XCTAssertNil(pending?.receipt)
    XCTAssertEqual(fixture.purged, ["owner-a"])
  }

  func testDefinitiveRejectionPreservesPrivateMediaAndSessionForRetry() async throws {
    for failure in [AuthFailure.invalidInput, .rateLimited(retryAt: Date().addingTimeInterval(60))]
    {
      let fixture = DeletionFixture()
      await fixture.model.signInEmail(email: "owned@example.test", password: "password")
      fixture.failure = failure
      await fixture.model.deleteAccount(password: "password")
      XCTAssertEqual(fixture.firebase.identity?.uid, "owner-a")
      XCTAssertTrue(fixture.purged.isEmpty)
      XCTAssertFalse(fixture.model.deletionUncertain)
      XCTAssertEqual(fixture.model.lastFailure, failure)
      let pending = try await fixture.journal.pending("owner-a")
      XCTAssertEqual(pending?.needsReauthentication, true)
    }
  }

  func testRefusedRetryCannotEraseAnEarlierAmbiguousRequest() async throws {
    let fixture = DeletionFixture()
    try await fixture.journal.save(.init(uid: "owner-a"))
    await fixture.model.signInEmail(email: "owned@example.test", password: "password")
    fixture.failure = .rateLimited(retryAt: Date().addingTimeInterval(60))
    await fixture.model.deleteAccount(password: "password")
    let pending = try await fixture.journal.pending("owner-a")
    XCTAssertNotNil(pending)
    XCTAssertNil(pending?.needsReauthentication)
    XCTAssertTrue(fixture.model.deletionUncertain)
    XCTAssertEqual(fixture.model.phase, .blocked)
    XCTAssertTrue(fixture.purged.isEmpty)
  }

  func testAcceptedReceiptRetryOnlyCompletesLocalCleanup() async throws {
    let fixture = DeletionFixture()
    let receipt = AccountDeletionReceipt(requestId: "previous-request", status: "accepted")
    try await fixture.journal.save(.init(uid: "owner-a", receipt: receipt))
    await fixture.model.signInEmail(email: "owned@example.test", password: "password")
    await fixture.model.deleteAccount(password: "password")
    XCTAssertEqual(fixture.requests, 0)
    XCTAssertEqual(fixture.firebase.reauthenticated, 0)
    XCTAssertEqual(fixture.model.deletionReceipt, receipt)
    XCTAssertEqual(fixture.purged, ["owner-a"])
  }

  func testDuplicateTapsDoNotSendAnotherDeletionRequest() async throws {
    let fixture = DeletionFixture()
    await fixture.model.signInEmail(email: "owned@example.test", password: "password")
    fixture.pauseRequest = true
    let first = Task { await fixture.model.deleteAccount(password: "password") }
    for _ in 0..<1_000 {
      if fixture.continuation != nil { break }
      try await Task.sleep(for: .milliseconds(1))
    }
    await fixture.model.deleteAccount(password: "password")
    XCTAssertEqual(fixture.requests, 1)
    fixture.continuation?.resume()
    await first.value
    XCTAssertEqual(fixture.purged, ["owner-a"])
  }

  func testAccountSwitchDuringRequestPurgesOldOwnerWithoutSigningOutNewOwner() async throws {
    let fixture = DeletionFixture()
    await fixture.model.signInEmail(email: "owned@example.test", password: "password")
    fixture.pauseRequest = true
    let first = Task { await fixture.model.deleteAccount(password: "password") }
    for _ in 0..<1_000 {
      if fixture.continuation != nil { break }
      try await Task.sleep(for: .milliseconds(1))
    }
    await fixture.model.signOut()
    fixture.firebase.identity = IdentitySnapshot(
      uid: "owner-b", email: "other@example.test", emailVerified: true, providers: [.password])
    await fixture.model.signInEmail(email: "other@example.test", password: "password")
    fixture.continuation?.resume()
    await first.value
    XCTAssertEqual(fixture.firebase.identity?.uid, "owner-b")
    XCTAssertEqual(fixture.model.identity?.uid, "owner-b")
    XCTAssertEqual(fixture.purged, ["owner-a"])
  }

  func testStaleAuthenticationKeepsSessionForRetryWithoutPurging() async throws {
    let fixture = DeletionFixture()
    await fixture.model.signInEmail(email: "owned@example.test", password: "password")
    fixture.failure = .recentLoginRequired
    await fixture.model.deleteAccount(password: "password")
    XCTAssertEqual(fixture.firebase.identity?.uid, "owner-a")
    XCTAssertTrue(fixture.purged.isEmpty)
    let pending = try await fixture.journal.pending("owner-a")
    XCTAssertEqual(pending?.needsReauthentication, true)
  }
}

@MainActor private final class DeletionFixture {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  let firebase = DeletionFirebase()
  var requests = 0
  var purged: [String] = []
  var failure: AuthFailure?
  var pauseRequest = false
  var continuation: CheckedContinuation<Void, Never>?
  lazy var journal = AccountDeletionStore(root: root.appendingPathComponent("deletion"))
  lazy var model: AuthSessionModel = {
    let model = AuthSessionModel(
      firebase: firebase, apple: AppleCredentialProvider(),
      installationStore: InstallationStore(file: root.appendingPathComponent("installation.json")),
      api: nil, deletionStore: journal,
      deletionRequest: { [unowned self] in
        requests += 1
        if pauseRequest { await withCheckedContinuation { continuation = $0 } }
        if let failure { throw failure }
        return AccountDeletionReceipt(
          requestId: "accepted-request", status: "accepted",
          recoverUntil: Date(timeIntervalSince1970: 1_790_380_800))
      })
    model.purgeAccountData = { [unowned self] in purged.append($0) }
    return model
  }()
  deinit { try? FileManager.default.removeItem(at: root) }
}

@MainActor private final class DeletionFirebase: FirebaseAuthenticating {
  var identity: IdentitySnapshot? = IdentitySnapshot(
    uid: "owner-a", email: "owned@example.test", emailVerified: false, providers: [.password])
  var appleProviderUserID: String? { nil }
  var reauthFailure: AuthFailure?
  var reauthenticated = 0
  func observe(_ listener: @escaping @MainActor (IdentitySnapshot?) -> Void) -> NSObjectProtocol {
    NSObject()
  }
  func removeObserver(_ handle: NSObjectProtocol) {}
  func register(email: String, password: String) async throws -> IdentitySnapshot {
    try await reload()
  }
  func signIn(email: String, password: String) async throws -> IdentitySnapshot {
    try await reload()
  }
  func signIn(apple payload: AppleCredentialPayload) async throws -> IdentitySnapshot {
    try await reload()
  }
  func reload() async throws -> IdentitySnapshot {
    guard let identity else { throw AuthFailure.sessionExpired }
    return identity
  }
  func idToken(forceRefresh: Bool) async throws -> String { "fixture-token" }
  func reauthenticatePassword(_ password: String) async throws {
    reauthenticated += 1
    if let reauthFailure { throw reauthFailure }
  }
  func reauthenticateApple(_ payload: AppleCredentialPayload) async throws {
    throw AuthFailure.cancelled
  }
  func linkPassword(_ password: String) async throws -> IdentitySnapshot { try await reload() }
  func linkApple(_ payload: AppleCredentialPayload) async throws -> IdentitySnapshot {
    try await reload()
  }
  func unlink(_ provider: ProviderID) async throws -> IdentitySnapshot { try await reload() }
  func signOut() throws { identity = nil }
}

@MainActor private final class RecoveryTokenSource: IDTokenSource {
  var refreshRequests: [Bool] = []
  func idToken(forceRefresh: Bool) async throws -> String {
    refreshRequests.append(forceRefresh)
    return "token"
  }
}

private final class RecoveryURLProtocol: URLProtocol, @unchecked Sendable {
  static var handler: ((URLRequest) -> (Int, Data))?
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    guard let handler = Self.handler else { return }
    let (status, bytes) = handler(request)
    client?.urlProtocol(
      self,
      didReceive: HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!,
      cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: bytes)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

private func recoveryRequestData(_ request: URLRequest) -> Data {
  if let body = request.httpBody { return body }
  guard let stream = request.httpBodyStream else { return Data() }
  stream.open()
  defer { stream.close() }
  var data = Data()
  let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 1024)
  defer { buffer.deallocate() }
  while stream.hasBytesAvailable {
    let count = stream.read(buffer, maxLength: 1024)
    if count <= 0 { break }
    data.append(buffer, count: count)
  }
  return data
}
