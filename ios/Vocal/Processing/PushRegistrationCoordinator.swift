import Combine
import Foundation

struct PushSession: Equatable, Sendable {
  let uid: String
  let epoch: UInt64
  let installationID: String
}

struct PushBinding: Decodable, Equatable, Sendable {
  let installationID: String
  let active: Bool
  let bindingRevision: Int64
  enum CodingKeys: String, CodingKey {
    case installationID = "installationId"
    case active, bindingRevision
  }
}

struct ProcessingJobHint: Equatable, Sendable {
  let jobID: String
  let eventID: String
  let outcome: String
}

func processingJobHint(_ data: [AnyHashable: Any]) -> ProcessingJobHint? {
  guard data["type"] as? String == "audio_job_outcome",
    let job = data["jobId"] as? String,
    job.range(of: "^[a-fA-F0-9]{24}$", options: .regularExpression) != nil,
    let event = data["eventId"] as? String,
    event.range(of: "^[a-zA-Z0-9_:-]{1,128}$", options: .regularExpression) != nil,
    let outcome = data["outcome"] as? String, ["ready", "failed"].contains(outcome)
  else { return nil }
  return ProcessingJobHint(jobID: job.lowercased(), eventID: event, outcome: outcome)
}

@MainActor protocol PushRegistrationAPI {
  func register(installationID: String, token: String) async throws -> PushBinding
  func deactivate(installationID: String, expectedBindingRevision: Int64) async throws
}

@MainActor final class PushRegistrationAPIClient: PushRegistrationAPI {
  private weak var tokenSource: IDTokenSource?
  private let identityUID: @MainActor () -> String?
  private let transport: AuthHTTPTransport

  init(
    configuration: AuthConfiguration, tokenSource: IDTokenSource,
    identityUID: @escaping @MainActor () -> String?,
    sessionConfiguration: URLSessionConfiguration? = nil
  ) {
    self.tokenSource = tokenSource
    self.identityUID = identityUID
    self.transport = AuthHTTPTransport(
      configuration: configuration,
      sessionConfiguration: sessionConfiguration, rejectRedirects: true)
  }

  func register(installationID: String, token: String) async throws -> PushBinding {
    let path = try route(installationID)
    guard validFCMToken(token) else { throw AuthFailure.invalidInput }
    struct Body: Encodable { let token: String }
    let data = try await send(
      "PUT", path, body: JSONEncoder().encode(Body(token: token)), expectedStatus: 200,
      replay401: true)
    guard let binding = try? JSONDecoder().decode(PushBinding.self, from: data), binding.active,
      binding.installationID.lowercased() == installationID.lowercased(),
      (1...9_007_199_254_740_991).contains(binding.bindingRevision)
    else { throw AuthFailure.malformedResponse }
    return binding
  }

  func deactivate(installationID: String, expectedBindingRevision: Int64) async throws {
    guard (1...9_007_199_254_740_991).contains(expectedBindingRevision) else {
      throw AuthFailure.invalidInput
    }
    struct Body: Encodable { let expectedBindingRevision: Int64 }
    _ = try await send(
      "POST", route(installationID) + "/deactivate",
      body: JSONEncoder().encode(Body(expectedBindingRevision: expectedBindingRevision)),
      expectedStatus: 204, replay401: false)
  }

  private func route(_ id: String) throws -> String {
    guard
      id.range(
        of:
          "^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-4[a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$",
        options: .regularExpression) != nil
    else { throw AuthFailure.invalidInput }
    return "/devices/\(id.lowercased())/push"
  }

  private func send(
    _ method: String, _ path: String, body: Data, expectedStatus: Int, replay401: Bool
  ) async throws -> Data {
    guard let tokenSource, let uid = identityUID() else { throw AuthFailure.sessionExpired }
    let session = tokenSource.tokenSession
    func check() throws {
      try Task.checkCancellation()
      guard identityUID() == uid, tokenSource.tokenSession == session else {
        throw CancellationError()
      }
    }
    for attempt in 0...(replay401 ? 1 : 0) {
      try check()
      let token = try await tokenSource.idToken(forceRefresh: attempt == 1)
      try check()
      let (data, response) = try await transport.perform(
        method: method, path: path, body: body, bearer: token)
      try check()
      if response.statusCode == 401, replay401, attempt == 0 { continue }
      guard response.statusCode == expectedStatus else {
        if response.statusCode == 401 { throw AuthFailure.sessionExpired }
        throw AuthFailure.serviceUnavailable
      }
      return data
    }
    throw AuthFailure.sessionExpired
  }
}

private func validFCMToken(_ value: String) -> Bool {
  !value.isEmpty && value.utf8.count <= 4096
    && value.unicodeScalars.allSatisfy { (33...126).contains($0.value) }
}

/// Optional transport is disabled in fixtures/simulator; sanitized local hints remain usable.
@MainActor final class PushRegistrationCoordinator: ObservableObject {
  private struct Registered {
    let session: PushSession
    let token: String
    let binding: PushBinding
  }
  private let api: PushRegistrationAPI
  private let jobs: JobsAPI
  private let session: @MainActor () -> PushSession?
  private let identityUID: @MainActor () -> String?
  private let tokenSource: @MainActor () async -> String?
  private let enabled: Bool
  private var permitted = false
  private var apnsReady = false
  private var token: String?
  private var tokenVersion = 0
  private var generation = 0
  private var registered: Registered?
  private var synchronization: (id: UUID, task: Task<Void, Never>)?
  private var syncAgain = false
  private var forceSync = false
  private var navigation: (id: UUID, hint: ProcessingJobHint, task: Task<Job?, Error>)?
  private var seenRefresh: [String] = []
  private var seenTaps: [String] = []
  @Published private(set) var pendingTap: ProcessingJobHint?
  @Published private(set) var refreshHint: ProcessingJobHint?

