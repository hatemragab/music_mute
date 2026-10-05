import AVFoundation
import Combine
import CryptoKit
import Darwin
import Foundation

private enum DesktopTestFailure: Error { case failed(String) }
private func require(_ value: @autoclosure () -> Bool, _ label: String) throws {
  if !value() { throw DesktopTestFailure.failed(label) }
}
private func canonicalDesktopTestDirectory(_ url: URL) -> URL {
  RuntimePath.canonicalExisting(url).map { URL(fileURLWithPath: $0, isDirectory: true) } ?? url
}
private func verifiedDesktopRuntime(
  _ label: String, coordinator: RuntimeVerificationCoordinator, resources: URL, support: URL,
  signatureChecker: any RuntimeSignatureChecking
) throws -> RuntimeVerifiedRuntime? {
  do {
    return try coordinator.verifiedRuntime(
      resources: resources, support: support, signatureChecker: signatureChecker)
  } catch {
    let message = "Desktop runtime gate stage \(label) failed: \(error)\n"
    try? FileHandle.standardError.write(contentsOf: Data(message.utf8))
    throw error
  }
}
private final class DesktopRuntimeSignatureChecker: RuntimeSignatureChecking, @unchecked Sendable {
  private let lock = NSLock()
  let verificationPolicyIdentifier: String
  private var outerChecks = 0
  private var codeChecks = 0
  private var checkedOnMainThread = false

  init(verificationPolicyIdentifier: String = UUID().uuidString) {
    self.verificationPolicyIdentifier = verificationPolicyIdentifier
  }

  func validateOuterApplication(resources: URL, signing: RuntimeSigningManifest) throws {
    lock.lock()
    outerChecks += 1
    checkedOnMainThread = checkedOnMainThread || Thread.isMainThread
    lock.unlock()
    usleep(100_000)
  }

  func validateCode(at url: URL, signing: RuntimeSigningManifest) throws {
    lock.lock()
    codeChecks += 1
    checkedOnMainThread = checkedOnMainThread || Thread.isMainThread
    lock.unlock()
  }

  func snapshot() -> (outer: Int, code: Int, main: Bool) {
    lock.lock()
    defer { lock.unlock() }
    return (outerChecks, codeChecks, checkedOnMainThread)
  }
}
private final class BlockingDesktopRuntimeSignatureChecker: RuntimeSignatureChecking,
  @unchecked Sendable
{
  let verificationPolicyIdentifier: String
  private let support: URL
  private let lock = NSLock()
  private let entered = DispatchSemaphore(value: 0)
  private let release = DispatchSemaphore(value: 0)
  private var shouldBlock = true
  private var outerChecks = 0
  private var updateLeaseBlockedBeforeOuterCheck = false

  init(support: URL, verificationPolicyIdentifier: String) {
    self.support = canonicalDesktopTestDirectory(support)
    self.verificationPolicyIdentifier = verificationPolicyIdentifier
  }

  func validateOuterApplication(resources: URL, signing: RuntimeSigningManifest) throws {
    lock.lock()
    outerChecks += 1
    let block = shouldBlock
    shouldBlock = false
    lock.unlock()
    guard block else { return }

    let updateBlocked: Bool
    do {
      let unexpectedLease = try DesktopUpdateInstallationLease(support: support)
      withExtendedLifetime(unexpectedLease) {}
      updateBlocked = false
    } catch DesktopUpdateGateFailure.busy {
      updateBlocked = true
    } catch {
      updateBlocked = false
    }
    lock.lock()
    updateLeaseBlockedBeforeOuterCheck = updateBlocked
    lock.unlock()
    entered.signal()
    guard release.wait(timeout: .now() + 5) == .success else {
      throw RuntimeBootstrapFailure.code("RUNTIME_SIGNATURE_INVALID")
    }
  }

  func validateCode(at url: URL, signing: RuntimeSigningManifest) throws {}

  func waitUntilBlocked() async -> Bool {
    await Task.detached { self.waitForEntered() }.value
  }

  private func waitForEntered() -> Bool { entered.wait(timeout: .now() + 5) == .success }

  func releaseVerification() { release.signal() }

  func snapshot() -> (outer: Int, updateBlocked: Bool) {
    lock.lock()
    defer { lock.unlock() }
    return (outerChecks, updateLeaseBlockedBeforeOuterCheck)
  }
}
private final class PlaybackFixtureGate: @unchecked Sendable {
  let entered = DispatchSemaphore(value: 0)
  let release = DispatchSemaphore(value: 0)
  func hold() throws {
    entered.signal()
    guard release.wait(timeout: .now() + 5) == .success else {
      throw DesktopTestFailure.failed("Playback fixture deadline")
    }
  }
  func waitUntilHeld() async throws {
    let ready = await Task.detached { self.waitForEntered() }.value
    try require(ready, "Playback fixture must hold the shared cache lease")
  }
  private func waitForEntered() -> Bool { entered.wait(timeout: .now() + 5) == .success }
}
private final class DesktopUpdateLockStartGate: @unchecked Sendable {
  private let semaphore = DispatchSemaphore(value: 0)
  func waitSynchronously() { semaphore.wait() }
  func release(_ count: Int) {
    for _ in 0..<count { semaphore.signal() }
  }
}
@MainActor private final class PlaybackAssetFixtureGate {
  let url: URL
  private var blocked: CheckedContinuation<Void, Never>?
  private var started: CheckedContinuation<Void, Never>?
  init(url: URL) { self.url = url }
  func load(_ remoteURL: URL) async throws -> AVURLAsset {
    try require(remoteURL.scheme == "https", "Playback must validate its granted URL first")
    // Deliberately ignores cancellation so the operation fence is exercised after a late load.
    await withCheckedContinuation { continuation in
      blocked = continuation
      started?.resume()
      started = nil
    }
    return AVURLAsset(url: url)
  }
  func waitUntilBlocked() async {
    if blocked == nil { await withCheckedContinuation { started = $0 } }
  }
  func release() {
    blocked?.resume()
    blocked = nil
  }
}
@MainActor private final class MemoryVault: DesktopCredentialVault {
  var credential: DesktopCredential?
  var rejectRemoval = false
  var saves = 0
  var loads = 0
  var pauseLoad = false
  var loadFailure: DesktopAuthFailure?
  private var blockedLoad: CheckedContinuation<Void, Never>?
  private var loadStarted: CheckedContinuation<Void, Never>?
  func load() async throws -> DesktopCredential? {
    loads += 1
    let stored = credential
    let failure = loadFailure
    if pauseLoad {
      await withCheckedContinuation { continuation in
        blockedLoad = continuation
        loadStarted?.resume()
        loadStarted = nil
      }
    }
    if let failure { throw failure }
    return stored
  }
  func waitUntilLoadBlocked() async {
    if blockedLoad == nil { await withCheckedContinuation { loadStarted = $0 } }
  }
  func releaseLoad() {
    blockedLoad?.resume()
    blockedLoad = nil
  }
  func save(_ credential: DesktopCredential) throws {
    saves += 1
    self.credential = credential
  }
  func remove() throws {
    if rejectRemoval { throw DesktopAuthFailure.credentialsUnavailable }
    credential = nil
  }
}
private actor FixtureTransport: DesktopHTTPTransport {
  struct Reply: Sendable {
    let value: DesktopJSON
    let status: Int
    let pause: Bool
    var data: Data? = nil
    var cancellable = false
  }
  var replies: [Reply]
  var requests: [URLRequest] = []
  private var blocked: CheckedContinuation<Void, Never>?
  private var started: CheckedContinuation<Void, Never>?
  init(_ values: [DesktopJSON]) {
    replies = values.map { Reply(value: $0, status: 200, pause: false) }
  }
  init(replies: [Reply]) { self.replies = replies }
  func send(_ request: URLRequest) async throws -> (Data, Int) {
    requests.append(request)
    guard !replies.isEmpty else { throw DesktopAuthFailure.service("NETWORK_UNAVAILABLE") }
    let response = replies.removeFirst()
    if response.pause {
      await withTaskCancellationHandler {
        await withCheckedContinuation { continuation in
          blocked = continuation
          started?.resume()
          started = nil
        }
      } onCancel: {
        if response.cancellable { Task { await self.release() } }
      }
      if response.cancellable && Task.isCancelled { throw DesktopAuthFailure.cancelled }
    }
    return (try response.data ?? JSONEncoder().encode(response.value), response.status)
  }
  func waitUntilBlocked() async {
    if blocked == nil { await withCheckedContinuation { started = $0 } }
  }
  func release() {
    blocked?.resume()
    blocked = nil
  }
  func recorded() -> [URLRequest] { requests }
}
private final class StreamingFixtureStore: @unchecked Sendable {
  struct Reply: Sendable {
    let chunks: [Data]
    var contentLength: Int? = nil
    var hold = false
  }
  private let lock = NSLock()
  private var replies: [String: Reply] = [:]
  private var delivered: [String: Int] = [:]
  private var stopped = Set<String>()
  func insert(_ reply: Reply) -> String {
    let id = UUID().uuidString
    lock.lock()
    replies[id] = reply
    delivered[id] = 0
    lock.unlock()
    return id
  }
  func reply(_ id: String) -> Reply? {
    lock.lock()
    defer { lock.unlock() }
    return replies[id]
  }
  func record(_ count: Int, id: String) {
    lock.lock()
    delivered[id, default: 0] += count
    lock.unlock()
  }
  func stop(_ id: String) {
    lock.lock()
    stopped.insert(id)
    lock.unlock()
  }
  func snapshot(_ id: String) -> (Int, Bool) {
    lock.lock()
    defer { lock.unlock() }
    return (delivered[id, default: 0], stopped.contains(id))
  }
}
private final class StreamingFixtureProtocol: URLProtocol, @unchecked Sendable {
  static let store = StreamingFixtureStore()
  private let lock = NSLock()
  private var worker: Task<Void, Never>?
  override class func canInit(with request: URLRequest) -> Bool {
    request.url?.host == "streaming-fixture.invalid"
  }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    guard let url = request.url, let id = request.value(forHTTPHeaderField: "X-Fixture-Id"),
      let reply = Self.store.reply(id)
    else { return }
    lock.lock()
    worker = Task {
      let headers = reply.contentLength.map { ["Content-Length": String($0)] } ?? [:]
      let response = HTTPURLResponse(
        url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
      self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      if reply.hold { return }
      for chunk in reply.chunks {
        do { try await Task.sleep(for: .milliseconds(5)) } catch { return }
        if Self.store.snapshot(id).1 { return }
        Self.store.record(chunk.count, id: id)
        self.client?.urlProtocol(self, didLoad: chunk)
      }
      self.client?.urlProtocolDidFinishLoading(self)
    }
    lock.unlock()
  }
  override func stopLoading() {
    if let id = request.value(forHTTPHeaderField: "X-Fixture-Id") { Self.store.stop(id) }
    lock.lock()
    worker?.cancel()
    worker = nil
    lock.unlock()
  }
}