  init(
    api: PushRegistrationAPI, jobs: JobsAPI, session: @escaping @MainActor () -> PushSession?,
    identityUID: @escaping @MainActor () -> String?,
    tokenSource: @escaping @MainActor () async -> String?, enabled: Bool
  ) {
    self.api = api
    self.jobs = jobs
    self.session = session
    self.identityUID = identityUID
    self.tokenSource = tokenSource
    self.enabled = enabled
  }

  func permissionChanged(granted: Bool) {
    permitted = granted
    schedule()
  }
  func apnsTokenReady() {
    apnsReady = true
    schedule()
  }
  func apnsRegistrationFailed() {
    apnsReady = false
    synchronization?.task.cancel()
  }
  func receivedFCMToken(_ value: String?) {
    guard let value, validFCMToken(value) else { return }
    token = value
    tokenVersion &+= 1
    schedule()
  }
  func sessionChanged() {
    generation &+= 1
    synchronization?.task.cancel()
    synchronization = nil
    navigation?.task.cancel()
    navigation = nil
    // Keep acknowledged old binding for conditional before-sign-out cleanup.
    schedule(force: true)
  }
  func foreground() { schedule(force: true) }

  func synchronize() async {
    schedule()
    await synchronization?.task.value
  }

  private func schedule(force: Bool = false) {
    guard enabled else { return }
    syncAgain = true
    forceSync = forceSync || force
    guard synchronization == nil else { return }
    let id = UUID()
    let task = Task { @MainActor [weak self] in
      guard let self else { return }
      defer { if self.synchronization?.id == id { self.synchronization = nil } }
      repeat {
        self.syncAgain = false
        let forced = self.forceSync
        self.forceSync = false
        do { try await self.syncOnce(force: forced) } catch is CancellationError { return } catch {
          // Retry optional push on foreground; never log tokens/provider diagnostics.
        }
      } while self.syncAgain && !Task.isCancelled
    }
    synchronization = (id, task)
  }

  private func syncOnce(force: Bool) async throws {
    try Task.checkCancellation()
    guard permitted, apnsReady, let captured = session(), captured.uid == identityUID() else {
      return
    }
    let ticket = generation
    let version = tokenVersion
    let availableToken: String?
    if let token { availableToken = token } else { availableToken = await tokenSource() }
    guard let candidate = availableToken, validFCMToken(candidate) else { return }
    try Task.checkCancellation()
    guard current(captured, ticket), permitted, apnsReady, tokenVersion == version else { return }
    token = candidate
    if !force, let registered, registered.session == captured, registered.token == candidate {
      return
    }
    let binding = try await api.register(installationID: captured.installationID, token: candidate)
    try Task.checkCancellation()
    guard current(captured, ticket) else { return }
    registered = Registered(session: captured, token: candidate, binding: binding)
  }

  func beforeSignOut(uid: String, installationID: String?) async {
    generation &+= 1
    synchronization?.task.cancel()
    synchronization = nil
    syncAgain = false
    navigation?.task.cancel()
    navigation = nil
    pendingTap = nil
    refreshHint = nil
    let old = registered
    registered = nil
    guard enabled, let old, old.session.uid == uid, old.session.installationID == installationID,
      identityUID() == uid
    else { return }
    await performBoundedSignOutCleanup(
      before: { [self] in
        guard self.identityUID() == uid else { return }
        try await self.api.deactivate(
          installationID: old.binding.installationID,
          expectedBindingRevision: old.binding.bindingRevision)
      }, clearIdentity: {}, timeoutNanoseconds: 1_500_000_000)
  }

  func receivedMessage(_ data: [AnyHashable: Any]) {
    if let hint = processingJobHint(data) { receivedMessage(hint) }
  }
  func receivedMessage(_ hint: ProcessingJobHint) {
    guard let captured = session(), captured.uid == identityUID(),
      !seenRefresh.contains(hint.eventID)
    else { return }
    remember(hint.eventID, in: &seenRefresh)
    refreshHint = hint
  }
  func rememberTap(_ data: [AnyHashable: Any]) {
    if let hint = processingJobHint(data) { rememberTap(hint) }
  }
  func rememberTap(_ hint: ProcessingJobHint) {
    guard !seenTaps.contains(hint.eventID) else { return }
    pendingTap = hint
  }

  func resolvePendingTap() async throws -> Job? {
    guard let hint = pendingTap, let captured = session(), captured.uid == identityUID() else {
      return nil
    }
    if let running = navigation, running.hint == hint { return try await running.task.value }
    navigation?.task.cancel()
    let ticket = generation
    let id = UUID()
    let task = Task { @MainActor [weak self] () throws -> Job? in
      guard let self else { return nil }
      let job: Job
      do { job = try await self.jobs.detail(id: hint.jobID) } catch is CancellationError {
        return nil
      } catch JobsFailure.notFound {
        if self.current(captured, ticket), self.pendingTap == hint {
          self.pendingTap = nil
          self.remember(hint.eventID, in: &self.seenTaps)
        }
        return nil
      }
      guard self.current(captured, ticket), self.pendingTap == hint, job.id == hint.jobID else {
        return nil
      }
      self.pendingTap = nil
      self.remember(hint.eventID, in: &self.seenTaps)
      return job
    }
    navigation = (id, hint, task)
    defer { if navigation?.id == id { navigation = nil } }
    return try await task.value
  }

  private func current(_ captured: PushSession, _ ticket: Int) -> Bool {
    generation == ticket && session() == captured && identityUID() == captured.uid
  }
  private func remember(_ event: String, in values: inout [String]) {
    values.append(event)
    if values.count > 128 { values.removeFirst(values.count - 128) }
  }
}