@main struct DesktopTests {
  @MainActor static var preferenceSuites: [String] = []
  @MainActor static func testPreferences() -> UserDefaults {
    let name = "musicmute-desktop-tests.\(UUID())"
    preferenceSuites.append(name)
    return UserDefaults(suiteName: name)!
  }
  static let uid = "fixture-desktop-owner"
  static let project = "fixture-musicmute"
  static let installation = "00000000-0000-4000-8000-000000000042"
  static let profile: DesktopJSON = .object([
    "user": .object([
      "id": .string("000000000000000000000042"), "display_name": .string("Fixture"),
      "email": .string("fixture@example.invalid"), "email_verified": .bool(true),
      "providers": .array([.string("password")]),
    ]),
    "access": .object(["allowed": .bool(true)]),
  ])
  @MainActor static func token(_ uid: String = Self.uid, project: String = Self.project) throws
    -> String
  {
    let data = try JSONEncoder().encode(
      DesktopJSON.object([
        "sub": .string(uid), "aud": .string(project),
        "iss": .string("https://securetoken.google.com/\(project)"),
      ]))
    return "fixture.\(DesktopGoogleOAuth.base64URL(data)).fixture-signature"
  }
  @MainActor static func credentials(_ uid: String = Self.uid, project: String = Self.project)
    throws -> DesktopJSON
  {
    .object([
      "localId": .string(uid), "idToken": .string(try token(uid, project: project)),
      "refreshToken": .string(String(repeating: "r", count: 30)), "expiresIn": .string("3600"),
    ])
  }
  @MainActor static func configuration() -> DesktopPublicConfiguration {
    DesktopPublicConfiguration(
      backendBaseURL: "https://api.example.invalid",
      firebaseAPIKey: String(repeating: "A", count: 39),
      firebaseProjectID: project, googleDesktopClientID: "123-fixture.apps.googleusercontent.com")
  }
  @MainActor static func main() async throws {
    defer {
      for name in preferenceSuites {
        UserDefaults(suiteName: name)?.removePersistentDomain(forName: name)
      }
    }
    try posixRetryChecks()
    try await authChecks()
    try await cloudSubmissionFenceChecks()
    try await delayedRestoreChecks()
    try await staleSignInFence()
    try await staleRefreshFence()
    try await logoutFailureFence()
    try await readReplayChecks()
    try validationChecks()
    try await googleDeadlineChecks()
    try googleCallbackPageChecks()
    try await googleCallbackResponseChecks()
    try googleTokenFailureChecks()
    try await googleExchangeChecks()
    try await googleExchangeFailureChecks()
    try await googleExchangeFenceChecks()
    try await googleCompletionFenceChecks()
    try await googleReauthenticationFenceChecks()
    try await boundedTransportChecks()
    try visualPreferenceChecks()
    try homeLibraryConnectionChecks()
    try librarySnapshotReadinessChecks()
    try runtimePreparationFailureChecks()
    try playbackClockChecks()
    try playbackVolumeChecks()
    try offlineStorageDefaultChecks()
    try await offlineStorageSaveChecks()
    try cachePinChecks()
    try await cachePlaybackLeaseChecks()
    try await playbackJournalChecks()
    try await playbackPreparationChecks()
    try accountStateChecks()
    try await outboxWatcherChecks()
    try silenceChecks()
    try comparisonChecks()
    try syncNoticeChecks()
    try libraryTitleChecks()
    try await updateLockCreationChecks()
    try await runtimeExecutionGateChecks()
    try await bridgeChecks()
    print(
      "Native desktop checks passed: Firebase credentials and Mac bootstrap, local owner scope without network refresh, reset privacy, stale login and token refresh fences, secure logout failure recovery, project identity fence, PKCE callback state and public config validation."
    )
  }
  @MainActor static func runtimePreparationFailureChecks() throws {
    let account = DesktopAccountModel(
      configuration: configuration(), vault: MemoryVault(), transport: FixtureTransport([]),
      installationId: installation, preferences: testPreferences())
    let workspace = DesktopWorkspace(
      account: account, resources: nil, preferences: testPreferences())
    let notPrepared = DesktopAuthFailure.service("APP_RUNTIME_NOT_PREPARED")
    let incompatible = DesktopAuthFailure.service("APP_RUNTIME_INCOMPATIBLE")
    try require(
      notPrepared.message == "Open Setup and choose Prepare my Mac before using local processing."
        && incompatible.message
          == "This app version needs its matching processing tools. Open Setup and prepare this version."
        && notPrepared.requiresRuntimePreparation && incompatible.requiresRuntimePreparation
        && DesktopWorkspace.visibleCacheLoadFailure(notPrepared) == nil
        && DesktopWorkspace.visibleCacheLoadFailure(incompatible) == nil,
      "Expected first-run cache reads must defer to Setup instead of showing an account error")
    for expected in [notPrepared.message, incompatible.message] {
      workspace.failure = expected
      workspace.clearRuntimePreparationFailure()
      try require(
        workspace.failure == nil,
        "Confirmed runtime readiness must clear the exact stale preparation failure")
    }
    workspace.failure = "A separate media failure"
    workspace.clearRuntimePreparationFailure()
    try require(
      workspace.failure == "A separate media failure"
        && DesktopWorkspace.visibleCacheLoadFailure(DesktopAuthFailure.malformedResponse)
          == DesktopAuthFailure.malformedResponse.message,
      "Runtime readiness must preserve unrelated media and real cache failures")
    workspace.shutdown()
  }
  @MainActor static func homeLibraryConnectionChecks() throws {
    let signedOut = DesktopHomeLibraryConnection.resolve(
      signedIn: false, accountOnline: false, libraryConnected: false,
      connectionInProgress: false)
    let signingIn = DesktopHomeLibraryConnection.resolve(
      signedIn: true, accountOnline: false, libraryConnected: false,
      connectionInProgress: true)
    let socketConnecting = DesktopHomeLibraryConnection.resolve(
      signedIn: true, accountOnline: true, libraryConnected: false,
      connectionInProgress: false)
    let offline = DesktopHomeLibraryConnection.resolve(
      signedIn: true, accountOnline: false, libraryConnected: false,
      connectionInProgress: false)
    let connected = DesktopHomeLibraryConnection.resolve(
      signedIn: true, accountOnline: true, libraryConnected: true,
      connectionInProgress: false)
    let staleSocket = DesktopHomeLibraryConnection.resolve(
      signedIn: true, accountOnline: false, libraryConnected: true,
      connectionInProgress: false)
    let staleLibraryIndicator = DesktopHomeLibraryConnection.isConnected(
      signedIn: true, accountOnline: false, libraryConnected: true)
    try require(
      signedOut == .signedOut && signingIn == .connecting && socketConnecting == .connecting
        && offline == .offline && connected == .connected && staleSocket == .offline
        && !staleLibraryIndicator,
      "Home must not present a signed-in or stale socket session as a connected Library")
    try require(
      connected.detail == "Your MusicMute library is connected across Mac, web, and mobile."
        && socketConnecting.detail.contains("connecting your library")
        && offline.detail.contains("Local playback stays available"),
      "Home Library connection copy must distinguish connected, connecting and offline states")
  }
  static func librarySnapshotReadinessChecks() throws {
    let firstScope = DesktopSessionScope(firebaseUid: "first-owner", generation: UUID())
    let nextScope = DesktopSessionScope(firebaseUid: "next-owner", generation: UUID())
    var readiness = DesktopLibrarySnapshotReadiness.disconnected
    try require(!readiness.isReady, "A disconnected Library must not claim snapshot readiness")

    readiness.jobsSubscriptionRequested(scope: firstScope, streamID: "stream-a")
    try require(
      readiness == .awaitingInitialSnapshot(scope: firstScope, streamID: "stream-a")
        && !readiness.isReady,
      "A ready socket must wait for its current account and stream's first jobs snapshot")
    readiness.jobsSnapshotReceived(scope: firstScope, streamID: "stale-stream")
    readiness.jobsSnapshotReceived(scope: nextScope, streamID: "stream-a")
    try require(
      !readiness.isReady,
      "A snapshot from another stream or account must not mark the Library connected")

    readiness.jobsSnapshotReceived(scope: firstScope, streamID: "stream-a")
    try require(
      readiness.isReady(scope: firstScope, streamID: "stream-a")
        && !readiness.isReady(scope: nextScope, streamID: "stream-a")
        && !readiness.isReady(scope: firstScope, streamID: "stale-stream"),
      "The matching first jobs snapshot must mark only its current account connection ready")
    readiness.jobsSubscriptionRequested(scope: firstScope, streamID: "stream-a")
    try require(
      readiness == .ready(scope: firstScope, streamID: "stream-a"),
      "Pagination on the ready connection must not hide established Library readiness")

    readiness.jobsSubscriptionRequested(scope: firstScope, streamID: "stream-b")
    try require(
      readiness == .awaitingInitialSnapshot(scope: firstScope, streamID: "stream-b")
        && !readiness.isReady,
      "A reconnect must require a fresh jobs snapshot even for the same account")
    readiness.jobsSnapshotReceived(scope: firstScope, streamID: "stream-a")
    try require(!readiness.isReady, "A late snapshot from the replaced stream must remain fenced")

    readiness.reset()
    try require(
      readiness == .disconnected && !readiness.isReady,
      "Disconnect and account teardown must clear Library snapshot readiness")
    readiness.jobsSubscriptionRequested(scope: nextScope, streamID: "stream-c")
    readiness.jobsSnapshotReceived(scope: nextScope, streamID: "stream-c")
    try require(
      readiness == .ready(scope: nextScope, streamID: "stream-c"),
      "A new account becomes ready only from its own connection snapshot")

    let emptyPage = try DesktopWorkspace.cloudJobsPage(
      .object(["items": .array([]), "next_cursor": .null]))
    let paged = try DesktopWorkspace.cloudJobsPage(
      .object([
        "items": .array([.object(["id": .string("job")])]), "next_cursor": .string("next"),
      ]))
    try require(
      emptyPage == DesktopCloudJobsPage(rows: [], nextCursor: nil)
        && paged.nextCursor == "next" && paged.rows.count == 1,
      "Valid empty and paginated jobs snapshots must preserve their distinct page state")
    let malformedPages: [DesktopJSON] = [
      .object(["next_cursor": .null]),
      .object(["items": .null, "next_cursor": .null]),
      .object(["items": .array([]), "next_cursor": .number(1)]),
      .object([
        "items": .array((0...50).map { .number(Double($0)) }), "next_cursor": .null,
      ]),
    ]
    try require(
      malformedPages.allSatisfy { (try? DesktopWorkspace.cloudJobsPage($0)) == nil },
      "Missing, mistyped and oversized jobs payloads must not count as an initial snapshot")
  }
  static func posixRetryChecks() throws {
    var integerAttempts = 0
    var integerCaptures = 0
    let retriedInteger = RuntimePOSIXCall.retryingInteger(
      {
        integerAttempts += 1
        return integerAttempts < 3 ? -1 : 17
      },
      captureErrno: {
        integerCaptures += 1
        return EINTR
      })
    try require(
      retriedInteger.succeeded && retriedInteger.value == 17 && integerAttempts == 3
        && integerCaptures == 2,
      "Interruptible integer POSIX calls must retry only failed EINTR attempts")

    var terminalAttempts = 0
    let terminalInteger = RuntimePOSIXCall.retryingInteger(
      {
        terminalAttempts += 1
        return -1
      }, captureErrno: { EAGAIN })
    try require(
      !terminalInteger.succeeded && terminalInteger.error == EAGAIN && terminalAttempts == 1
        && RuntimePOSIXCall.wouldBlock(terminalInteger.error)
        && RuntimePOSIXCall.wouldBlock(EWOULDBLOCK),
      "Non-EINTR failures must retain their captured errno without retrying")

    let pointer = UnsafeMutablePointer<CChar>.allocate(capacity: 1)
    defer { pointer.deallocate() }
    var pointerAttempts = 0
    var pointerCaptures = 0
    let retriedPointer = RuntimePOSIXCall.retryingPointer(
      {
        pointerAttempts += 1
        return pointerAttempts < 2 ? nil : pointer
      },
      captureErrno: {
        pointerCaptures += 1
        return EINTR
      })
    try require(
      retriedPointer.succeeded && retriedPointer.value == pointer && pointerAttempts == 2
        && pointerCaptures == 1,
      "Interruptible pointer POSIX calls must preserve a successful retry result")

    var createAttempts = 0
    var existingAttempts = 0
    let racedCreate = RuntimeUpdateLockFile.createOrOpen(
      create: {
        createAttempts += 1
        return createAttempts == 1
          ? RuntimePOSIXIntegerResult(value: -1, error: EEXIST)
          : RuntimePOSIXIntegerResult(value: 71, error: nil)
      },
      openExisting: {
        existingAttempts += 1
        return RuntimePOSIXIntegerResult(value: -1, error: ENOENT)
      })
    try require(
      racedCreate.succeeded && racedCreate.value == 71 && createAttempts == 2
        && existingAttempts == 1,
      "The update lock opener must retry only a witnessed create/open name transition")

    createAttempts = 0
    existingAttempts = 0
    let unsafeExisting = RuntimeUpdateLockFile.createOrOpen(
      create: {
        createAttempts += 1
        return RuntimePOSIXIntegerResult(value: -1, error: EEXIST)
      },
      openExisting: {
        existingAttempts += 1
        return RuntimePOSIXIntegerResult(value: -1, error: ELOOP)
      })
    try require(
      unsafeExisting.error == ELOOP && createAttempts == 1 && existingAttempts == 1,
      "An unsafe existing update-lock name must fail without retry")

    createAttempts = 0
    existingAttempts = 0
    let exhaustedTransition = RuntimeUpdateLockFile.createOrOpen(
      create: {
        createAttempts += 1
        return RuntimePOSIXIntegerResult(value: -1, error: EEXIST)
      },
      openExisting: {
        existingAttempts += 1
        return RuntimePOSIXIntegerResult(value: -1, error: ENOENT)
      })
    try require(
      exhaustedTransition.error == ENOENT
        && createAttempts == RuntimeUpdateLockFile.maximumCreateOpenTransitions
        && existingAttempts == RuntimeUpdateLockFile.maximumCreateOpenTransitions,
      "A repeatedly replaced update-lock name must fail after the bounded transition budget")
  }
  @MainActor static func visualPreferenceChecks() throws {
    let defaults = testPreferences()
    defaults.set("sepia", forKey: DesktopPreferenceKey.appearance)
    defaults.set("red", forKey: DesktopPreferenceKey.accent)
    defaults.set("huge", forKey: DesktopPreferenceKey.textSize)
    defaults.set("fr", forKey: DesktopPreferenceKey.language)

    let repaired = DesktopVisualPreferences(defaults: defaults)
    try require(
      repaired.appearance == .system && repaired.accent == .orange
        && repaired.textSize == .system && repaired.language == .system,
      "Malformed visual preferences must use safe fallbacks")
    try require(
      defaults.string(forKey: DesktopPreferenceKey.appearance) == "system"
        && defaults.string(forKey: DesktopPreferenceKey.accent) == "orange"
        && defaults.string(forKey: DesktopPreferenceKey.textSize) == "system"
        && defaults.string(forKey: DesktopPreferenceKey.language) == "system",
      "Malformed visual preferences must repair their stored values")

    let repairedValues = visualPreferenceValues(defaults)
    let reloaded = DesktopVisualPreferences(defaults: defaults)
    try require(
      reloaded.appearance == .system && reloaded.accent == .orange
        && reloaded.textSize == .system && reloaded.language == .system
        && visualPreferenceValues(defaults) == repairedValues,
      "Repaired visual preferences must remain stable when loaded again")

    repaired.appearance = .dark
    repaired.accent = .mint
    repaired.textSize = .accessibility
    repaired.language = .arabic
    try require(
      defaults.string(forKey: DesktopPreferenceKey.appearance) == "dark"
        && defaults.string(forKey: DesktopPreferenceKey.accent) == "mint"
        && defaults.string(forKey: DesktopPreferenceKey.textSize) == "accessibility"
        && defaults.string(forKey: DesktopPreferenceKey.language) == "ar",
      "Visual preference changes must persist immediately")

    let changedValues = visualPreferenceValues(defaults)
    repaired.appearance = .dark
    repaired.accent = .mint
    repaired.textSize = .accessibility
    repaired.language = .arabic
    try require(
      visualPreferenceValues(defaults) == changedValues,
      "Repeated visual preference assignments must leave persisted storage unchanged")
  }

  @MainActor static func offlineStorageDefaultChecks() throws {
    let account = DesktopAccountModel(
      configuration: configuration(), vault: MemoryVault(), transport: FixtureTransport([]),
      installationId: installation, preferences: testPreferences())
    let workspace = DesktopWorkspace(
      account: account, resources: nil, preferences: testPreferences())
    try require(
      workspace.budgetBytes == 2_000_000_000 && workspace.cacheBytes == 0,
      "A fresh workspace must show the two-gigabyte offline limit before companion loading")
  }

  @MainActor static func offlineStorageSaveChecks() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "musicmute-desktop-storage-\(UUID())")
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(
      at: root.appendingPathComponent("runtime/runtime/node/bin"), withIntermediateDirectories: true
    )
    try FileManager.default.createDirectory(
      at: root.appendingPathComponent("companion"), withIntermediateDirectories: true)
    try Data("fixture".utf8).write(to: root.appendingPathComponent("companion/desktop-control.js"))
    let node = root.appendingPathComponent("runtime/runtime/node/bin/node")
    let requests = root.appendingPathComponent("companion/requests.jsonl")
    let prefix = #"""
      #!/bin/sh
      IFS= read -r envelope
      printf '%s\n' "$envelope" >> companion/requests.jsonl
      id=$(printf '%s' "$envelope" | /usr/bin/sed -nE 's/.*"request_id":"([^"]+)".*/\1/p')
      """#
    func script(budget: Int64, cache: Int64) throws {
      let tail =
        "printf '{\"protocol_version\":1,\"request_id\":\"%s\",\"type\":\"result\",\"payload\":{\"cache_bytes\":\(cache),\"budget_bytes\":\(budget)}}\\n' \"$id\""
      try Data((prefix + "\n" + tail + "\n").utf8).write(to: node)
      try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: node.path)
    }
    func recorded() throws -> [DesktopJSON] {
      try String(contentsOf: requests, encoding: .utf8).split(separator: "\n").map {
        try JSONDecoder().decode(DesktopJSON.self, from: Data($0.utf8))
      }
    }
    let account = DesktopAccountModel(
      configuration: configuration(), vault: MemoryVault(),
      transport: FixtureTransport([try credentials(), profile]),
      installationId: installation, preferences: testPreferences())
    await account.signIn(email: "fixture@example.invalid", password: "fixture-password")
    try require(
      account.signedIn && account.localSession() != nil,
      "The storage fixture must have a real synthetic account session to test command privacy")
    let workspace = DesktopWorkspace(
      account: account, resources: root, playbackSupport: root, preferences: testPreferences())
    try script(budget: 5_000_000_000, cache: 1_024)
    await workspace.saveOfflineStorageLimit(gigabytes: "0")
    try require(
      workspace.cacheBudgetStatus == "Enter a whole number of GB, starting at 1."
        && workspace.budgetBytes == 2_000_000_000 && !workspace.savingCacheBudget
        && !workspace.bridge.busy && !FileManager.default.fileExists(atPath: requests.path),
      "An invalid storage limit must show validation without invoking the helper")
    await workspace.saveOfflineStorageLimit(gigabytes: "5")
    try require(
      workspace.budgetBytes == 5_000_000_000 && workspace.cacheBytes == 1_024
        && workspace.cacheBudgetStatus == "Offline voice storage limit saved."
        && !workspace.savingCacheBudget && !workspace.bridge.busy,
      "A successful storage settings save must update the limit, usage and final status")
    let commands = try recorded()
    guard commands.count == 1, case .object(let fields) = commands[0] else {
      throw DesktopTestFailure.failed("Storage save must send exactly one command")
    }
    try require(
      Set(fields.keys) == Set(["protocol_version", "request_id", "type", "payload"])
        && commands[0]["protocol_version"].number == 1
        && commands[0]["type"].string == "SET_CACHE_BUDGET"
        && commands[0]["payload"] == .object(["budget_bytes": .number(5_000_000_000)])
        && commands[0]["request_id"].string.flatMap({ UUID(uuidString: $0) }) != nil,
      "Storage save must send the exact byte budget with no account session or extra fields")

    try script(budget: 4_000_000_000, cache: 9_999)
    await workspace.saveOfflineStorageLimit(gigabytes: "6")
    try require(
      workspace.budgetBytes == 5_000_000_000 && workspace.cacheBytes == 1_024
        && workspace.cacheBudgetStatus
          == "The storage limit could not be saved. Try again after MusicMute finishes its current operation."
        && !workspace.savingCacheBudget && !workspace.bridge.busy,
      "A mismatched helper reply must preserve the prior limit and usage and show a save error")
    let afterMismatch = try recorded()
    try require(
      afterMismatch.count == 2
        && afterMismatch[1]["payload"] == .object(["budget_bytes": .number(6_000_000_000)]),
      "A later storage save must send its newly selected limit")
  }

  @MainActor static func playbackClockChecks() throws {
    let account = DesktopAccountModel(
      configuration: configuration(), vault: MemoryVault(), transport: FixtureTransport([]),
      installationId: installation, preferences: testPreferences())
    let workspace = DesktopWorkspace(
      account: account, resources: nil, preferences: testPreferences())
    var workspacePublishes = 0
    var positionPublishes = 0
    var durationPublishes = 0
    var cancellables = Set<AnyCancellable>()
    workspace.objectWillChange.sink { workspacePublishes += 1 }.store(in: &cancellables)
    workspace.playbackClock.$position.sink { _ in positionPublishes += 1 }.store(
      in: &cancellables)
    workspace.playbackClock.$duration.sink { _ in durationPublishes += 1 }.store(
      in: &cancellables)

    workspace.playbackClock.update(position: 12.5, duration: 60)
    try require(
      workspace.playbackClock.position == 12.5 && workspace.playbackClock.duration == 60
        && positionPublishes == 2 && durationPublishes == 2,
      "Playback clock changes must publish through the lightweight clock state")
    workspace.playbackClock.update(position: 12.5, duration: 60)
    workspace.playbackClock.update(position: 12.500_05, duration: 60.000_05)
    try require(
      positionPublishes == 2 && durationPublishes == 2,
      "Unchanged and sub-threshold playback clocks must not republish")
    workspace.playbackClock.update(position: 12.51, duration: 60.01)
    try require(
      positionPublishes == 3 && durationPublishes == 3,
      "Meaningful playback clock changes must still publish")
    try require(
      workspacePublishes == 0,
      "Playback clock ticks must not invalidate the full desktop workspace")
    withExtendedLifetime(cancellables) {}
  }

  private static func visualPreferenceValues(_ defaults: UserDefaults) -> [String: String] {
    [
      DesktopPreferenceKey.appearance, DesktopPreferenceKey.accent,
      DesktopPreferenceKey.textSize, DesktopPreferenceKey.language,
    ].reduce(into: [:]) { values, key in values[key] = defaults.string(forKey: key) }
  }
  @MainActor static func authChecks() async throws {
    let defaults = testPreferences()
    let vault = MemoryVault()
    let transport = FixtureTransport([
      try credentials(), profile, .object(["status": .string("accepted")]),
    ])
    let account = DesktopAccountModel(
      configuration: configuration(), vault: vault, transport: transport,
      installationId: installation, preferences: defaults)
    let original = account.generation
    await account.signIn(email: "fixture@example.invalid", password: "fixture-password")
    try require(
      account.signedIn && account.online && account.user?.id == "000000000000000000000042",
      "Email sign-in must bootstrap owner")
    try require(
      account.generation != original && vault.credential?.firebaseUid == uid,
      "Sign-in must rotate scope and save Keychain credential")
    let records = await transport.recorded()
    let report = try JSONDecoder().decode(DesktopJSON.self, from: records[1].httpBody!)
    try require(
      report["platform"].string == "macos" && report["installation_id"].string == installation,
      "Bootstrap must use first-class Mac snake-case metadata")
    try require(
      records[1].value(forHTTPHeaderField: "X-Installation-Id") == installation,
      "Installation auth header required")
    let session = account.localSession()
    try require(
      session?["firebase_uid"].string == uid
        && session?["id_token"].string == vault.credential?.idToken,
      "Local ownership may reuse a valid token without a refresh request")
    await account.resetPassword(email: "unknown@example.invalid")
    try require(
      account.notice?.contains("If this email has an account") == true,
      "Reset must preserve account existence privacy")
    let beforeLogout = account.generation
    await account.logout()
    try require(
      !account.signedIn && account.generation != beforeLogout && vault.credential == nil,
      "Local logout must invalidate work before secure cleanup")
  }
  @MainActor static func cloudSubmissionFenceChecks() async throws {
    let vault = MemoryVault()
    let transport = FixtureTransport([
      try credentials(), profile, .object(["status": .string("accepted")]),
    ])
    let account = DesktopAccountModel(
      configuration: configuration(), vault: vault, transport: transport,
      installationId: installation, preferences: testPreferences())
    await account.signIn(email: "fixture@example.invalid", password: "fixture-password")
    guard let acceptedScope = account.scope else {
      throw DesktopTestFailure.failed("Fixture account must sign in")
    }
    let workspace = DesktopWorkspace(account: account, resources: nil)
    let requestsBefore = await transport.recorded().count
    await workspace.process(
      url: "https://www.youtube.com/watch?v=AbCdEfGh_-1", file: nil, cloud: true,
      expectedAccountScope: DesktopSessionScope(
        firebaseUid: acceptedScope.firebaseUid, generation: UUID()))
    try require(
      workspace.failure
        == "Your account changed. Review the account and confirm cloud processing again.",
      "A stale confirmation must stop before the bridge or network")
    await workspace.process(
      url: "https://www.youtube.com/watch?v=AbCdEfGh_-1", file: nil, cloud: true)
    try require(
      workspace.failure
        == "Your account changed. Review the account and confirm cloud processing again.",
      "Unconfirmed cloud work must stop before the bridge or network")
    let requestsAfter = await transport.recorded().count
    try require(
      requestsBefore == requestsAfter && !workspace.processing,
      "Refused cloud confirmation must make no network request")
    let handoff = DesktopCloudHandoff(
      url: URL(string: "musicmute-local://cloud?video_id=AbCdEfGh_-1")!)!
    workspace.receiveCloudHandoff(handoff)
    try require(
      workspace.pendingCloudHandoff == handoff && !workspace.processing,
      "A handoff must only prefill the form")
    workspace.consumeCloudHandoff()
    try require(workspace.pendingCloudHandoff == nil, "The form can explicitly consume a handoff")
    workspace.shutdown()
  }
  @MainActor static func staleSignInFence() async throws {
    let vault = MemoryVault()
    let transport = FixtureTransport(replies: [
      .init(value: try credentials(), status: 200, pause: true)
    ])
    let account = DesktopAccountModel(
      configuration: configuration(), vault: vault, transport: transport,
      installationId: installation,
      preferences: testPreferences())
    let login = Task {
      await account.signIn(email: "fixture@example.invalid", password: "fixture-password")
    }
    await transport.waitUntilBlocked()
    await account.logout()
    await transport.release()
    await login.value
    try require(
      !account.signedIn && vault.credential == nil && account.failure == .sessionChanged,
      "Late login must never resurrect a logged-out session")
  }
  @MainActor static func delayedRestoreChecks() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "musicmute-delayed-restore-\(UUID())")
    defer { try? FileManager.default.removeItem(at: root) }
    let stored = DesktopCredential(
      firebaseUid: uid, idToken: try token(), refreshToken: String(repeating: "r", count: 30),
      expiresAt: Date().addingTimeInterval(3600), user: nil)
    let vault = MemoryVault()
    vault.credential = stored
    vault.pauseLoad = true
    let store = DesktopAccountStateStore(support: root.appendingPathComponent("responsive"))
    let account = DesktopAccountModel(
      configuration: configuration(), vault: vault, transport: FixtureTransport([profile]),
      installationId: installation, preferences: testPreferences(), stateStore: store)
    let restoring = Task { await account.restore() }
    await vault.waitUntilLoadBlocked()
    var mainActorRan = false
    await Task { @MainActor in mainActorRan = true }.value
    account.receivePolicy(.object(["fixture_responsive": .bool(true)]))
    await account.restore()
    try require(
      mainActorRan && account.policy["fixture_responsive"].bool == true && vault.loads == 1
        && !account.busy && !account.signedIn,
      "A pending credential read must leave the main actor responsive and coalesce restores")
    vault.releaseLoad()
    await restoring.value
    try require(account.signedIn && account.online, "Current delayed credentials must restore")
    let state = store.support.appendingPathComponent("account-state.json")
    let accepted = try Data(contentsOf: state)
    await account.restore()
    let redundant = try Data(contentsOf: state)
    try require(
      redundant == accepted && vault.loads == 1,
      "A redundant restore must preserve an accepted owner marker")

    for action in ["login", "logout", "cancel", "busy", "signedOut"] {
      for fails in [false, true] {
        let defaults = testPreferences()
        let vault = MemoryVault()
        vault.credential = stored
        vault.pauseLoad = true
        vault.loadFailure = fails ? .credentialsUnavailable : nil
        let store = DesktopAccountStateStore(
          support: root.appendingPathComponent("\(action)-\(fails)"))
        let transport = FixtureTransport(replies: [
          .init(
            value: try credentials("fixture-new-desktop-owner"), status: 200,
            pause: action == "busy"),
          .init(value: profile, status: 200, pause: false),
        ])
        let account = DesktopAccountModel(
          configuration: configuration(), vault: vault, transport: transport,
          installationId: installation, preferences: defaults, stateStore: store)
        var publications: [DesktopSessionScope?] = []
        account.onSessionChanged = { publications.append($0) }
        let restoring = Task { await account.restore() }
        await vault.waitUntilLoadBlocked()
        var login: Task<Void, Never>?
        switch action {
        case "login":
          await account.signIn(email: "fixture@example.invalid", password: "fixture-password")
        case "logout": await account.logout()
        case "cancel": restoring.cancel()
        case "busy":
          login = Task {
            await account.signIn(email: "fixture@example.invalid", password: "fixture-password")
          }
          await transport.waitUntilBlocked()
        case "signedOut": defaults.set(true, forKey: "desktop.signedOut.\(project)")
        default: throw DesktopTestFailure.failed("Unknown restore fixture")
        }
        let state = store.support.appendingPathComponent("account-state.json")
        let before = try Data(contentsOf: state)
        let generation = account.generation
        let publicationCount = publications.count
        account.failure = .service("FIXTURE_LATEST_FAILURE")
        vault.releaseLoad()
        await restoring.value
        let after = try Data(contentsOf: state)
        try require(
          after == before && account.generation == generation
            && publications.count == publicationCount
            && account.failure == .service("FIXTURE_LATEST_FAILURE")
            && account.firebaseUid == (action == "login" ? "fixture-new-desktop-owner" : nil),
          "Late credential \(fails ? "failure" : "success") must preserve \(action) owner state")
        let requests = await transport.recorded()
        try require(
          requests.count == (action == "login" ? 2 : action == "busy" ? 1 : 0),
          "An obsolete restore must never bootstrap its previous owner")
        if let login {
          await transport.release()
          await login.value
        }
      }
    }
    let failedVault = MemoryVault()
    failedVault.loadFailure = .credentialsUnavailable
    let failed = DesktopAccountModel(
      configuration: configuration(), vault: failedVault, transport: FixtureTransport([]),
      installationId: installation, preferences: testPreferences())
    await failed.restore()
    try require(
      !failed.signedIn && failed.failure == .credentialsUnavailable,
      "A current credential load failure must remain visible")
  }
  @MainActor static func staleRefreshFence() async throws {
    let vault = MemoryVault()
    vault.credential = DesktopCredential(
      firebaseUid: uid, idToken: try token(), refreshToken: String(repeating: "r", count: 30),
      expiresAt: .distantPast, user: nil)
    let refresh = DesktopJSON.object([
      "user_id": .string(uid), "id_token": .string(try token()),
      "refresh_token": .string(String(repeating: "s", count: 30)), "expires_in": .string("3600"),
    ])
    let transport = FixtureTransport(replies: [.init(value: refresh, status: 200, pause: true)])
    let account = DesktopAccountModel(
      configuration: configuration(), vault: vault, transport: transport,
      installationId: installation,
      preferences: testPreferences())
    let restore = Task { await account.restore() }
    await transport.waitUntilBlocked()
    try require(
      account.localSession()?["firebase_uid"].string == uid
        && account.localSession()?["id_token"] == .null,
      "Expired token must still allow local owner identity without forwarding stale credentials")
    await account.logout()
    await transport.release()
    await restore.value
    try require(
      !account.signedIn && vault.credential == nil,
      "Late token refresh must remain fenced after logout")
  }
  @MainActor static func logoutFailureFence() async throws {
    let defaults = testPreferences()
    let vault = MemoryVault()
    let account = DesktopAccountModel(
      configuration: configuration(), vault: vault,
      transport: FixtureTransport([try credentials(), profile]), installationId: installation,
      preferences: defaults)
    await account.signIn(email: "fixture@example.invalid", password: "fixture-password")
    vault.rejectRemoval = true
    await account.logout()
    try require(
      !account.signedIn && account.failure == .credentialsUnavailable,
      "Keychain cleanup failure must not retain active account")
    let restarted = DesktopAccountModel(
      configuration: configuration(), vault: vault,
      transport: FixtureTransport([]), installationId: installation, preferences: defaults)
    await restarted.restore()
    try require(
      !restarted.signedIn,
      "Logout marker must prevent credential resurrection when Keychain delete failed")
  }
  @MainActor static func readReplayChecks() async throws {
    let rejected = DesktopJSON.object(["code": .string("UNAUTHENTICATED")])
    let transport = FixtureTransport(replies: [
      .init(value: try credentials(), status: 200, pause: false),
      .init(value: profile, status: 200, pause: false),
      .init(value: rejected, status: 401, pause: false),
      .init(value: try credentials(), status: 200, pause: false),
      .init(value: profile["user"], status: 200, pause: false),
      .init(value: rejected, status: 401, pause: false),
    ])
    let account = DesktopAccountModel(
      configuration: configuration(), vault: MemoryVault(), transport: transport,
      installationId: installation, preferences: testPreferences())
    await account.signIn(email: "fixture@example.invalid", password: "fixture-password")
    let profile = try await account.api("GET", "/users/me")
    try require(
      profile["id"].string == "000000000000000000000042",
      "Read may refresh then replay under the same owner")
    do {
      _ = try await account.api("POST", "/auth/profile-synchronizations", body: .object([:]))
      throw DesktopTestFailure.failed("Unauthorized mutation succeeded")
    } catch is DesktopAuthFailure {}
    let requests = await transport.recorded()
    try require(
      requests.count == 6, "Unauthorized mutation must have one attempt and no automatic replay")
    try require(
      requests[3].url?.host == "securetoken.googleapis.com",
      "Read retry must first refresh Firebase credentials")
  }
  @MainActor static func googleDeadlineChecks() async throws {
    try require(
      DesktopGoogleOAuth.browserWaitLimit == .seconds(600),
      "Production browser sign-in must retain a bounded ten-minute deadline")
    var exchanges = 0
    let exchange: @MainActor (String, String, String) async throws -> String = { _, _, _ in
      exchanges += 1
      throw DesktopAuthFailure.service("GOOGLE_TOKEN_UNAVAILABLE")
    }
    var timeoutOpened = 0
    let expired = DesktopGoogleOAuth(
      clientID: configuration().googleDesktopClientID!, exchangeCode: exchange,
      browserDeadline: .milliseconds(40),
      openBrowser: { url in
        timeoutOpened += 1
        return url.host == "accounts.google.com"
      })
    do {
      _ = try await expired.signIn()
      throw DesktopTestFailure.failed("A browser callback that never arrives must expire")
    } catch let failure as DesktopAuthFailure {
      try require(
        failure.code == "GOOGLE_SIGN_IN_TIMEOUT" && failure != .cancelled
          && failure.message.contains("Start again") && !failure.message.contains("cancelled"),
        "Deadline expiry must provide restart guidance and remain distinct from user cancellation")
    }
    expired.cancel()
    try require(timeoutOpened == 1, "The fixture must exercise the real loopback listener deadline")
    var cancelOpened = false
    let cancelled = DesktopGoogleOAuth(
      clientID: configuration().googleDesktopClientID!, exchangeCode: exchange,
      browserDeadline: .milliseconds(200),
      openBrowser: { _ in
        cancelOpened = true
        return true
      })
    let pending = Task { @MainActor in try await cancelled.signIn() }
    for _ in 0..<100 where !cancelOpened { try await Task.sleep(for: .milliseconds(10)) }
    try require(cancelOpened, "Explicit cancellation must run after browser wait becomes active")
    cancelled.cancel()
    cancelled.cancel()
    do {
      _ = try await pending.value
      throw DesktopTestFailure.failed("Explicit browser cancellation must terminate sign-in")
    } catch let failure as DesktopAuthFailure {
      try require(
        failure == .cancelled && failure.code == "SIGN_IN_CANCELLED",
        "Explicit cancellation must keep its own error instead of claiming a timeout")
    }
    // Passing the old deadline after repeated cleanup must not resume a completed continuation.
    try await Task.sleep(for: .milliseconds(250))
    try require(
      exchanges == 0,
      "Expired or cancelled browser waits must never exchange credentials or contact cloud APIs")
  }
  @MainActor static func googleTokenFailureChecks() throws {
    let cases: [(Int, String, String?, String)] = [
      (400, "GOOGLE_TOKEN_INVALID_GRANT", nil, "GOOGLE_TOKEN_INVALID_GRANT"),
      (429, "RATE_LIMITED", nil, "GOOGLE_TOKEN_UNAVAILABLE"),
      (503, "SERVICE_UNAVAILABLE", nil, "GOOGLE_TOKEN_UNAVAILABLE"),
      (400, "INVALID_INPUT", nil, "GOOGLE_TOKEN_EXCHANGE_FAILED"),
      (401, "GOOGLE_TOKEN_INVALID_GRANT", nil, "GOOGLE_TOKEN_EXCHANGE_FAILED"),
      (400, "SERVICE_UNAVAILABLE", nil, "GOOGLE_TOKEN_EXCHANGE_FAILED"),
      (503, "UNRECOGNIZED_SERVER_CODE", nil, "GOOGLE_TOKEN_EXCHANGE_FAILED"),
      (502, "SERVICE_UNAVAILABLE", nil, "GOOGLE_TOKEN_EXCHANGE_FAILED"),
      (400, "invalid_request", "client_secret is missing.", "GOOGLE_TOKEN_EXCHANGE_FAILED"),
      (400, "NEW_PRIVATE_IDENTIFIER", "fixture-secret", "GOOGLE_TOKEN_EXCHANGE_FAILED"),
      (400, "token=fixture-secret", "fixture-secret", "GOOGLE_TOKEN_EXCHANGE_FAILED"),
    ]
    for (status, error, description, expected) in cases {
      var fields: [String: DesktopJSON] = ["code": .string(error)]
      if let description { fields["detail"] = .string(description) }
      let failure = DesktopGoogleOAuth.tokenExchangeFailure(
        status: status, response: .object(fields))
      try require(
        failure.code == expected && failure.signInJournalCode == expected,
        "Known backend problem statuses and codes must project fixed safe service/journal codes")
      try require(
        !failure.message.contains("fixture-secret") && !failure.message.contains("/private/")
          && !failure.message.contains("client_secret"),
        "Raw token failure descriptions and credential-like text must never reach UI messages")
    }
    try require(
      DesktopGoogleOAuth.tokenExchangeFailure(status: 400, response: .null).code
        == "GOOGLE_TOKEN_EXCHANGE_FAILED",
      "Malformed or unknown token error data must produce a fixed fallback")
    try require(
      DesktopAuthFailure.service("RAW_CREDENTIAL_IDENTIFIERS").signInJournalCode
        == "AUTH_SIGN_IN_FAILED",
      "Other authentication failure identifiers must never be copied into the journal")
  }
  @MainActor static func googleCallbackPageChecks() throws {
    let resources = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("Resources")
    guard let bundle = Bundle(url: resources) else {
      throw DesktopTestFailure.failed("Callback localization fixture bundle")
    }
    for language in ["en", "ar"] {
      for cancelled in [false, true] {
        let response = DesktopGoogleOAuth.callbackResponse(
          cancelled: cancelled, language: language, bundle: bundle)
        let parts = response.components(separatedBy: "\r\n\r\n")
        try require(parts.count == 2, "Callback page must be a complete HTTP response")
        let header = parts[0]
        let body = parts[1]
        try require(
          header.contains("Content-Type: text/html; charset=utf-8")
            && header.contains("Cache-Control: no-store")
            && header.contains("Referrer-Policy: no-referrer")
            && header.contains("X-Content-Type-Options: nosniff")
            && header.contains("Content-Length: \(body.utf8.count)\r\n"),
          "Localized callback HTML must be private, correctly typed and byte-counted")
        try require(
          header.contains("default-src 'none'") && header.contains("frame-ancestors 'none'")
            && !header.contains("unsafe-inline"),
          "The page must permit only its hashed local style and script")
        for tag in ["style", "script"] {
          guard let start = body.range(of: "<\(tag)>"),
            let end = body.range(of: "</\(tag)>", range: start.upperBound..<body.endIndex)
          else { throw DesktopTestFailure.failed("Callback inline \(tag)") }
          let hash = Data(SHA256.hash(data: Data(body[start.upperBound..<end.lowerBound].utf8)))
            .base64EncodedString()
          try require(header.contains("'sha256-\(hash)'"), "CSP must allow the exact inline \(tag)")
        }
        try require(
          body.contains("lang=\"\(language)\"")
            && body.contains("dir=\"\(language == "ar" ? "rtl" : "ltr")\"")
            && body.contains("href=\"musicmute-local://account\"")
            && body.contains("history.replaceState(null, '', '/oauth2callback')")
            && !body.contains("https://") && !body.contains("http://"),
          "The page must support RTL, link only to Account and scrub the callback address")
        try require(
          language == "en"
            ? body.contains(cancelled ? "Sign-in cancelled" : "Continue in MusicMute")
            : body.contains(cancelled ? "أُلغي تسجيل الدخول" : "المتابعة في MusicMute"),
          "Both page outcomes must use actual English/Arabic translations")
      }
    }
  }
  @MainActor static func googleCallbackResponseChecks() async throws {
    // Exercise the real loopback socket with an immediate exchange; cleanup must not truncate HTML.
    for cancelled in [false, true] {
      var responseTask: Task<(Data, URLResponse), Error>?
      var exchanges = 0
      let oauth = DesktopGoogleOAuth(
        clientID: configuration().googleDesktopClientID!,
        exchangeCode: { code, _, _ in
          exchanges += 1
          try require(
            code == "<script>private-fixture-code</script>",
            "Only native exchange receives the code")
          return "fixture-id-token"
        }, browserDeadline: .seconds(2),
        openBrowser: { authorization in
          let fields = URLComponents(url: authorization, resolvingAgainstBaseURL: false)?.queryItems
          guard let redirect = fields?.first(where: { $0.name == "redirect_uri" })?.value,
            let state = fields?.first(where: { $0.name == "state" })?.value,
            var callback = URLComponents(string: redirect)
          else { return false }
          callback.queryItems = [
            URLQueryItem(name: "state", value: state),
            URLQueryItem(
              name: cancelled ? "error" : "code",
              value: cancelled ? "access_denied" : "<script>private-fixture-code</script>"),
          ]
          guard let url = callback.url else { return false }
          responseTask = Task {
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 2
            let session = URLSession(configuration: config)
            defer { session.invalidateAndCancel() }
            return try await session.data(from: url)
          }
          return true
        })
      do {
        let result = try await oauth.signIn()
        try require(
          !cancelled && result.idToken == "fixture-id-token",
          "Successful callback must exchange once")
      } catch let failure as DesktopAuthFailure {
        try require(
          cancelled && failure == .cancelled, "Cancelled callback must retain cancellation")
      }
      guard let responseTask else { throw DesktopTestFailure.failed("Callback response fixture") }
      let (data, rawResponse) = try await responseTask.value
      let response = rawResponse as? HTTPURLResponse
      let body = String(decoding: data, as: UTF8.self)
      try require(
        response?.statusCode == 200 && response?.mimeType == "text/html"
          && body.hasSuffix("</html>")
          && body.contains("musicmute-local://account") && !body.contains("private-fixture-code")
          && exchanges == (cancelled ? 0 : 1),
        "A complete private HTML page must arrive before immediate exchange or cancellation teardown"
      )
    }
  }
  @MainActor static func googleCallback(_ authorization: URL) -> Bool {
    guard authorization.host == "accounts.google.com",
      let fields = URLComponents(url: authorization, resolvingAgainstBaseURL: false)?.queryItems,
      let redirect = fields.first(where: { $0.name == "redirect_uri" })?.value,
      let state = fields.first(where: { $0.name == "state" })?.value,
      var callback = URLComponents(string: redirect), callback.host == "127.0.0.1"
    else { return false }
    callback.queryItems = [
      URLQueryItem(name: "code", value: "fixture-authorization-code"),
      URLQueryItem(name: "state", value: state),
    ]
    guard let url = callback.url else { return false }
    Task {
      let config = URLSessionConfiguration.ephemeral
      config.timeoutIntervalForRequest = 2
      let session = URLSession(configuration: config)
      defer { session.invalidateAndCancel() }
      _ = try? await session.data(from: url)
    }
    return true
  }
  @MainActor static func googleExchangeChecks() async throws {
    let googleToken = String(repeating: "g", count: 40)
    let transport = FixtureTransport([
      .object(["google_id_token": .string(googleToken)]), try credentials(), profile,
    ])
    let vault = MemoryVault()
    var browserURL: URL?
    let account = DesktopAccountModel(
      configuration: configuration(), vault: vault, transport: transport,
      installationId: installation, preferences: testPreferences(),
      googleBrowserDeadline: .seconds(2),
      openGoogleBrowser: { url in
        browserURL = url
        return googleCallback(url)
      })
    await account.signInGoogle()
    try require(
      account.signedIn && account.online, "Backend Google exchange must bootstrap account")
    let requests = await transport.recorded()
    try require(
      requests.count == 3, "Google sign-in must exchange once before Firebase and backend session")
    let exchange = requests[0]
    try require(
      exchange.url?.absoluteString
        == "https://api.example.invalid/auth/desktop-google-token-exchanges"
        && exchange.httpMethod == "POST"
        && exchange.value(forHTTPHeaderField: "Content-Type") == "application/json"
        && exchange.value(forHTTPHeaderField: "X-Installation-Id") == installation
        && exchange.value(forHTTPHeaderField: "Authorization") == nil,
      "Google exchange must reuse the approved backend origin and installation header without bearer"
    )
    let body = try JSONDecoder().decode(DesktopJSON.self, from: exchange.httpBody!)
    guard case .object(let fields) = body else {
      throw DesktopTestFailure.failed("Google exchange body")
    }
    try require(
      Set(fields.keys) == Set(["authorization_code", "code_verifier", "redirect_uri"])
        && body["authorization_code"].string == "fixture-authorization-code",
      "Exchange may transmit only snake-case code, verifier and actual loopback callback; no secret or client override"
    )
    let verifier = body["code_verifier"].string ?? ""
    let authFields =
      URLComponents(url: browserURL!, resolvingAgainstBaseURL: false)?.queryItems ?? []
    try require(
      verifier.count == 43
        && authFields.first(where: { $0.name == "code_challenge_method" })?.value == "S256"
        && authFields.first(where: { $0.name == "code_challenge" })?.value
          == DesktopGoogleOAuth.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        && authFields.first(where: { $0.name == "redirect_uri" })?.value
          == body["redirect_uri"].string,
      "Backend exchange must use the same PKCE verifier and exact random loopback callback as browser authorization"
    )
    let firebase = try JSONDecoder().decode(DesktopJSON.self, from: requests[1].httpBody!)
    try require(
      requests[1].url?.host == "identitytoolkit.googleapis.com"
        && firebase == DesktopAccountModel.googleCredentialBody(googleToken),
      "Only exchanged Google ID token may proceed through the existing logical localhost Firebase IdP flow"
    )
    try require(
      requests.allSatisfy { $0.url?.host != "oauth2.googleapis.com" },
      "The Mac must never call Google's token endpoint directly")
  }
  @MainActor static func googleExchangeFailureChecks() async throws {
    let fixtures: [(FixtureTransport.Reply, String)] = [
      (
        .init(
          value: .object(["code": .string("GOOGLE_TOKEN_INVALID_GRANT")]), status: 400, pause: false
        ), "GOOGLE_TOKEN_INVALID_GRANT"
      ),
      (
        .init(value: .object(["code": .string("SERVICE_UNAVAILABLE")]), status: 503, pause: false),
        "GOOGLE_TOKEN_UNAVAILABLE"
      ),
      (
        .init(value: .object(["code": .string("RATE_LIMITED")]), status: 429, pause: false),
        "GOOGLE_TOKEN_UNAVAILABLE"
      ),
      (
        .init(
          value: .object([
            "code": .string("PRIVATE_TOKEN_IDENTIFIER"),
            "detail": .string("fixture-secret /private/path"),
          ]), status: 400, pause: false), "GOOGLE_TOKEN_EXCHANGE_FAILED"
      ),
      (
        .init(
          value: .object(["id_token": .string(String(repeating: "g", count: 40))]), status: 200,
          pause: false), "GOOGLE_TOKEN_EXCHANGE_FAILED"
      ),
      (
        .init(value: .object(["google_id_token": .string("too-short")]), status: 200, pause: false),
        "GOOGLE_TOKEN_EXCHANGE_FAILED"
      ),
      (
        .init(
          value: .object(["google_id_token": .string(String(repeating: "g", count: 40))]),
          status: 201, pause: false), "GOOGLE_TOKEN_EXCHANGE_FAILED"
      ),
      (
        .init(value: .null, status: 200, pause: false, data: Data("{invalid fixture-secret".utf8)),
        "GOOGLE_TOKEN_EXCHANGE_FAILED"
      ),
      (
        .init(value: .null, status: 200, pause: false, data: Data(repeating: 65, count: 32_769)),
        "GOOGLE_TOKEN_EXCHANGE_FAILED"
      ),
    ]
    for (reply, expected) in fixtures {
      let transport = FixtureTransport(replies: [reply])
      let vault = MemoryVault()
      let account = DesktopAccountModel(
        configuration: configuration(), vault: vault, transport: transport,
        installationId: installation, preferences: testPreferences(),
        googleBrowserDeadline: .seconds(2),
        openGoogleBrowser: googleCallback)
      await account.signInGoogle()
      let requests = await transport.recorded()
      try require(
        account.failure?.code == expected && requests.count == 1 && vault.credential == nil,
        "Rejected or malformed exchange must stop before Firebase, secure persistence and any automatic retry"
      )
      try require(
        account.failure?.message.contains("fixture-secret") == false
          && account.failure?.message.contains("PRIVATE_TOKEN_IDENTIFIER") == false,
        "Unknown backend details and identifiers must not be rendered")
    }
    let unavailable = DesktopAccountModel(
      configuration: configuration(), vault: MemoryVault(), transport: FixtureTransport([]),
      installationId: installation, preferences: testPreferences(),
      googleBrowserDeadline: .seconds(2),
      openGoogleBrowser: googleCallback)
    await unavailable.signInGoogle()
    try require(
      unavailable.failure?.code == "GOOGLE_TOKEN_UNAVAILABLE",
      "Transport failure must use a fixed temporary failure")
  }
  @MainActor static func googleExchangeFenceChecks() async throws {
    for cancel in [false, true] {
      let transport = FixtureTransport(replies: [
        .init(
          value: .object(["google_id_token": .string(String(repeating: "g", count: 40))]),
          status: 200, pause: true)
      ])
      let vault = MemoryVault()
      let account = DesktopAccountModel(
        configuration: configuration(), vault: vault, transport: transport,
        installationId: installation, preferences: testPreferences(),
        googleBrowserDeadline: .seconds(2),
        openGoogleBrowser: googleCallback)
      let signIn = Task { await account.signInGoogle() }
      await transport.waitUntilBlocked()
      if cancel { account.cancelSignIn() } else { await account.logout() }
      await transport.release()
      await signIn.value
      let requests = await transport.recorded()
      try require(
        !account.signedIn && vault.credential == nil && requests.count == 1
          && account.failure == (cancel ? .cancelled : .sessionChanged),
        "A late exchanged token must not resurrect logout or cancellation, contact Firebase or persist credentials"
      )
    }
  }
  @MainActor static func googleCompletionFenceChecks() async throws {
    for blockedPhase in [1, 2] {
      for cancel in [false, true] {
        let replies = [
          DesktopJSON.object(["google_id_token": .string(String(repeating: "g", count: 40))]),
          try credentials(), profile,
        ]
        let transport = FixtureTransport(
          replies: replies.enumerated().map {
            .init(
              value: $0.element, status: 200, pause: $0.offset == blockedPhase, cancellable: cancel)
          })
        let vault = MemoryVault()
        let account = DesktopAccountModel(
          configuration: configuration(), vault: vault, transport: transport,
          installationId: installation, preferences: testPreferences(),
          googleBrowserDeadline: .seconds(2), openGoogleBrowser: googleCallback)
        let signIn = Task { await account.signInGoogle() }
        await transport.waitUntilBlocked()
        try require(
          !account.signedIn && vault.saves == 0 && account.googleSignInActive,
          "Google credentials must remain staged and cancellable throughout Firebase and backend bootstrap"
        )
        if cancel {
          account.cancelSignIn()
          for _ in 0..<100 where account.busy { try await Task.sleep(for: .milliseconds(2)) }
          try require(
            !account.busy,
            "Cancel must clear busy without receiving a withheld Firebase/backend response")
        } else {
          await account.logout()
          await transport.release()
        }
        await signIn.value
        let requests = await transport.recorded()
        try require(
          !account.signedIn && !account.online && vault.credential == nil && vault.saves == 0
            && requests.count == blockedPhase + 1
            && account.failure == (cancel ? .cancelled : .sessionChanged),
          "A cancelled or owner-stale Firebase/backend completion must never accept or persist staged credentials"
        )
      }
    }
  }
  @MainActor static func googleReauthenticationFenceChecks() async throws {
    for cancel in [false, true] {
      let vault = MemoryVault()
      let original = try token()
      let googleUser = DesktopUser(
        id: "000000000000000000000042", displayName: "Fixture", email: "fixture@example.invalid",
        emailVerified: true, providers: ["google.com"])
      let googleProfile = DesktopJSON.object([
        "user": try JSONDecoder().decode(DesktopJSON.self, from: JSONEncoder().encode(googleUser)),
        "access": .object(["allowed": .bool(true)]),
      ])
      vault.credential = DesktopCredential(
        firebaseUid: uid, idToken: original, refreshToken: String(repeating: "r", count: 30),
        expiresAt: Date().addingTimeInterval(3600), user: googleUser)
      let transport = FixtureTransport(replies: [
        .init(value: googleProfile, status: 200, pause: false),
        .init(
          value: .object(["google_id_token": .string(String(repeating: "g", count: 40))]),
          status: 200, pause: false),
        .init(value: try credentials(), status: 200, pause: true),
      ])
      let account = DesktopAccountModel(
        configuration: configuration(), vault: vault, transport: transport,
        installationId: installation, preferences: testPreferences(),
        googleBrowserDeadline: .seconds(2), openGoogleBrowser: googleCallback)
      await account.restore()
      let before = vault.saves
      let reauth = Task { try await account.reauthenticate(password: "") }
      await transport.waitUntilBlocked()
      if cancel { account.cancelSignIn() } else { await account.logout() }
      await transport.release()
      do {
        try await reauth.value
        throw DesktopTestFailure.failed("Cancelled Google reauthentication succeeded")
      } catch let failure as DesktopAuthFailure {
        try require(
          failure == (cancel ? .cancelled : .sessionChanged) && vault.saves == before
            && vault.credential?.idToken == (cancel ? original : nil),
          "Cancellation may retain the existing owner credential but must never persist a new reauthentication credential"
        )
      }
    }
  }
  @MainActor static func boundedTransportChecks() async throws {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [StreamingFixtureProtocol.self]
    let transport = DesktopURLSessionTransport(configuration: config)
    let cases: [(String, StreamingFixtureStore.Reply, Int)] = [
      ("/small", .init(chunks: [Data("fixture".utf8)], contentLength: 7), 7),
      (
        "/auth/desktop-google-token-exchanges",
        .init(chunks: Array(repeating: Data(repeating: 65, count: 8192), count: 40)), 32_768
      ),
      (
        "/global", .init(chunks: Array(repeating: Data(repeating: 65, count: 65_536), count: 48)),
        2 * 1024 * 1024
      ),
      (
        "/auth/desktop-google-token-exchanges",
        .init(
          chunks: Array(repeating: Data(repeating: 65, count: 8192), count: 8),
          contentLength: 65_536), 0
      ),
    ]
    for (path, reply, expectedLimit) in cases {
      let id = StreamingFixtureProtocol.store.insert(reply)
      var request = URLRequest(url: URL(string: "https://streaming-fixture.invalid" + path)!)
      request.setValue(id, forHTTPHeaderField: "X-Fixture-Id")
      do {
        let (data, status) = try await transport.send(request)
        try require(
          path == "/small" && data == Data("fixture".utf8) && status == 200,
          "Only bounded successful fixture responses may complete")
      } catch let failure as DesktopAuthFailure {
        try require(
          path != "/small" && failure == .malformedResponse,
          "Oversized declared and streamed responses must fail with a redacted fixed error")
      }
      for _ in 0..<50 where !StreamingFixtureProtocol.store.snapshot(id).1 {
        try await Task.sleep(for: .milliseconds(2))
      }
      let observed = StreamingFixtureProtocol.store.snapshot(id)
      let total = reply.chunks.reduce(0) { $0 + $1.count }
      if path != "/small" {
        try require(
          observed.1 && observed.0 < total && observed.0 <= expectedLimit + 65_536,
          "The underlying download must stop near the limit: \(path), \(observed.0)/\(total), stopped=\(observed.1)"
        )
      }
    }
    let id = StreamingFixtureProtocol.store.insert(.init(chunks: [], hold: true))
    var request = URLRequest(url: URL(string: "https://streaming-fixture.invalid/cancel")!)
    request.setValue(id, forHTTPHeaderField: "X-Fixture-Id")
    let send = Task { try await transport.send(request) }
    try await Task.sleep(for: .milliseconds(20))
    send.cancel()
    do {
      _ = try await send.value
      throw DesktopTestFailure.failed("Cancelled transport request completed")
    } catch let failure as DesktopAuthFailure {
      try require(
        failure == .cancelled, "Task cancellation must remain distinct from network failure")
    }
  }
  @MainActor static func validationChecks() throws {
    try configuration().validate()
    let valid = try token()
    let wrongProject = try token(project: "different-project")
    try require(
      DesktopAccountModel.belongsToProject(valid, project: project, uid: uid),
      "Correct Firebase project identity")
    try require(
      !DesktopAccountModel.belongsToProject(wrongProject, project: project, uid: uid),
      "Wrong project must be rejected")
    let code = try DesktopGoogleOAuth.callback(
      "/oauth2callback?code=fixture-code&state=fixture-state", state: "fixture-state")
    try require(code == "fixture-code", "Valid OAuth response must return code")
    for target in [
      "/oauth2callback?code=fixture-code&state=wrong",
      "/oauth2callback?code=a&code=b&state=fixture-state",
      "https://evil.invalid/oauth2callback?code=a&state=fixture-state",
      "/other?code=a&state=fixture-state",
    ] {
      do {
        _ = try DesktopGoogleOAuth.callback(target, state: "fixture-state")
        throw DesktopTestFailure.failed("Unsafe OAuth callback accepted")
      } catch is DesktopAuthFailure {}
    }
    let random = try DesktopGoogleOAuth.random()
    try require(random.count == 43, "PKCE verifier must have 256 bits and native minimum length")
    let credential = DesktopAccountModel.googleCredentialBody("fixture+google&token")
    try require(
      credential["requestUri"].string == "http://localhost"
        && credential["returnSecureToken"].bool == true,
      "Manual Firebase IdP credential must use its documented logical URI, independent of the Google callback"
    )
    let fields = URLComponents(string: "?" + (credential["postBody"].string ?? ""))?.queryItems
    try require(
      fields?.first(where: { $0.name == "id_token" })?.value == "fixture+google&token"
        && fields?.first(where: { $0.name == "providerId" })?.value == "google.com",
      "Google credential must be form-encoded without query injection")
    try require(
      credential["idToken"] == .null,
      "Google sign-in must not implicitly link an existing Firebase identity")
    let linked = DesktopAccountModel.googleCredentialBody(
      "fixture-google-token", linking: "fixture-firebase-token")
    try require(
      linked["idToken"].string == "fixture-firebase-token",
      "Explicit linking must retain the existing Firebase account identity")
    for origin in [
      "http://api.example.invalid", "https://user:password@api.example.invalid",
      "https://api.example.invalid/private",
    ] {
      let config = DesktopPublicConfiguration(
        backendBaseURL: origin, firebaseAPIKey: String(repeating: "A", count: 39),
        firebaseProjectID: project, googleDesktopClientID: nil)
      do {
        try config.validate()
        throw DesktopTestFailure.failed("Unsafe account origin accepted")
      } catch is DesktopAuthFailure {}
    }
  }
  @MainActor static func cachePinChecks() throws {
    let support = FileManager.default.temporaryDirectory.appendingPathComponent(
      "musicmute-cache-pin-\(UUID())")
    defer { try? FileManager.default.removeItem(at: support) }
    try FileManager.default.createDirectory(
      at: support.appendingPathComponent("cache"), withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    let key = String(repeating: "a", count: 64)
    let pin = try DesktopPlaybackPin.create(cacheKey: key, support: support)
    let json = try JSONDecoder().decode(DesktopJSON.self, from: Data(contentsOf: pin))
    try require(
      json["version"].number == 1 && json["cache_key"].string == key
        && json["pid"].number == Double(ProcessInfo.processInfo.processIdentifier),
      "Playback pin must bind exact cache key to live Mac PID")
    let attributes = try FileManager.default.attributesOfItem(atPath: pin.path)
    try require(
      (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600,
      "Playback pin must be private")
    let second = try DesktopPlaybackPin.create(cacheKey: key, support: support)
    try require(
      second != pin && FileManager.default.fileExists(atPath: pin.path)
        && FileManager.default.fileExists(atPath: second.path),
      "Consecutive playback pins must reuse the verified private directory without removing active pins"
    )
    let directory = support.appendingPathComponent("cache/pins")
    let directoryAttributes = try FileManager.default.attributesOfItem(atPath: directory.path)
    try require(
      (directoryAttributes[.posixPermissions] as? NSNumber)?.intValue == 0o700,
      "Reusing a playback-pin directory must preserve its private permissions")
    func newSupport(_ name: String) throws -> URL {
      let path = support.appendingPathComponent(name)
      try FileManager.default.createDirectory(
        at: path.appendingPathComponent("cache"), withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700])
      return path
    }
    func mustReject(_ path: URL) throws {
      do {
        _ = try DesktopPlaybackPin.create(cacheKey: key, support: path)
        throw DesktopTestFailure.failed("Unsafe playback-pin directory accepted")
      } catch let failure as DesktopAuthFailure {
        try require(failure.code == "CACHE_PIN_UNAVAILABLE", "Unsafe pin storage must fail safely")
      }
    }
    let exposed = try newSupport("exposed")
    let exposedPins = exposed.appendingPathComponent("cache/pins")
    try FileManager.default.createDirectory(
      at: exposedPins, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o777])
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o777], ofItemAtPath: exposedPins.path)
    try mustReject(exposed)
    let after = try FileManager.default.attributesOfItem(atPath: exposedPins.path)
    try require(
      (after[.posixPermissions] as? NSNumber)?.intValue == 0o777,
      "Unsafe existing storage must be refused rather than repaired or modified")
    let outside = support.appendingPathComponent("outside")
    try FileManager.default.createDirectory(
      at: outside, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    let linked = try newSupport("linked")
    try FileManager.default.createSymbolicLink(
      at: linked.appendingPathComponent("cache/pins"), withDestinationURL: outside)
    try mustReject(linked)
    let outsideFiles = try FileManager.default.contentsOfDirectory(atPath: outside.path)
    try require(
      outsideFiles.isEmpty,
      "A symlink destination must not receive playback evidence")
    let regular = try newSupport("regular")
    try Data("fixture".utf8).write(to: regular.appendingPathComponent("cache/pins"))
    try mustReject(regular)
    let raced = try newSupport("raced")
    let racedPin = try DesktopPlaybackPin.createForTesting(cacheKey: key, support: raced) {
      try FileManager.default.createDirectory(
        at: raced.appendingPathComponent("cache/pins"), withIntermediateDirectories: false,
        attributes: [.posixPermissions: 0o700])
    }
    try require(
      FileManager.default.fileExists(atPath: racedPin.path),
      "An EEXIST creation race must reuse the directory only after verifying it")
    let racedLink = try newSupport("raced-link")
    do {
      _ = try DesktopPlaybackPin.createForTesting(cacheKey: key, support: racedLink) {
        try FileManager.default.createSymbolicLink(
          at: racedLink.appendingPathComponent("cache/pins"), withDestinationURL: outside)
      }
      throw DesktopTestFailure.failed("Unsafe EEXIST directory race accepted")
    } catch let failure as DesktopAuthFailure {
      try require(failure.code == "CACHE_PIN_UNAVAILABLE", "EEXIST must not bypass private checks")
    }
    do {
      _ = try DesktopPlaybackPin.create(cacheKey: "../../escape", support: support)
      throw DesktopTestFailure.failed("Invalid cache key accepted")
    } catch is DesktopAuthFailure {}
  }
  @MainActor static func cachePlaybackLeaseChecks() async throws {
    let support = FileManager.default.temporaryDirectory.appendingPathComponent(
      "musicmute-playback-lease-\(UUID())")
    defer { try? FileManager.default.removeItem(at: support) }
    let key = String(repeating: "a", count: 64)
    let entry = support.appendingPathComponent("cache/vocals/\(key)")
    let audio = entry.appendingPathComponent("vocals.mp3")
    let data = Data("bounded-owned-audio-fixture".utf8)
    let checksum = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    func prepare() throws -> DesktopTrack {
      try FileManager.default.createDirectory(
        at: entry, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      try data.write(to: audio)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: audio.path)
      let manifest = try JSONEncoder().encode(
        DesktopJSON.object([
          "output_path": .string(audio.path), "bytes": .number(Double(data.count)),
          "sha256": .string(checksum), "duration_seconds": .number(3),
        ]))
      let metadata = entry.appendingPathComponent("result.json")
      try manifest.write(to: metadata)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: metadata.path)
      return DesktopTrack(
        id: key, title: "Fixture", duration: 3, path: audio, jobId: nil,
        bytes: Int64(data.count), sourceVideoId: nil)
    }
    let track = try prepare()
    let old = Date(timeIntervalSince1970: 100)
    try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: entry.path)
    let pinGate = PlaybackFixtureGate()
    let playback = Task.detached {
      try DesktopPlaybackPin.protectForTesting(track: track, support: support) {
        try pinGate.hold()
      }
    }
    try await pinGate.waitUntilHeld()
    let lock = support.appendingPathComponent("cache/.mutation.lock")
    let locked = try JSONDecoder().decode(DesktopJSON.self, from: Data(contentsOf: lock))
    try require(
      locked["version"].number == 1 && locked["pid"].number == Double(getpid())
        && UUID(uuidString: locked["nonce"].string ?? "") != nil,
      "Native playback must use the companion's existing cache mutation lease")
    do {
      try DesktopPlaybackPin.withMutationForTesting(support: support) {
        throw DesktopTestFailure.failed("Prune entered a held playback lease")
      }
      throw DesktopTestFailure.failed("A concurrent pruner bypassed the playback lease")
    } catch let failure as DesktopAuthFailure {
      try require(
        failure.code == "LOCAL_COMPANION_BUSY", "Prune must wait for atomic pin publication")
    }
    pinGate.release.signal()
    let pin = try await playback.value
    let modified =
      try FileManager.default.attributesOfItem(atPath: entry.path)[.modificationDate]
      as? Date
    try require(
      (modified?.timeIntervalSince(old) ?? 0) > 1,
      "Library playback must refresh the same hash-directory mtime used by the companion LRU")
    try DesktopPlaybackPin.withMutationForTesting(support: support) {
      let pins = try FileManager.default.contentsOfDirectory(
        at: support.appendingPathComponent("cache/pins"), includingPropertiesForKeys: nil)
      let pinned = try pins.contains { path in
        try JSONDecoder().decode(DesktopJSON.self, from: Data(contentsOf: path))["cache_key"].string
          == key
      }
      if !pinned { try FileManager.default.removeItem(at: entry) }
    }
    let preservedAudio = try Data(contentsOf: audio)
    try require(
      FileManager.default.fileExists(atPath: audio.path) && preservedAudio == data,
      "A pruner after publication must observe the pin and preserve exact voice bytes")
    try FileManager.default.removeItem(at: pin)
    let pruneGate = PlaybackFixtureGate()
    let prune = Task.detached {
      try DesktopPlaybackPin.withMutationForTesting(support: support) {
        try pruneGate.hold()
        try FileManager.default.removeItem(at: entry)
      }
    }
    try await pruneGate.waitUntilHeld()
    let latePlayback = Task {
      try await DesktopPlaybackPin.protect(track: track, support: support, owner: nil)
    }
    try await Task.sleep(for: .milliseconds(100))
    pruneGate.release.signal()
    try await prune.value
    do {
      _ = try await latePlayback.value
      throw DesktopTestFailure.failed("Playback published a pin for an evicted voice")
    } catch let failure as DesktopAuthFailure {
      try require(failure.code == "CACHE_PIN_UNAVAILABLE", "An evicted voice must fail safely")
    }
    let remaining = try FileManager.default.contentsOfDirectory(
      atPath: support.appendingPathComponent("cache/pins").path)
    try require(
      remaining.isEmpty && !FileManager.default.fileExists(atPath: entry.path)
        && !FileManager.default.fileExists(atPath: lock.path),
      "A prune that wins the lease must not leave a pin, resurrect media or leak the lock")
    _ = try prepare()
    let cancelGate = PlaybackFixtureGate()
    let holder = Task.detached {
      try DesktopPlaybackPin.withMutationForTesting(support: support) { try cancelGate.hold() }
    }
    try await cancelGate.waitUntilHeld()
    let cancelled = Task {
      try await DesktopPlaybackPin.protect(track: track, support: support, owner: nil)
    }
    try await Task.sleep(for: .milliseconds(100))
    cancelled.cancel()
    do {
      _ = try await cancelled.value
      throw DesktopTestFailure.failed("Cancelled playback acquired a delayed pin")
    } catch is CancellationError {}
    cancelGate.release.signal()
    try await holder.value
    let afterCancellation = try FileManager.default.contentsOfDirectory(
      atPath: support.appendingPathComponent("cache/pins").path)
    try require(
      afterCancellation.isEmpty,
      "Cancelled lease waiting must not leave playback protection")
    let account = DesktopAccountModel(
      configuration: configuration(), vault: MemoryVault(), transport: FixtureTransport([]),
      installationId: installation, preferences: testPreferences())
    let workspace = DesktopWorkspace(account: account, resources: nil, playbackSupport: support)
    for logout in [false, true] {
      let stopGate = PlaybackFixtureGate()
      let stopHolder = Task.detached {
        try DesktopPlaybackPin.withMutationForTesting(support: support) { try stopGate.hold() }
      }
      try await stopGate.waitUntilHeld()
      let delayedPlay = Task { await workspace.play(track) }
      try await Task.sleep(for: .milliseconds(100))
      if logout { await account.logout() } else { workspace.stop() }
      stopGate.release.signal()
      try await stopHolder.value
      let started = await delayedPlay.value
      let stalePins = try FileManager.default.contentsOfDirectory(
        atPath: support.appendingPathComponent("cache/pins").path)
      try require(
        !started && workspace.currentTrack == nil && !workspace.playing && stalePins.isEmpty,
        "Stop and logout during native lease acquisition must fence delayed playback and release its pin"
      )
    }
    let corrupted = Data(repeating: 120, count: data.count)
    try corrupted.write(to: audio)
    do {
      _ = try DesktopPlaybackPin.protectForTesting(track: track, support: support)
      throw DesktopTestFailure.failed("Corrupt cached audio was pinned for playback")
    } catch let failure as DesktopAuthFailure {
      try require(failure.code == "CACHE_PIN_UNAVAILABLE", "Corrupt audio must fail safely")
    }
    let stillCorrupted = try Data(contentsOf: audio)
    try require(
      stillCorrupted == corrupted && !FileManager.default.fileExists(atPath: lock.path),
      "Failed validation must preserve audio and release only its owned lease")
    _ = try prepare()
    func mustRefuse() async throws {
      do {
        _ = try await DesktopPlaybackPin.protect(track: track, support: support, owner: nil)
        throw DesktopTestFailure.failed("Unsafe playback state accepted")
      } catch let failure as DesktopAuthFailure {
        try require(
          failure.code == "CACHE_PIN_UNAVAILABLE", "Unsafe playback state must fail safely")
      }
    }
    let metadata = entry.appendingPathComponent("result.json")
    let baseManifest = try Data(contentsOf: metadata)
    guard
      case .object(let baseFields) = try JSONDecoder().decode(
        DesktopJSON.self, from: baseManifest)
    else { throw DesktopTestFailure.failed("Fixture metadata must be an object") }
    for malformedOwner: DesktopJSON in [
      .number(42), .object([:]), .array([]), .string(""),
      .string(String(repeating: "a", count: 129)), .string("owner\u{0001}"),
    ] {
      var fields = baseFields
      fields["owner_uid"] = malformedOwner
      try JSONEncoder().encode(DesktopJSON.object(fields)).write(to: metadata)
      try await mustRefuse()
    }
    let video = "jNQXAC9IVRw"
    let publicTrack = DesktopTrack(
      id: track.id, title: track.title, duration: track.duration, path: track.path, jobId: nil,
      bytes: track.bytes, sourceVideoId: video)
    var publicFields = baseFields
    publicFields["owner_uid"] = .string("another-owner")
    publicFields["source"] = .object(["kind": .string("youtube"), "video_id": .string(video)])
    for privateJob: DesktopJSON in [.number(42), .object([:]), .array([]), .string("private-job")] {
      publicFields["account_job_id"] = privateJob
      try JSONEncoder().encode(DesktopJSON.object(publicFields)).write(to: metadata)
      do {
        _ = try await DesktopPlaybackPin.protect(track: publicTrack, support: support, owner: nil)
        throw DesktopTestFailure.failed("Malformed private-account marker was treated as absent")
      } catch let failure as DesktopAuthFailure {
        try require(
          failure.code == "CACHE_PIN_UNAVAILABLE",
          "Foreign private-account manifests must be fenced")
      }
    }
    publicFields["account_job_id"] = .null
    try JSONEncoder().encode(DesktopJSON.object(publicFields)).write(to: metadata)
    let publicPin = try await DesktopPlaybackPin.protect(
      track: publicTrack, support: support, owner: nil)
    try FileManager.default.removeItem(at: publicPin)
    let invalidVideo = "invalid-video"
    publicFields["source"] = .object([
      "kind": .string("youtube"), "video_id": .string(invalidVideo),
    ])
    try JSONEncoder().encode(DesktopJSON.object(publicFields)).write(to: metadata)
    let invalidVideoTrack = DesktopTrack(
      id: track.id, title: track.title, duration: track.duration, path: track.path, jobId: nil,
      bytes: track.bytes, sourceVideoId: invalidVideo)
    do {
      _ = try await DesktopPlaybackPin.protect(
        track: invalidVideoTrack, support: support, owner: nil)
      throw DesktopTestFailure.failed("Invalid YouTube identity bypassed the foreign-owner fence")
    } catch let failure as DesktopAuthFailure {
      try require(
        failure.code == "CACHE_PIN_UNAVAILABLE", "Foreign public reuse needs a valid video ID")
    }
    try baseManifest.write(to: metadata)
    let malformedLock = Data("{invalid-private-lock".utf8)
    try malformedLock.write(to: lock)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: lock.path)
    try await mustRefuse()
    let unchangedLock = try Data(contentsOf: lock)
    try require(
      unchangedLock == malformedLock, "Foreign or malformed lease state must be preserved")
    try FileManager.default.removeItem(at: lock)
    let outside = support.appendingPathComponent("outside.mp3")
    try data.write(to: outside)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: outside.path)
    try FileManager.default.removeItem(at: audio)
    try FileManager.default.createSymbolicLink(at: audio, withDestinationURL: outside)
    try await mustRefuse()
    try FileManager.default.removeItem(at: audio)
    try FileManager.default.linkItem(at: outside, to: audio)
    try await mustRefuse()
    try FileManager.default.removeItem(at: audio)
    _ = try prepare()
    try FileManager.default.setAttributes([.posixPermissions: 0o666], ofItemAtPath: audio.path)
    try await mustRefuse()
    let outsideBytes = try Data(contentsOf: outside)
    let refusedPins = try FileManager.default.contentsOfDirectory(
      atPath: support.appendingPathComponent("cache/pins").path)
    try require(
      outsideBytes == data && refusedPins.isEmpty
        && !FileManager.default.fileExists(atPath: lock.path),
      "Unsafe linked or exposed media must never create a pin, change outside bytes or retain its lease"
    )
  }
  @MainActor static func playbackVolumeChecks() throws {
    var state = DesktopPlaybackVolume(
      level: .nan, muted: false, lastAudibleLevel: .infinity)
    try require(
      state.level == 1 && !state.muted && state.lastAudibleLevel == 1,
      "Invalid playback volume preferences must use safe audible defaults")

    state.setLevel(0.42)
    state.toggleMute()
    try require(
      state.level == 0.42 && state.muted && state.lastAudibleLevel == 0.42,
      "Mute must preserve the selected audible level")
    state.toggleMute()
    try require(
      state.level == 0.42 && !state.muted,
      "Unmute must restore playback without changing the slider level")
    state.setLevel(0)
    state.toggleMute()
    try require(
      state.level == 0.42 && !state.muted,
      "Unmuting a zero-volume player must restore its last audible level")
    state.adjust(by: 2)
    try require(state.level == 1, "Volume increases must clamp at 100 percent")
    state.adjust(by: -2)
    try require(
      state.level == 0 && state.muted,
      "Volume decreases must clamp at zero and expose a muted state")
    let unchanged = state
    state.setLevel(.nan)
    state.adjust(by: .infinity)
    try require(state == unchanged, "Nonfinite volume updates must be ignored")

    let defaults = testPreferences()
    defaults.set(4.0, forKey: DesktopPreferenceKey.playbackVolume)
    defaults.set(false, forKey: DesktopPreferenceKey.playbackMuted)
    defaults.set(-1.0, forKey: DesktopPreferenceKey.playbackLastAudibleVolume)
    let account = DesktopAccountModel(
      configuration: configuration(), vault: MemoryVault(), transport: FixtureTransport([]),
      installationId: installation, preferences: testPreferences())
    let workspace = DesktopWorkspace(
      account: account, resources: nil, preferences: defaults)
    try require(
      workspace.volume == 1 && !workspace.muted,
      "Persisted playback volume must be normalized before use")

    defaults.set(false, forKey: DesktopPreferenceKey.playbackVolume)
    defaults.set("muted", forKey: DesktopPreferenceKey.playbackMuted)
    defaults.set(true, forKey: DesktopPreferenceKey.playbackLastAudibleVolume)
    let typeCorrupt = DesktopWorkspace(
      account: account, resources: nil, preferences: defaults)
    try require(
      typeCorrupt.volume == 1 && !typeCorrupt.muted,
      "Boolean and string playback preferences must not bridge into numeric or mute state")

    workspace.setVolume(0.37)
    workspace.toggleMute()
    let candidate = AVPlayer()
    DesktopWorkspace.applyPlaybackVolume(workspace.playbackVolume, to: candidate)
    try require(
      abs(Double(candidate.volume) - 0.37) < 0.001 && candidate.isMuted,
      "Replacement players must inherit the selected volume and mute state")
    workspace.stop()
    try require(
      workspace.volume == 0.37 && workspace.muted,
      "Stopping playback must preserve the user's volume preference")
    let restored = DesktopWorkspace(
      account: account, resources: nil, preferences: defaults)
    try require(
      restored.volume == 0.37 && restored.muted,
      "Playback volume and mute state must survive relaunch")
    restored.toggleMute()
    try require(
      restored.volume == 0.37 && !restored.muted,
      "A restored muted player must unmute at its saved level")
    restored.setVolume(0)
    let restoredFromZero = DesktopWorkspace(
      account: account, resources: nil, preferences: defaults)
    try require(
      restoredFromZero.volume == 0 && restoredFromZero.muted,
      "A zero-volume player must relaunch silently")
    restoredFromZero.toggleMute()
    try require(
      restoredFromZero.volume == 0.37 && !restoredFromZero.muted,
      "Unmuting after a zero-volume relaunch must restore the last audible level")

    let previewDefaults = testPreferences()
    previewDefaults.set(0.8, forKey: DesktopPreferenceKey.playbackVolume)
    previewDefaults.set(false, forKey: DesktopPreferenceKey.playbackMuted)
    previewDefaults.set(0.8, forKey: DesktopPreferenceKey.playbackLastAudibleVolume)
    let previewAccount = DesktopAccountModel(
      configuration: configuration(), vault: MemoryVault(), transport: FixtureTransport([]),
      installationId: installation, preferences: testPreferences())
    let previewWorkspace = DesktopWorkspace(
      account: previewAccount, resources: nil, preferences: previewDefaults)
    var workspacePublishes = 0
    var volumePublishes = 0
    var cancellables = Set<AnyCancellable>()
    previewWorkspace.objectWillChange.sink { workspacePublishes += 1 }.store(in: &cancellables)
    previewWorkspace.playbackVolumeState.$value.sink { _ in volumePublishes += 1 }.store(
      in: &cancellables)

    previewWorkspace.previewVolume(0.25)
    try require(
      previewWorkspace.volume == 0.25 && !previewWorkspace.muted && volumePublishes == 2,
      "Volume previews must publish through lightweight playback volume state")
    try require(
      previewDefaults.double(forKey: DesktopPreferenceKey.playbackVolume) == 0.8
        && !previewDefaults.bool(forKey: DesktopPreferenceKey.playbackMuted)
        && previewDefaults.double(forKey: DesktopPreferenceKey.playbackLastAudibleVolume) == 0.8,
      "Volume previews must not write preferences while the slider is moving")

    previewWorkspace.previewVolume(0.25)
    try require(
      volumePublishes == 2,
      "An unchanged volume preview must not republish playback state")
    previewWorkspace.commitPlaybackVolume()
    try require(
      previewDefaults.double(forKey: DesktopPreferenceKey.playbackVolume) == 0.25
        && !previewDefaults.bool(forKey: DesktopPreferenceKey.playbackMuted)
        && previewDefaults.double(forKey: DesktopPreferenceKey.playbackLastAudibleVolume) == 0.25,
      "Committing a volume preview must persist its normalized playback state")

    previewWorkspace.toggleMute()
    try require(
      previewWorkspace.muted && volumePublishes == 3
        && previewDefaults.bool(forKey: DesktopPreferenceKey.playbackMuted),
      "Committed volume controls must keep publishing and persisting child state")
    try require(
      workspacePublishes == 0,
      "Volume preview, commit and mute changes must not invalidate the full workspace")
    withExtendedLifetime(cancellables) {}
  }

  @MainActor static func playbackJournalChecks() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "musicmute-playback-journal-\(UUID())")
    defer { try? FileManager.default.removeItem(at: root) }
    let journal = UIJournal(logsRoot: root)
    let transport = FixtureTransport(replies: [
      .init(
        value: .object(["error": .object(["message": .string("INVALID_LOGIN_CREDENTIALS")])]),
        status: 400, pause: false)
    ])
    let account = DesktopAccountModel(
      configuration: configuration(), vault: MemoryVault(), transport: transport,
      installationId: installation, preferences: testPreferences(), journal: journal)
    let workspace = DesktopWorkspace(account: account, resources: nil, journal: journal)
    let missing = DesktopTrack(
      id: String(repeating: "a", count: 64), title: "private-fixture-title", duration: 10,
      path: nil, jobId: nil, bytes: 0, sourceVideoId: nil)
    let started = await workspace.play(missing)
    try require(
      !started && !workspace.playing && workspace.currentTrack == missing
        && workspace.playbackPreparation == .failed(.startFailed),
      "A failed playback attempt must retain the selected voice and a retryable error")
    workspace.notice = "This voice is saved to your account."
    workspace.recordPlaybackFailure(.cachePinUnavailable)
    try require(
      workspace.notice == nil
        && workspace.failure == DesktopPlaybackFailure.cachePinUnavailable.message,
      "A pin failure must clear playback success notices and show a safe explanation")
    workspace.recordPlaybackFailure(.audioFailed)
    await account.signIn(
      email: "private-fixture@example.invalid", password: "private-fixture-password")
    if let timeoutCode = DesktopAuthFailure.service("GOOGLE_SIGN_IN_TIMEOUT").signInJournalCode {
      journal.record(.appOperationError, code: timeoutCode)
    }
    try require(
      DesktopAuthFailure.cancelled.signInJournalCode == nil,
      "Explicit user cancellation must not be recorded as an authentication error")
    journal.flushForTesting()
    let data = try Data(contentsOf: root.appendingPathComponent("ui-events.jsonl"))
    let text = String(decoding: data, as: UTF8.self)
    let codes = try text.split(separator: "\n").map { line in
      try JSONDecoder().decode(DesktopJSON.self, from: Data(line.utf8))["code"].string
    }
    try require(
      codes == [
        "DESKTOP_PLAYBACK_START_FAILED", "CACHE_PIN_UNAVAILABLE", "DESKTOP_AUDIO_PLAYBACK_FAILED",
        "AUTH_SIGN_IN_FAILED", "GOOGLE_SIGN_IN_TIMEOUT",
      ],
      "The shared local journal must retain distinct safe playback and authentication failure codes"
    )
    try require(
      !text.contains("private-fixture") && !text.contains("INVALID_LOGIN_CREDENTIALS")
        && !text.contains("SIGN_IN_CANCELLED") && !text.contains(root.path),
      "Playback/authentication diagnostics must exclude titles, paths, email, passwords and raw service errors"
    )
  }
  @MainActor static func playbackPreparationChecks() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "musicmute-playback-preparation-\(UUID())")
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    let audioURL = root.appendingPathComponent("fixture.wav")
    let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 48_000)!
    buffer.frameLength = 48_000
    do {
      let audio = try AVAudioFile(forWriting: audioURL, settings: format.settings)
      try audio.write(from: buffer)
    }
    let grant = DesktopJSON.object([
      "url": .string("https://media.example.invalid/synthetic-output")
    ])
    let first = DesktopTrack(
      id: "000000000000000000000041", title: "First fixture", duration: 3,
      path: nil, jobId: "000000000000000000000041", bytes: 0, sourceVideoId: nil)
    let second = DesktopTrack(
      id: "000000000000000000000042", title: "Second fixture", duration: 3,
      path: nil, jobId: "000000000000000000000042", bytes: 0, sourceVideoId: nil)
    let missingLocal = DesktopTrack(
      id: first.id, title: first.title, duration: first.duration,
      path: root.appendingPathComponent("cache/missing.mp3"), jobId: first.jobId,
      bytes: 0, sourceVideoId: nil)
    func signedInAccount(_ transport: FixtureTransport) async throws -> DesktopAccountModel {
      let account = DesktopAccountModel(
        configuration: configuration(), vault: MemoryVault(), transport: transport,
        installationId: installation, preferences: testPreferences())
      await account.signIn(email: "fixture@example.invalid", password: "fixture-password")
      try require(account.signedIn, "Playback fixtures must use an authenticated synthetic owner")
      return account
    }

    for (logout, selected) in [(false, first), (false, missingLocal), (true, first)] {
      let transport = FixtureTransport(replies: [
        .init(value: try credentials(), status: 200, pause: false),
        .init(value: profile, status: 200, pause: false),
        .init(value: grant, status: 200, pause: true),
      ])
      let account = try await signedInAccount(transport)
      var assetLoads = 0
      let workspace = DesktopWorkspace(
        account: account, resources: nil, playbackSupport: root, preferences: testPreferences(),
        playbackAssetLoader: { _ in
          assetLoads += 1
          return AVURLAsset(url: audioURL)
        })
      workspace.setVolume(0)
      let pending = Task { await workspace.play(selected) }
      await transport.waitUntilBlocked()
      try require(
        workspace.currentTrack == selected && workspace.playbackPreparation == .downloading
          && workspace.preparingPlayback && !workspace.canControlPlayback
          && !workspace.playing && workspace.duration == first.duration,
        "Remote voices and missing cached files must show the player downloading before its grant completes"
      )
      workspace.seek(1)
      workspace.togglePlayback()
      try require(
        workspace.position == 0 && !workspace.playing,
        "Pending playback must not accept seeks or claim that it is playing")
      if logout { await account.logout() } else { workspace.stop() }
      try require(
        workspace.currentTrack == nil && workspace.playbackPreparation == nil,
        "Stop and logout must dismiss a pending player immediately")
      await transport.release()
      let started = await pending.value
      try require(
        !started && assetLoads == 0 && workspace.currentTrack == nil && !workspace.playing,
        "A late grant after Stop or logout must never load or start its old audio")
      workspace.shutdown()
    }

    let transport = FixtureTransport(replies: [
      .init(value: try credentials(), status: 200, pause: false),
      .init(value: profile, status: 200, pause: false),
      .init(value: grant, status: 200, pause: true),
      .init(value: grant, status: 200, pause: false),
    ])
    let account = try await signedInAccount(transport)
    let workspace = DesktopWorkspace(
      account: account, resources: nil, preferences: testPreferences(),
      playbackAssetLoader: { _ in AVURLAsset(url: audioURL) })
    workspace.setVolume(0)
    let staleSelection = Task { await workspace.play(first) }
    await transport.waitUntilBlocked()
    let replacementStarted = await workspace.play(second)
    try require(
      replacementStarted && workspace.currentTrack == second && workspace.playing,
      "A newer selected voice must replace and automatically start after preparation")
    await transport.release()
    let staleStarted = await staleSelection.value
    try require(
      !staleStarted && workspace.currentTrack == second && workspace.playing
        && workspace.failure == nil,
      "A late older selection must not replace, pause or fail the current player")
    workspace.shutdown()

    let assetTransport = FixtureTransport([try credentials(), profile, grant])
    let assetAccount = try await signedInAccount(assetTransport)
    let gate = PlaybackAssetFixtureGate(url: audioURL)
    let assetWorkspace = DesktopWorkspace(
      account: assetAccount, resources: nil, preferences: testPreferences(),
      playbackAssetLoader: gate.load)
    assetWorkspace.setVolume(0)
    let loading = Task { await assetWorkspace.play(first) }
    await gate.waitUntilBlocked()
    try require(
      assetWorkspace.currentTrack == first && assetWorkspace.playbackPreparation == .downloading,
      "Remote asset preparation must keep the visible download state after obtaining its grant")
    assetWorkspace.stop()
    gate.release()
    let lateAssetStarted = await loading.value
    try require(
      !lateAssetStarted && assetWorkspace.currentTrack == nil && !assetWorkspace.playing,
      "A late asset load must not recreate a player after cancellation")
    assetWorkspace.shutdown()

    let retryTransport = FixtureTransport([
      try credentials(), profile, .object(["url": .string("http://unsafe.example.invalid")]), grant,
    ])
    let retryAccount = try await signedInAccount(retryTransport)
    let retryWorkspace = DesktopWorkspace(
      account: retryAccount, resources: nil, preferences: testPreferences(),
      playbackAssetLoader: { _ in AVURLAsset(url: audioURL) })
    retryWorkspace.setVolume(0)
    let failedStarted = await retryWorkspace.play(first)
    try require(
      !failedStarted && retryWorkspace.currentTrack == first
        && retryWorkspace.playbackPreparation == .failed(.startFailed)
        && !retryWorkspace.canControlPlayback,
      "A rejected media grant must retain the selected voice with a retryable failure")
    await retryWorkspace.retryPlayback()
    try require(
      retryWorkspace.currentTrack == first && retryWorkspace.playing
        && retryWorkspace.failure == nil,
      "Retry must prepare and automatically play the retained selected voice")
    retryWorkspace.shutdown()
  }
  @MainActor static func comparisonChecks() throws {
    let untrimmed = DesktopJSON.object(["trim_enabled": .bool(false)])
    let unchanged = try DesktopComparison.position(12.5, toOriginal: true, job: untrimmed)
    try require(unchanged == 12.5, "Timeline-preserving vocals must keep original video position")
    let trimmed = DesktopJSON.object([
      "trim_enabled": .bool(true),
      "comparison_ranges": .array([
        .array([.number(44_100), .number(88_200)]), .array([.number(176_400), .number(264_600)]),
      ]),
    ])
    let original = try DesktopComparison.position(1.5, toOriginal: true, job: trimmed)
    let voice = try DesktopComparison.position(4.5, toOriginal: false, job: trimmed)
    try require(
      original == 4.5 && voice == 1.5, "Trimmed account tracks must map comparison clocks")
    do {
      _ = try DesktopComparison.position(
        1, toOriginal: true, job: .object(["trim_enabled": .bool(true)]))
      throw DesktopTestFailure.failed("Unmapped trimmed comparison accepted")
    } catch is DesktopAuthFailure {}
  }
  @MainActor static func accountStateChecks() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "musicmute-account-state-\(UUID())")
    defer { try? FileManager.default.removeItem(at: root) }
    let store = DesktopAccountStateStore(support: root)
    let scope = DesktopSessionScope(firebaseUid: uid, generation: UUID())
    try store.publish(scope)
    let path = root.appendingPathComponent("account-state.json")
    let value = try JSONDecoder().decode(DesktopJSON.self, from: Data(contentsOf: path))
    guard case .object(let fields) = value else {
      throw DesktopTestFailure.failed("Account scope not an object")
    }
    try require(
      Set(fields.keys) == ["version", "firebase_uid", "session_generation"],
      "Account marker must contain only credential-free ownership")
    try require(
      value["firebase_uid"].string == uid
        && value["session_generation"].string == scope.generation.uuidString.lowercased(),
      "Scope marker binds exact owner generation")
    let permissions = try FileManager.default.attributesOfItem(atPath: path.path)
    try require(
      (permissions[.posixPermissions] as? NSNumber)?.intValue == 0o600,
      "Scope marker must be private")
    try store.publish(nil)
    let loggedOut = try JSONDecoder().decode(DesktopJSON.self, from: Data(contentsOf: path))
    try require(
      loggedOut["firebase_uid"] == .null && loggedOut["session_generation"] == .null,
      "Logout must revoke marker without credentials")
  }
  @MainActor static func outboxWatcherChecks() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "musicmute-outbox-watch-\(UUID())")
    defer { try? FileManager.default.removeItem(at: root) }
    var callbacks = 0
    let watcher = DesktopOutboxWatcher(root: root, uid: uid) { callbacks += 1 }
    defer { watcher.stop() }
    try watcher.start()
    let request = UUID().uuidString.lowercased()
    let directory = root.appendingPathComponent(String(repeating: "a", count: 64))
      .appendingPathComponent(request)
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    func record(_ state: String) throws {
      let data = try JSONEncoder().encode(
        DesktopJSON.object([
          "version": .number(1), "owner": .object(["uid": .string(uid)]),
          "request_id": .string(request), "state": .string(state),
        ]))
      try data.write(to: directory.appendingPathComponent("record.json"), options: .atomic)
    }
    try record("pending")
    for _ in 0..<100 where callbacks == 0 { try await Task.sleep(for: .milliseconds(10)) }
    try require(
      callbacks == 1, "A new private pending receipt must trigger one debounced sync event")
    try record("uploading")
    try await Task.sleep(for: .milliseconds(400))
    try record("failed")
    try await Task.sleep(for: .milliseconds(400))
    try require(callbacks == 1, "Own upload/failure writes must not create an automatic retry loop")
    let captureRoot = root.appendingPathComponent("sync-captures")
    var captureCallbacks = 0
    let captures = DesktopOutboxWatcher(root: captureRoot, uid: uid) { captureCallbacks += 1 }
    defer { captures.stop() }
    try captures.start()
    let captureID = UUID().uuidString.lowercased()
    let captureDirectory = captureRoot.appendingPathComponent(String(repeating: "b", count: 64))
      .appendingPathComponent(captureID)
    try FileManager.default.createDirectory(
      at: captureDirectory, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    func capture(_ state: String, owner: String = uid) throws {
      let data = try JSONEncoder().encode(
        DesktopJSON.object([
          "version": .number(1), "owner": .object(["uid": .string(owner)]),
          "request_id": .string(captureID), "state": .string(state),
        ]))
      try data.write(to: captureDirectory.appendingPathComponent("record.json"), options: .atomic)
    }
    try capture("pending", owner: "another-fixture-owner")
    try await Task.sleep(for: .milliseconds(400))
    try require(
      captureCallbacks == 0, "A capture receipt belonging to another account must not trigger sync")
    try capture("pending")
    for _ in 0..<100 where captureCallbacks == 0 { try await Task.sleep(for: .milliseconds(10)) }
    try require(
      captureCallbacks == 1,
      "The independent capture queue must wake an authorized sync on new pending receipt")
    for state in ["capturing", "deferred", "rejected"] {
      try capture(state)
      try await Task.sleep(for: .milliseconds(400))
    }
    try require(captureCallbacks == 1, "Capture/deferred/rejected writes must not cause retry spin")
    captures.stop()
    try capture("pending")
    try await Task.sleep(for: .milliseconds(400))
    try require(
      captureCallbacks == 1, "Stopped account watcher must ignore queued or later filesystem events"
    )
    try captures.start()
    try require(
      captureCallbacks == 2,
      "Restarting account watchers must recover an existing same-owner pending capture")
    let restoreRoot = root.appendingPathComponent("cache-restores")
    var restoreCallbacks = 0
    let restores = DesktopOutboxWatcher(root: restoreRoot, uid: uid) { restoreCallbacks += 1 }
    defer { restores.stop() }
    try restores.start()
    let restoreID = UUID().uuidString.lowercased()
    let restoreDirectory = restoreRoot.appendingPathComponent(String(repeating: "c", count: 64))
      .appendingPathComponent(restoreID)
    try FileManager.default.createDirectory(
      at: restoreDirectory, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    func restore(_ state: String, owner: String = uid) throws {
      let data = try JSONEncoder().encode(
        DesktopJSON.object([
          "version": .number(1), "owner": .object(["uid": .string(owner)]),
          "request_id": .string(restoreID), "state": .string(state),
        ]))
      try data.write(to: restoreDirectory.appendingPathComponent("record.json"), options: .atomic)
    }
    try restore("pending", owner: "another-fixture-owner")
    try await Task.sleep(for: .milliseconds(400))
    try require(
      restoreCallbacks == 0, "Foreign restore tickets must not wake account authorization")
    try restore("pending")
    for _ in 0..<100 where restoreCallbacks == 0 { try await Task.sleep(for: .milliseconds(10)) }
    try require(
      restoreCallbacks == 1,
      "A new restore ticket must wake one account-authorized native operation")
    for state in ["restoring", "ready", "missing", "deferred", "cancelled"] {
      try restore(state)
      try await Task.sleep(for: .milliseconds(400))
    }
    try require(
      restoreCallbacks == 1, "Restore receipts and failures must not cause automatic network retry")
    restores.stop()
    try restore("pending")
    try await Task.sleep(for: .milliseconds(400))
    try require(restoreCallbacks == 1, "Retired account restore watchers must stay stopped")
  }
  @MainActor static func syncNoticeChecks() throws {
    let legacy = DesktopWorkspace.resultNotice(cacheHit: true, syncState: "unavailable")
    try require(
      legacy.contains("unavailable") && !legacy.contains("saved"),
      "Unavailable legacy original must never be announced as saved to the account")
    let capture = DesktopWorkspace.resultNotice(cacheHit: true, syncState: "pending")
    try require(
      capture.contains("without processing again") && capture.contains("pending"),
      "Cached vocals must play immediately while acquisition-only account saving remains pending")
    let key = String(repeating: "a", count: 64)
    let operation = UUID()
    let track = DesktopTrack(
      id: key, title: "Fixture voice", duration: 10, path: nil, jobId: nil, bytes: 0,
      sourceVideoId: nil, operationId: operation, syncState: "pending")
    func receipt(
      _ state: String, cacheKey: String? = key, requestID: UUID = UUID(), jobId: String? = nil
    ) -> DesktopJSON {
      var fields: [String: DesktopJSON] = [
        "state": .string(state), "request_id": .string(requestID.uuidString),
        "error_code": .string("ORIGINAL_SOURCE_MISMATCH"),
      ]
      if let cacheKey { fields["cache_key"] = .string(cacheKey) }
      if let jobId { fields["job_id"] = .string(jobId) }
      return .object(fields)
    }
    let unrelated = receipt("ready", cacheKey: String(repeating: "b", count: 64))
    try require(
      DesktopWorkspace.saveReceiptOutcome(for: track, items: [unrelated]) == nil,
      "Another upload cannot announce the currently playing cached voice as saved")
    let rejected = DesktopWorkspace.saveReceiptOutcome(for: track, items: [receipt("rejected")])
    try require(
      rejected?.state == "unavailable" && rejected?.notice.contains("unavailable") == true
        && rejected?.notice.contains("ORIGINAL_SOURCE_MISMATCH") == false,
      "Rejected original capture must show unavailable without exposing internal failure codes")
    let deferred = DesktopWorkspace.saveReceiptOutcome(for: track, items: [receipt("deferred")])
    try require(
      deferred?.state == "pending" && deferred?.notice.contains("pending") == true,
      "A deferred original capture remains pending while playback continues")
    let uploaded = DesktopWorkspace.saveReceiptOutcome(for: track, items: [receipt("ready")])
    try require(
      uploaded?.state == "ready" && uploaded?.notice == "This voice is saved to your account.",
      "Only the matching authoritative upload receipt can confirm the voice was saved")
    let linkedJob = "0123456789abcdef01234567"
    try require(
      DesktopWorkspace.saveReceiptOutcome(
        for: track, items: [receipt("ready", jobId: linkedJob)])?.jobId == linkedJob,
      "A matching ready community receipt must attach its validated account job immediately")
    try require(
      DesktopWorkspace.saveReceiptOutcome(
        for: track, items: [receipt("ready", jobId: "not-a-job")])?.jobId == nil,
      "Malformed receipt job IDs must never unlock cloud actions")
    try require(
      DesktopWorkspace.saveReceiptOutcome(
        for: track, items: [receipt("committed", cacheKey: nil, requestID: operation)])?.state
        == "ready",
      "Original local pair receipts may match their captured operation ID")
    try require(
      DesktopWorkspace.saveReceiptOutcome(
        for: track,
        items: [
          receipt("committed", cacheKey: String(repeating: "b", count: 64), requestID: operation)
        ]
      ) == nil,
      "An explicit different cache key cannot be overridden by a receipt operation ID")
    try require(
      DesktopWorkspace.saveReceiptOutcome(for: track, items: [receipt("unknown")]) == nil,
      "Unknown receipt states cannot imply successful saving")
    let moreCaptures: DesktopJSON = .object(["capture_more_pending": .bool(true)])
    var remaining = 31
    var commands = 1
    while let next = DesktopWorkspace.captureFollowUpBudget(moreCaptures, remaining: remaining) {
      commands += 1
      remaining = next
    }
    try require(commands == 32, "Capture backlog draining must be bounded to 32 commands")
    let moreRestores: DesktopJSON = .object(["cache_restore_more_pending": .bool(true)])
    try require(
      DesktopWorkspace.captureFollowUpBudget(moreRestores, remaining: 31) == 30,
      "New pending restore tickets must share the bounded event-driven continuation")
    try require(
      DesktopWorkspace.captureFollowUpBudget(moreRestores, remaining: 0) == nil,
      "Restore continuation must stop at the shared attempt budget")
    try require(
      DesktopWorkspace.captureFollowUpBudget(
        .object(["capture_more_pending": .bool(false), "pending_count": .number(10)]),
        remaining: 31) == nil,
      "Deferred captures or ordinary pending uploads must not trigger a timer-free retry spin")
  }
  @MainActor static func libraryTitleChecks() throws {
    let jobID = "0123456789abcdef01234567"
    let track = DesktopTrack(
      id: String(repeating: "a", count: 64), title: "Saved voice", duration: 245,
      path: URL(fileURLWithPath: "/fixture/vocals.mp3"), jobId: jobID, bytes: 1234,
      sourceVideoId: "jNQXAC9IVRw", operationId: UUID(), trimEnabled: false,
      sourceDuration: 245, syncState: "ready")
    func job(display: DesktopJSON, source: DesktopJSON) -> DesktopJSON {
      .object([
        "id": .string(jobID), "status": .string("ready"), "display_name": display,
        "source_title": source,
      ])
    }
    let sourceTitle = "عنوان الفيديو من YouTube"
    let sourceRows = DesktopWorkspace.libraryTracks(
      localTracks: [track], cloudJobs: [job(display: .null, source: .string(sourceTitle))])
    var expected = track
    expected.title = sourceTitle
    try require(
      sourceRows == [expected],
      "Linked offline rows must show the YouTube source title once and preserve all playback and save metadata"
    )
    let renamed = DesktopWorkspace.libraryTracks(
      localTracks: [track],
      cloudJobs: [job(display: .string("My name"), source: .string(sourceTitle))])
    expected.title = "My name"
    try require(renamed == [expected], "An explicit account rename must take precedence")
    let blank = DesktopWorkspace.libraryTracks(
      localTracks: [track], cloudJobs: [job(display: .string(" \n"), source: .string(sourceTitle))])
    expected.title = sourceTitle
    try require(blank == [expected], "Blank display names must fall back to the YouTube title")
    let missing = DesktopWorkspace.libraryTracks(
      localTracks: [track], cloudJobs: [job(display: .null, source: .string(" \t"))])
    try require(
      missing == [track], "Missing account titles must preserve the existing offline title")
    let unlinked = DesktopTrack(
      id: "unlinked", title: "Local name", duration: 3, path: nil, jobId: nil, bytes: 0,
      sourceVideoId: nil)
    let malformed: DesktopJSON = .object(["display_name": .string("Unrelated")])
    try require(
      DesktopWorkspace.libraryTracks(localTracks: [unlinked], cloudJobs: [malformed]) == [unlinked],
      "Title repair must never match an unlinked track to a missing job ID")
    try require(
      DesktopWorkspace.trackTitle("\u{0000}Title\n", fallback: "Saved voice") == "Title",
      "Display titles must omit control characters")
    var older = track
    older.updatedAt = Date(timeIntervalSince1970: 100)
    var newer = unlinked
    newer.updatedAt = Date(timeIntervalSince1970: 200)
    try require(
      DesktopWorkspace.newestTracks([older, newer]) == [newer, older],
      "Newest Library sorting must merge local and account voices by their actual update time")
    let capableJob: DesktopJSON = .object([
      "id": .string(jobID), "status": .string("ready"), "can_download_input": .bool(true),
      "trim_enabled": .bool(false),
      "input": .object(["duration_seconds": .number(245)]),
    ])
    let capable = DesktopWorkspace.libraryTracks(localTracks: [track], cloudJobs: [capableJob])[0]
    try require(
      capable.originalAvailable && capable.sourceDuration == 245,
      "Original playback must use the backend input capability instead of job existence alone")
    var stale = track
    stale.jobId = nil
    let reconciled = DesktopWorkspace.reconciledTrack(stale, candidates: [capable])
    try require(
      reconciled.jobId == jobID && reconciled.originalAvailable,
      "A refreshed Library row must backfill delayed cloud linkage into the active track")
  }
  static func silenceChecks() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "musicmute-silence-\(UUID())")
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    let file = root.appendingPathComponent("fixture.wav")
    let sampleRate = 16_000.0
    guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1),
      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 48_000),
      let samples = buffer.floatChannelData?[0]
    else { throw DesktopTestFailure.failed("PCM fixture unavailable") }
    buffer.frameLength = 48_000
    for index in 0..<48_000 {
      samples[index] =
        index >= 16_000 && index < 32_000
        ? Float(sin(Double(index) * 2 * .pi * 440 / sampleRate) * 0.2) : 0
    }
    do {
      let audio = try AVAudioFile(forWriting: file, settings: format.settings)
      try audio.write(from: buffer)
    }
    let ranges = try DesktopSilenceAnalysis.ranges(url: file)
    try require(
      ranges.count == 2, "Silence analysis must preserve the audible middle of a recording")
    try require(
      ranges[0].start >= 0.05 && ranges[0].end < 1.1 && ranges[1].start > 1.9 && ranges[1].end < 3,
      "Silence skips must leave safe audio edges and valid timestamps")
    let linked = root.appendingPathComponent("linked")
    try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: root)
    do {
      try DesktopPrivateDirectory.prepare(linked)
      throw DesktopTestFailure.failed("Private directory symlink accepted")
    } catch is DesktopAuthFailure {}
  }
  static func updateLockCreationChecks() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "musicmute-update-lock-race-\(UUID())", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(
      at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])

    for index in 0..<64 {
      let support = root.appendingPathComponent("Support-\(index)", isDirectory: true)
      try FileManager.default.createDirectory(
        at: support, withIntermediateDirectories: false,
        attributes: [.posixPermissions: 0o700])
      let canonicalSupport = canonicalDesktopTestDirectory(support)
      let start = DesktopUpdateLockStartGate()
      var tasks = (0..<4).map { _ in
        Task.detached(priority: .userInitiated) {
          start.waitSynchronously()
          return try RuntimeUpdateExecutionTestLease(support: support)
        }
      }
      start.release(tasks.count)
      var leases = [RuntimeUpdateExecutionTestLease]()
      for task in tasks { leases.append(try await task.value) }
      try require(
        leases.count == 4,
        "Every simultaneous first opener must retain a shared app-update lease")
      do {
        let unexpectedExclusive = try DesktopUpdateInstallationLease(support: canonicalSupport)
        withExtendedLifetime(unexpectedExclusive) {}
        throw DesktopTestFailure.failed(
          "An exclusive app update acquired the concurrently shared lock")
      } catch DesktopUpdateGateFailure.busy {}
      tasks.removeAll()
      leases.removeAll()
      var exclusiveAfterRelease = try? DesktopUpdateInstallationLease(support: canonicalSupport)
      try require(
        exclusiveAfterRelease != nil,
        "The app-update lock must remain reusable after concurrent shared leases release")
      exclusiveAfterRelease = nil
    }
  }
  @MainActor static func runtimeExecutionGateChecks() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "musicmute-desktop-runtime-gate-\(UUID())", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let resources = root.appendingPathComponent("MusicMute.app/Contents/Resources")
    let support = root.appendingPathComponent("Support", isDirectory: true)
    let runtimeID = "macos-arm64-desktop-fixture"
    let release = support.appendingPathComponent(
      "runtime/releases/\(runtimeID)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: resources.appendingPathComponent("companion"), withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    try FileManager.default.createDirectory(
      at: release, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o700], ofItemAtPath: support.path)

    let marker = root.appendingPathComponent("desktop-runtime-executed")
    let escapedMarker = marker.path.replacingOccurrences(of: "'", with: "'\\''")
    let holdDesktopChild = root.appendingPathComponent("hold-desktop-runtime")
    let desktopChildEntered = root.appendingPathComponent("desktop-runtime-waiting")
    let releaseDesktopChild = root.appendingPathComponent("release-desktop-runtime")
    let ignoreDesktopTermination = root.appendingPathComponent("ignore-desktop-termination")
    let ignoringDesktopChildEntered = root.appendingPathComponent(
      "ignoring-desktop-runtime-waiting")
    let escapedHoldDesktopChild = holdDesktopChild.path.replacingOccurrences(
      of: "'", with: "'\\''")
    let escapedDesktopChildEntered = desktopChildEntered.path.replacingOccurrences(
      of: "'", with: "'\\''")
    let escapedReleaseDesktopChild = releaseDesktopChild.path.replacingOccurrences(
      of: "'", with: "'\\''")
    let escapedIgnoreDesktopTermination = ignoreDesktopTermination.path.replacingOccurrences(
      of: "'", with: "'\\''")
    let escapedIgnoringDesktopChildEntered =
      ignoringDesktopChildEntered.path.replacingOccurrences(of: "'", with: "'\\''")
    let node = Data(
      #"""
      #!/bin/sh
      /usr/bin/touch '\#(escapedMarker)'
      if [ -f '\#(escapedIgnoreDesktopTermination)' ]; then
        trap '' TERM
        /usr/bin/touch '\#(escapedIgnoringDesktopChildEntered)'
        while :; do /bin/sleep 0.01; done
      fi
      if [ -f '\#(escapedHoldDesktopChild)' ]; then
        /usr/bin/touch '\#(escapedDesktopChildEntered)'
        while [ ! -f '\#(escapedReleaseDesktopChild)' ]; do /bin/sleep 0.01; done
      fi
      IFS= read -r envelope
      id=$(printf '%s' "$envelope" | /usr/bin/sed -nE 's/.*"request_id":"([^"]+)".*/\1/p')
      printf '{"protocol_version":1,"request_id":"%s","type":"result","payload":{"ready":true}}\n' "$id"
      """#.utf8)
    let entries: [(String, Data, Bool, Bool)] = [
      ("runtime/runtime/node/bin/node", node, true, true),
      ("runtime/runtime/python/bin/python3", Data("python".utf8), true, true),
      ("runtime/runtime/bin/ffmpeg", Data("ffmpeg".utf8), true, true),
      ("runtime/runtime/bin/ffprobe", Data("ffprobe".utf8), true, true),
      ("runtime/tools/youtube/bin/deno", Data("deno".utf8), true, true),
      ("runtime/runtime/python/lib/noncritical.dat", Data("noncritical".utf8), false, false),
    ]
    var files = [[String: Any]]()
    var installedBytes: Int64 = 0
    for (path, bytes, executable, signed) in entries {
      let file = release.appendingPathComponent(path)
      try FileManager.default.createDirectory(
        at: file.deletingLastPathComponent(), withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700])
      try bytes.write(to: file)
      try FileManager.default.setAttributes(
        [.posixPermissions: executable ? 0o500 : 0o400], ofItemAtPath: file.path)
      installedBytes += Int64(bytes.count)
      files.append([
        "path": path, "type": "file", "bytes": bytes.count,
        "sha256": RuntimeDigest.data(bytes), "executable": executable,
        "code_signed": signed,
      ])
    }
    let manifest = try JSONSerialization.data(
      withJSONObject: [
        "schema_version": 1,
        "runtime": [
          "id": runtimeID, "api_version": 1, "platform": "darwin", "arch": "arm64",
          "url": "https://downloads.example.com/runtime.zip", "archive_format": "zip",
          "archive_sha256": String(repeating: "a", count: 64), "archive_bytes": 512,
          "installed_bytes": installedBytes, "download_hosts": ["downloads.example.com"],
          "signing": ["mode": "ad_hoc"], "files": files,
        ],
      ], options: [.sortedKeys])
    try manifest.write(to: resources.appendingPathComponent("runtime-bootstrap.json"))
    try Data("fixture desktop control".utf8).write(
      to: resources.appendingPathComponent("companion/desktop-control.js"))
    let decoded = try RuntimeBootstrapDocument.decodeValidated(manifest)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    var active = try encoder.encode(RuntimeActiveDocument(runtime: decoded.runtime))
    active.append(10)
    try RuntimeFileSecurity.atomicWrite(
      active, to: support.appendingPathComponent("runtime/active.json"))
    let bootstrapLock = support.appendingPathComponent("runtime/bootstrap.lock")
    try Data().write(to: bootstrapLock)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o600], ofItemAtPath: bootstrapLock.path)

    let dedupChecker = DesktopRuntimeSignatureChecker()
    let dedupCoordinator = RuntimeVerificationCoordinator()
    var concurrent = (0..<4).map { _ in
      Task.detached(priority: .userInitiated) {
        try verifiedDesktopRuntime(
          "deduplicated", coordinator: dedupCoordinator, resources: resources, support: support,
          signatureChecker: dedupChecker)
      }
    }
    for task in concurrent {
      var resolved = try await task.value
      try require(
        resolved?.runtimeRoot.path
          == RuntimePath.canonicalExisting(release.appendingPathComponent("runtime")),
        "Concurrent runtime callers must resolve the same verified release")
      resolved = nil
    }
    let dedupSnapshot = dedupChecker.snapshot()
    var dedupTaskResultsRetainedLease = false
    do {
      let unexpectedLease = try DesktopUpdateInstallationLease(
        support: canonicalDesktopTestDirectory(support))
      withExtendedLifetime(unexpectedLease) {}
    } catch DesktopUpdateGateFailure.busy {
      dedupTaskResultsRetainedLease = true
    }
    concurrent.removeAll()
    var dedupUpdateLeaseAfter = try? DesktopUpdateInstallationLease(
      support: canonicalDesktopTestDirectory(support))
    try require(
      dedupCoordinator.verificationRunCount == 1 && dedupSnapshot.outer == 4
        && dedupTaskResultsRetainedLease && dedupUpdateLeaseAfter != nil,
      "Concurrent GUI starts must share one full verification and release task-result leases explicitly"
    )
    dedupUpdateLeaseAfter = nil

    let multiKeyChecker = DesktopRuntimeSignatureChecker(
      verificationPolicyIdentifier: "more-than-eight-key-waiters")
    let multiKeyCoordinator = RuntimeVerificationCoordinator()
    var multiKeySupports = [URL]()
    for index in 0..<10 {
      let variant = root.appendingPathComponent("Support-\(index)", isDirectory: true)
      try FileManager.default.copyItem(at: support, to: variant)
      multiKeySupports.append(variant)
    }
    var multiKeyTasks = multiKeySupports.flatMap { variant in
      (0..<3).map { _ in
        (
          variant,
          Task.detached(priority: .userInitiated) {
            try verifiedDesktopRuntime(
              "multi-key-\(variant.lastPathComponent)", coordinator: multiKeyCoordinator,
              resources: resources, support: variant, signatureChecker: multiKeyChecker)
          }
        )
      }
    }
    for (variant, task) in multiKeyTasks {
      var resolved = try await task.value
      try require(
        resolved?.runtimeRoot.path
          == RuntimePath.canonicalExisting(
            variant.appendingPathComponent(
              "runtime/releases/\(runtimeID)/runtime", isDirectory: true)),
        "Every waiter must receive its own verified runtime candidate")
      resolved = nil
    }
    try require(
      multiKeyCoordinator.verificationRunCount == multiKeySupports.count,
      "More than eight concurrent keys must not evict waiters into duplicate full verification")
    multiKeyTasks.removeAll()

    let leaseSupport = root.appendingPathComponent("LeaseSupport", isDirectory: true)
    try FileManager.default.copyItem(at: support, to: leaseSupport)
    let leaseRelease = leaseSupport.appendingPathComponent(
      "runtime/releases/\(runtimeID)", isDirectory: true)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o500], ofItemAtPath: leaseRelease.path)
    let leaseStaging = leaseSupport.appendingPathComponent("runtime/staging", isDirectory: true)
    try FileManager.default.createDirectory(
      at: leaseStaging, withIntermediateDirectories: false,
      attributes: [.posixPermissions: 0o700])
    let leaseChecker = DesktopRuntimeSignatureChecker(
      verificationPolicyIdentifier: "runtime-prune-lease")
    var heldRuntime = try verifiedDesktopRuntime(
      "prune-lease", coordinator: RuntimeVerificationCoordinator(), resources: resources,
      support: leaseSupport, signatureChecker: leaseChecker)
    try require(
      heldRuntime?.runtimeRoot.path
        == RuntimePath.canonicalExisting(leaseRelease.appendingPathComponent("runtime")),
      "The prune-race fixture must retain a verified installed runtime")
    do {
      _ = try RuntimeFileLock(
        path: leaseSupport.appendingPathComponent("runtime/bootstrap.lock"), mode: .exclusive)
      throw DesktopTestFailure.failed("A pruner acquired the setup lock during runtime launch use")
    } catch RuntimeBootstrapFailure.code("RUNTIME_SETUP_BUSY") {}
    try require(
      FileManager.default.fileExists(atPath: leaseRelease.path),
      "A retained execution lease must keep the verified release available to launch")
    heldRuntime = nil
    do {
      let maintenanceLock = try RuntimeFileLock(
        path: leaseSupport.appendingPathComponent("runtime/bootstrap.lock"), mode: .exclusive)
      try RuntimeStorageMaintenance.pruneReleases(
        releases: leaseSupport.appendingPathComponent("runtime/releases", isDirectory: true),
        staging: leaseStaging, currentID: "replacement-fixture", previousID: nil)
      _ = maintenanceLock
    }
    try require(
      !FileManager.default.fileExists(atPath: leaseRelease.path),
      "Pruning may isolate the old release only after every execution lease is released")

    try? FileManager.default.removeItem(at: marker)
    let overlapSupport = root.appendingPathComponent("OverlapSupport", isDirectory: true)
    try FileManager.default.copyItem(at: support, to: overlapSupport)
    let overlapChecker = BlockingDesktopRuntimeSignatureChecker(
      support: overlapSupport,
      verificationPolicyIdentifier: "desktop-overlapping-verification")
    let overlapCoordinator = RuntimeVerificationCoordinator()
    let overlapBridge = DesktopBridge(
      resources: resources, support: overlapSupport, signatureChecker: overlapChecker,
      verificationCoordinator: overlapCoordinator)
    try Data().write(to: holdDesktopChild)
    let firstOverlappingRequest = Task { @MainActor in
      try await overlapBridge.request(
        type: "LIBRARY_CACHE", payload: .object([:]), session: nil)
    }
    for _ in 0..<500 {
      if FileManager.default.fileExists(atPath: desktopChildEntered.path) { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    let overlapReachedVerification = FileManager.default.fileExists(atPath: desktopChildEntered.path)
    try require(
      overlapReachedVerification,
      "The first Desktop request must reach the held child without verification")
    let overlapBusyDuringVerification = overlapBridge.busy
    var overlappingFailure: DesktopAuthFailure?
    do {
      _ = try await overlapBridge.request(
        type: "LIBRARY_CACHE", payload: .object([:]), session: nil)
    } catch let failure as DesktopAuthFailure {
      overlappingFailure = failure
    }
    try Data().write(to: releaseDesktopChild)
    let firstOverlappingReply = try await firstOverlappingRequest.value
    let overlapSnapshot = overlapChecker.snapshot()
    var overlapUpdateLeaseAfter = try? DesktopUpdateInstallationLease(
      support: canonicalDesktopTestDirectory(overlapSupport))
    try require(
      overlapBusyDuringVerification && overlappingFailure?.code == "APP_OPERATION_BUSY"
        && firstOverlappingReply["ready"].bool == true
        && FileManager.default.fileExists(atPath: marker.path)
        && !overlapBridge.busy && overlapCoordinator.verificationRunCount == 0
        && overlapSnapshot.outer == 0
        && overlapUpdateLeaseAfter != nil,
      "Overlapping Desktop requests must stay fenced while the installed runtime executes")
    overlapUpdateLeaseAfter = nil
    try FileManager.default.removeItem(at: holdDesktopChild)
    try FileManager.default.removeItem(at: desktopChildEntered)
    try FileManager.default.removeItem(at: releaseDesktopChild)
    try FileManager.default.removeItem(at: marker)

    let cancellationSupport = root.appendingPathComponent(
      "CancellationSupport", isDirectory: true)
    try FileManager.default.copyItem(at: support, to: cancellationSupport)
    let cancellationChecker = BlockingDesktopRuntimeSignatureChecker(
      support: cancellationSupport,
      verificationPolicyIdentifier: "desktop-cancelled-verification")
    let cancellationCoordinator = RuntimeVerificationCoordinator()
    let cancellationBridge = DesktopBridge(
      resources: resources, support: cancellationSupport,
      signatureChecker: cancellationChecker,
      verificationCoordinator: cancellationCoordinator)
    try Data().write(to: holdDesktopChild)
    let cancelledRequest = Task { @MainActor in
      try await cancellationBridge.request(
        type: "LIBRARY_CACHE", payload: .object([:]), session: nil)
    }
    for _ in 0..<500 {
      if FileManager.default.fileExists(atPath: desktopChildEntered.path) { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    let cancellationReachedVerification = FileManager.default.fileExists(atPath: desktopChildEntered.path)
    try require(
      cancellationReachedVerification,
      "The cancelled Desktop request must reach its child without verification")
    let cancellationBusyDuringVerification = cancellationBridge.busy
    cancellationBridge.cancel()
    var cancellationFailure: DesktopAuthFailure?
    do {
      _ = try await cancelledRequest.value
    } catch let failure as DesktopAuthFailure {
      cancellationFailure = failure
    }
    let cancellationSnapshot = cancellationChecker.snapshot()
    var cancellationUpdateLeaseAfter = try? DesktopUpdateInstallationLease(
      support: canonicalDesktopTestDirectory(cancellationSupport))
    try require(
      cancellationBusyDuringVerification && cancellationFailure == .cancelled
        && FileManager.default.fileExists(atPath: marker.path)
        && !cancellationBridge.busy && cancellationCoordinator.verificationRunCount == 0
        && cancellationSnapshot.outer == 0
        && cancellationUpdateLeaseAfter != nil,
      "Cancelling execution must release both gates without performing an audit")
    cancellationUpdateLeaseAfter = nil
    try FileManager.default.removeItem(at: holdDesktopChild)
    try FileManager.default.removeItem(at: desktopChildEntered)
    let recoveredCancellationReply = try await cancellationBridge.request(
      type: "LIBRARY_CACHE", payload: .object([:]), session: nil)
    try require(
      recoveredCancellationReply["ready"].bool == true
        && FileManager.default.fileExists(atPath: marker.path) && !cancellationBridge.busy,
      "A cancelled execution must leave DesktopBridge reusable after cleanup")
    try FileManager.default.removeItem(at: marker)

    let desktopChecker = DesktopRuntimeSignatureChecker()
    let desktopCoordinator = RuntimeVerificationCoordinator()
    let bridge = DesktopBridge(
      resources: resources, support: support, signatureChecker: desktopChecker,
      verificationCoordinator: desktopCoordinator)
    let reply = try await bridge.request(
      type: "LIBRARY_CACHE", payload: .object([:]), session: nil)
    let desktopSnapshot = desktopChecker.snapshot()
    try require(
      reply["ready"].bool == true && FileManager.default.fileExists(atPath: marker.path)
        && desktopCoordinator.verificationRunCount == 0 && desktopSnapshot.outer == 0
        && !desktopSnapshot.main,
      "DesktopBridge must trust installed contents without running verification")

    try FileManager.default.removeItem(at: marker)
    let desktopLifecycleSupport = root.appendingPathComponent(
      "DesktopLifecycleSupport", isDirectory: true)
    try FileManager.default.copyItem(at: support, to: desktopLifecycleSupport)
    let desktopLifecycleLock = desktopLifecycleSupport.appendingPathComponent(
      "runtime/bootstrap.lock")
    let lifecycleBridge = DesktopBridge(
      resources: resources, support: desktopLifecycleSupport,
      signatureChecker: DesktopRuntimeSignatureChecker(
        verificationPolicyIdentifier: "desktop-child-lifetime"),
      verificationCoordinator: RuntimeVerificationCoordinator())
    try Data().write(to: holdDesktopChild)
    let heldRequest = Task { @MainActor in
      try await lifecycleBridge.request(
        type: "LIBRARY_CACHE", payload: .object([:]), session: nil)
    }
    for _ in 0..<500 {
      if FileManager.default.fileExists(atPath: desktopChildEntered.path) { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    let desktopChildReachedWait = FileManager.default.fileExists(
      atPath: desktopChildEntered.path)
    var desktopLeaseBlockedPruning = false
    var desktopUpdateLeaseBlocked = false
    if desktopChildReachedWait {
      do {
        let unexpectedLock = try RuntimeFileLock(
          path: desktopLifecycleLock, mode: .exclusive)
        _ = unexpectedLock
      } catch RuntimeBootstrapFailure.code("RUNTIME_SETUP_BUSY") {
        desktopLeaseBlockedPruning = true
      }
      do {
        let unexpectedUpdateLease = try DesktopUpdateInstallationLease(
          support: canonicalDesktopTestDirectory(desktopLifecycleSupport))
        withExtendedLifetime(unexpectedUpdateLease) {}
      } catch DesktopUpdateGateFailure.busy {
        desktopUpdateLeaseBlocked = true
      } catch {}
    }
    try Data().write(to: releaseDesktopChild)
    let heldReply = try await heldRequest.value
    try? FileManager.default.removeItem(at: holdDesktopChild)
    try? FileManager.default.removeItem(at: desktopChildEntered)
    try? FileManager.default.removeItem(at: releaseDesktopChild)
    var lockAfterDesktopChild = try? RuntimeFileLock(
      path: desktopLifecycleLock, mode: .exclusive)
    var updateLeaseAfterDesktopChild = try? DesktopUpdateInstallationLease(
      support: canonicalDesktopTestDirectory(desktopLifecycleSupport))
    try require(
      desktopChildReachedWait && desktopLeaseBlockedPruning && desktopUpdateLeaseBlocked
        && heldReply["ready"].bool == true && lockAfterDesktopChild != nil
        && updateLeaseAfterDesktopChild != nil,
      "DesktopBridge must retain runtime and update leases through child completion, then release them"
    )
    lockAfterDesktopChild = nil
    updateLeaseAfterDesktopChild = nil
    try FileManager.default.removeItem(at: marker)

    let terminationSupport = root.appendingPathComponent(
      "TerminationSupport", isDirectory: true)
    try FileManager.default.copyItem(at: support, to: terminationSupport)
    let terminationLock = terminationSupport.appendingPathComponent("runtime/bootstrap.lock")
    let terminationBridge = DesktopBridge(
      resources: resources, support: terminationSupport,
      signatureChecker: DesktopRuntimeSignatureChecker(
        verificationPolicyIdentifier: "desktop-child-termination"),
      verificationCoordinator: RuntimeVerificationCoordinator(),
      terminationGrace: .milliseconds(500))
    try Data().write(to: ignoreDesktopTermination)
    let cancelledChildRequest = Task { @MainActor in
      try await terminationBridge.request(
        type: "LIBRARY_CACHE", payload: .object([:]), session: nil)
    }
    for _ in 0..<500 {
      if FileManager.default.fileExists(atPath: ignoringDesktopChildEntered.path) { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    let ignoringChildReachedWait = FileManager.default.fileExists(
      atPath: ignoringDesktopChildEntered.path)
    terminationBridge.cancel()
    try await Task.sleep(for: .milliseconds(75))
    var terminationSetupLeaseHeld = false
    var terminationUpdateLeaseHeld = false
    do {
      let unexpectedLock = try RuntimeFileLock(path: terminationLock, mode: .exclusive)
      _ = unexpectedLock
    } catch RuntimeBootstrapFailure.code("RUNTIME_SETUP_BUSY") {
      terminationSetupLeaseHeld = true
    }
    do {
      let unexpectedUpdateLease = try DesktopUpdateInstallationLease(
        support: canonicalDesktopTestDirectory(terminationSupport))
      withExtendedLifetime(unexpectedUpdateLease) {}
    } catch DesktopUpdateGateFailure.busy {
      terminationUpdateLeaseHeld = true
    }
    var fencedFailure: DesktopAuthFailure?
    do {
      _ = try await terminationBridge.request(
        type: "LIBRARY_CACHE", payload: .object([:]), session: nil)
    } catch let failure as DesktopAuthFailure {
      fencedFailure = failure
    }
    let terminationBusyBeforeExit = terminationBridge.busy
    var cancelledChildFailure: DesktopAuthFailure?
    do {
      _ = try await cancelledChildRequest.value
    } catch let failure as DesktopAuthFailure {
      cancelledChildFailure = failure
    }
    var terminationSetupLeaseAfter = try? RuntimeFileLock(
      path: terminationLock, mode: .exclusive)
    var terminationUpdateLeaseAfter = try? DesktopUpdateInstallationLease(
      support: canonicalDesktopTestDirectory(terminationSupport))
    try require(
      ignoringChildReachedWait && terminationSetupLeaseHeld && terminationUpdateLeaseHeld
        && terminationBusyBeforeExit && fencedFailure?.code == "APP_OPERATION_BUSY"
        && cancelledChildFailure == .cancelled && !terminationBridge.busy
        && terminationSetupLeaseAfter != nil && terminationUpdateLeaseAfter != nil,
      "Cancellation must retain the request and runtime leases until a SIGTERM-ignoring child exits"
    )
    terminationSetupLeaseAfter = nil
    terminationUpdateLeaseAfter = nil
    try? FileManager.default.removeItem(at: ignoreDesktopTermination)
    try? FileManager.default.removeItem(at: ignoringDesktopChildEntered)
    try? FileManager.default.removeItem(at: marker)
    let recoveredTerminationReply = try await terminationBridge.request(
      type: "LIBRARY_CACHE", payload: .object([:]), session: nil)
    try require(
      recoveredTerminationReply["ready"].bool == true
        && FileManager.default.fileExists(atPath: marker.path) && !terminationBridge.busy,
      "DesktopBridge must recover after the cancelled child has actually terminated")
    try FileManager.default.removeItem(at: marker)

    let leaf = release.appendingPathComponent("runtime/runtime/python/lib/noncritical.dat")
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: leaf.path)
    try Data("tampered!!!".utf8).write(to: leaf)
    try FileManager.default.setAttributes([.posixPermissions: 0o400], ofItemAtPath: leaf.path)
    _ = try await bridge.request(type: "LIBRARY_CACHE", payload: .object([:]), session: nil)
    try require(desktopCoordinator.verificationRunCount == 0
      && FileManager.default.fileExists(atPath: marker.path),
      "Normal desktop execution trusts installed contents without an inventory scan")
    do {
      _ = try desktopCoordinator.inspectRuntime(resources: resources, support: support,
        signatureChecker: desktopChecker)
      throw DesktopTestFailure.failed("Explicit inspection accepted changed runtime contents")
    } catch RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID") {}

  }
  @MainActor static func bridgeChecks() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "musicmute-desktop-bridge-\(UUID())")
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(
      at: root.appendingPathComponent("runtime/runtime/node/bin"), withIntermediateDirectories: true
    )
    try FileManager.default.createDirectory(
      at: root.appendingPathComponent("companion"), withIntermediateDirectories: true)
    try Data("fixture".utf8).write(to: root.appendingPathComponent("companion/desktop-control.js"))
    let node = root.appendingPathComponent("runtime/runtime/node/bin/node")
    let prefix = #"""
      #!/bin/sh
      if [ -n "$MUSICMUTE_DESKTOP_TEST_SECRET" ]; then exit 42; fi
      IFS= read -r envelope
      id=$(printf '%s' "$envelope" | /usr/bin/sed -nE 's/.*"request_id":"([^"]+)".*/\1/p')
      """#
    func script(_ tail: String) throws {
      try Data((prefix + "\n" + tail + "\n").utf8).write(to: node)
      try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: node.path)
    }
    let success =
      #"printf '{"protocol_version":1,"request_id":"%s","type":"result","payload":{"ready":true}}\n' "$id""#
    try script(success)
    setenv("MUSICMUTE_DESKTOP_TEST_SECRET", "fixture-never-inherit", 1)
    defer { unsetenv("MUSICMUTE_DESKTOP_TEST_SECRET") }
    let bridge = DesktopBridge(resources: root)
    let reply = try await bridge.request(type: "LIBRARY_CACHE", payload: .object([:]), session: nil)
    try require(
      reply["ready"].bool == true && !bridge.busy,
      "Bounded IPC result must roundtrip with filtered process environment")
    for tail in [
      "printf '%s\\n' '{not-json}'", success + "\n" + success, success + "\nexit 12",
      "/bin/dd if=/dev/zero bs=1024 count=600 2>/dev/null",
      "/usr/bin/head -c 3000000 /dev/zero >&2\n" + success,
    ] {
      try script(tail)
      do {
        _ = try await bridge.request(type: "LIBRARY_CACHE", payload: .object([:]), session: nil)
        throw DesktopTestFailure.failed("Invalid desktop subprocess accepted")
      } catch is DesktopAuthFailure {}
    }
    try script("exec /bin/sleep 30")
    let pending = Task {
      try await bridge.request(type: "LOCAL_START", payload: .object([:]), session: nil)
    }
    while !bridge.busy { await Task.yield() }
    bridge.cancel()
    do {
      _ = try await pending.value
      throw DesktopTestFailure.failed("Cancelled desktop operation succeeded")
    } catch is DesktopAuthFailure {}
    try script(success)
    let retry = try await bridge.request(type: "LIBRARY_CACHE", payload: .object([:]), session: nil)
    try require(
      retry["ready"].bool == true, "Old cancelled reader must never settle a new desktop request")
    try Data("#!/bin/sh\nexec /bin/sleep 30\n".utf8).write(to: node)
    let blocked = Task {
      try await bridge.request(
        type: "LOCAL_START",
        payload: .object(["source_path": .string(String(repeating: "x", count: 60_000))]),
        session: nil)
    }
    while !bridge.busy { await Task.yield() }
    try await Task.sleep(for: .milliseconds(100))
    bridge.cancel()
    do {
      _ = try await blocked.value
      throw DesktopTestFailure.failed("Blocked native stdin ignored cancellation")
    } catch is DesktopAuthFailure {}
  }
}
