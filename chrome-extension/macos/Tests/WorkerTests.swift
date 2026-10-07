import AppKit
import Foundation
import SwiftUI

@MainActor private final class WorkerFixtureTransport: DesktopWorkerTransport {
  struct Call {
    let command: DesktopWorkerCommand
    let parameters: DesktopJSON
  }
  var calls: [Call] = []
  var subscribers: [(DesktopJSON) -> Void] = []
  var endings: [(DesktopWorkerFailure?) -> Void] = []
  var closes = 0
  var result = DesktopJSON.object(["status": .string("ok")])
  var results: [DesktopWorkerCommand: DesktopJSON] = [:]
  var commandErrors: [DesktopWorkerCommand: DesktopWorkerFailure] = [:]
  var holdCommands = Set<DesktopWorkerCommand>()
  var nonStatusCalls: [Call] { calls.filter { $0.command != .status } }
  var error: DesktopWorkerFailure?
  var gate: CheckedContinuation<Void, Never>?
  var hold = false
  var executed: ((DesktopWorkerCommand, DesktopJSON) -> Void)?
  func execute(
    _ command: DesktopWorkerCommand, parameters: DesktopJSON,
    progress: @escaping (DesktopJSON) -> Void
  ) async throws -> DesktopJSON {
    calls.append(Call(command: command, parameters: parameters))
    executed?(command, parameters)
    progress(.object(["stage": .string("draining")]))
    if hold || holdCommands.contains(command) { await withCheckedContinuation { gate = $0 } }
    if let error = commandErrors[command] ?? error { throw error }
    return results[command] ?? (command == .status ? WorkerTests.fixture : result)
  }
  func subscribe(
    _ command: DesktopWorkerCommand, parameters: DesktopJSON,
    snapshot: @escaping (DesktopJSON) -> Void,
    ended: @escaping (DesktopWorkerFailure?) -> Void
  ) async throws {
    calls.append(Call(command: command, parameters: parameters))
    if let error { throw error }
    subscribers.append(snapshot)
    endings.append(ended)
  }
  func closeSubscriptions() { closes += 1 }
  func waitUntilSubscriptionsClose() async {}
}

private final class WorkerInstallationFixture: @unchecked Sendable {
  private let lock = NSLock()
  private var state: DesktopWorkerInstallation
  private var paused = false
  private var inspections = 0
  private let gate = DispatchSemaphore(value: 0)
  init(_ state: DesktopWorkerInstallation) { self.state = state }
  func inspect() -> DesktopWorkerInstallation {
    lock.lock()
    let value = state
    let pause = paused
    paused = false
    inspections += 1
    lock.unlock()
    if pause { gate.wait() }
    return value
  }
  func pauseNextInspection() {
    lock.lock()
    paused = true
    lock.unlock()
  }
  func inspectionCount() -> Int {
    lock.lock()
    defer { lock.unlock() }
    return inspections
  }
  func releaseInspection() { gate.signal() }
  func set(_ value: DesktopWorkerInstallation) {
    lock.lock()
    state = value
    lock.unlock()
  }
}
@MainActor private final class WorkerRegistrationVault: DesktopCredentialVault {
  var value: DesktopCredential?
  func load() async throws -> DesktopCredential? { value }
  func save(_ credential: DesktopCredential) throws { value = credential }
  func remove() throws { value = nil }
}
private actor WorkerRegistrationHTTP: DesktopHTTPTransport {
  var profile: DesktopJSON
  var requests: [URLRequest] = []
  var holdIssuance = false
  var holdProfile = false
  var failure: DesktopAuthFailure?
  private var blocked: CheckedContinuation<Void, Never>?
  private var profileBlocked: CheckedContinuation<Void, Never>?
  init(allowed: Bool) {
    profile = .object([
      "id": .string("000000000000000000000042"), "display_name": .string("Fixture"),
      "email": .string("fixture@example.invalid"), "email_verified": .bool(true),
      "providers": .array([.string("google.com"), .string("password")]),
      "worker_registration_allowed": .bool(allowed),
    ])
  }
  func send(_ request: URLRequest) async throws -> (Data, Int) {
    requests.append(request)
    if let failure { throw failure }
    let response: DesktopJSON
    if request.url?.path == "/users/me/worker-installation" {
      if holdIssuance { await withCheckedContinuation { blocked = $0 } }
      response = .object([
        "credential": .string(String(repeating: "f", count: 43)),
        "expires_at": .string(ISO8601DateFormatter().string(from: Date().addingTimeInterval(60))),
      ])
    } else if request.url?.path == "/users/me" {
      response = profile
      if holdProfile { await withCheckedContinuation { profileBlocked = $0 } }
    } else {
      response = .object(["user": profile, "access": .object(["allowed": .bool(true)])])
    }
    return (try JSONEncoder().encode(response), 200)
  }
  func hold() { holdIssuance = true }
  func setAllowed(_ value: Bool) {
    guard case .object(var fields) = profile else { preconditionFailure() }
    fields["worker_registration_allowed"] = .bool(value)
    profile = .object(fields)
  }
  func holdProfileRead() { holdProfile = true }
  func isProfileBlocked() -> Bool { profileBlocked != nil }
  func releaseProfileRead() {
    profileBlocked?.resume()
    profileBlocked = nil
    holdProfile = false
  }
  func release() {
    blocked?.resume()
    blocked = nil
    holdIssuance = false
  }
  func issuanceCount() -> Int {
    requests.filter { $0.url?.path == "/users/me/worker-installation" }.count
  }
}

@main struct WorkerTests {
  @MainActor private static var preferenceDomains: [String] = []
  @MainActor private static func privatePreferences() -> UserDefaults {
    let domain = "musicmute-worker-\(UUID())"
    preferenceDomains.append(domain)
    return UserDefaults(suiteName: domain)!
  }
  private static let machine = "00000000-0000-4000-8000-000000000041"
  fileprivate static let fixture = DesktopJSON.object([
    "schemaVersion": .number(2), "installed": .bool(true), "healthy": .bool(true),
    "machineId": .string(machine),
    "lifecycle": .string("active"), "activeReleaseVersion": .string("fixture.1"),
    "service": .object(["running": .bool(true), "loaded": .bool(true)]),
    "runtime": .object([
      "currentAttempts": .array([]), "activeAttempts": .number(0), "childState": .string("ready"),
    ]),
    "readiness": .object([
      "phase": .string("ready"), "blockers": .array([]),
      "modelReady": .bool(true), "localReady": .bool(true), "claimEligible": .null,
    ]),
  ])
  private static func checkedStatus(
    _ code: String? = nil, http: Int? = nil, notice: DesktopJSON = .null
  ) -> DesktopJSON {
    guard case .object(var fields) = fixture else { preconditionFailure() }
    fields["remote"] = .object([
      "available": .bool(code == nil), "errorCode": code.map(DesktopJSON.string) ?? .null,
      "httpStatus": http.map { .number(Double($0)) } ?? .null,
      "state": code == nil ? .object(["claimsAllowed": .bool(false)]) : .null,
    ])
    fields["deletionNotice"] = notice
    return .object(fields)
  }
  private static let deletedStatus = checkedStatus("WORKER_MACHINE_DELETED", http: 410)
  private static let deletedUnpair: DesktopJSON = .object([
    "confirmed": .bool(true), "deleted": .bool(true), "status": .string("ok"),
    "machineId": .string(machine),
  ])
  private static func receiptStatus(configured: Bool = false) -> DesktopJSON {
    guard case .object(var fields) = fixture else { preconditionFailure() }
    fields["machineId"] = configured ? .string(machine) : .null
    fields["installed"] = .bool(configured)
    fields["service"] = .object(["running": .bool(false), "loaded": .bool(false)])
    fields["confirmedDeletedReceipt"] = .bool(true)
    fields["deletedMachineId"] = .string(machine)
    fields["registrationDeleted"] = .bool(true)
    return .object(fields)
  }
  private static let deletedRecovery: DesktopJSON = .object([
    "deleted": .bool(true), "registrationReset": .bool(true), "status": .string("ok"),
  ])
  @MainActor private static func deletionTransport(_ local: WorkerInstallationFixture)
    -> WorkerFixtureTransport
  {
    let transport = WorkerFixtureTransport()
    transport.results[.status] = deletedStatus
    if local.inspect() == .unpaired { transport.results[.status] = receiptStatus() }
    transport.results[.unpair] = deletedUnpair
    transport.results[.recover] = deletedRecovery
    transport.executed = { [weak transport] command, _ in
      if command == .unpair {
        local.set(.unpaired)
        transport?.results[.status] = receiptStatus()
      }
      if command == .recover {
        local.set(.fresh)
        transport?.results[.status] = checkedStatus()
      }
      if command == .install { local.set(.registered(serviceInstalled: true)) }
    }
    return transport
  }
  private static func frame(_ type: String, id: String, payload: DesktopJSON = fixture) throws
    -> Data
  {
    try JSONEncoder().encode(
      DesktopJSON.object([
        "protocol_version": .number(1), "request_id": .string(id), "type": .string(type),
        "payload": payload,
      ]))
  }
  private static func rejects(_ body: () throws -> Void) {
    do {
      try body()
      preconditionFailure("Unsafe worker input accepted")
    } catch is DesktopWorkerFailure {} catch { preconditionFailure("Unexpected worker error type") }
  }
  @MainActor private static func eventually(_ condition: @MainActor () async -> Bool) async {
    let deadline = ContinuousClock.now.advanced(by: .seconds(3))
    while !(await condition()) {
      precondition(ContinuousClock.now < deadline, "Worker registration fixture did not settle")
      try? await Task.sleep(for: .milliseconds(5))
    }
  }
  private static func expectIssuance(
    _ http: WorkerRegistrationHTTP, count: Int, file: StaticString = #file, line: UInt = #line
  ) async {
    let actual = await http.issuanceCount()
    precondition(
      actual == count, "Expected \(count) enrollment requests; received \(actual)", file: file,
      line: line)
  }
  @MainActor private static func registrationAccount(
    allowed: Bool, provider: String = "google.com", preferences existing: UserDefaults? = nil,
    uid: String = "worker-fixture-user"
  ) async throws -> (DesktopAccountModel, WorkerRegistrationHTTP, UserDefaults) {
    let project = "worker-fixture"
    let claims = try JSONEncoder().encode(
      DesktopJSON.object([
        "aud": .string(project), "iss": .string("https://securetoken.google.com/\(project)"),
        "sub": .string(uid), "firebase": .object(["sign_in_provider": .string(provider)]),
      ]))
    let vault = WorkerRegistrationVault()
    vault.value = DesktopCredential(
      firebaseUid: uid, idToken: "fixture.\(DesktopGoogleOAuth.base64URL(claims)).fixture",
      refreshToken: String(repeating: "r", count: 30), expiresAt: Date().addingTimeInterval(3600),
      user: nil)
    let http = WorkerRegistrationHTTP(allowed: allowed)
    let preferences: UserDefaults
    if let existing {
      preferences = existing
    } else {
      preferences = privatePreferences()
    }
    let account = DesktopAccountModel(
      configuration: DesktopPublicConfiguration(
        backendBaseURL: "https://worker-fixture.invalid",
        firebaseAPIKey: String(repeating: "A", count: 39),
        firebaseProjectID: project, googleDesktopClientID: "123-fixture.apps.googleusercontent.com"),
      vault: vault, transport: http, installationId: UUID().uuidString, preferences: preferences)
    await account.restore()
    precondition(account.signedIn && account.scope != nil)
    return (account, http, preferences)
  }
  @MainActor private static func registrationChecks() async throws {
    // No Worker view is opened: a shared realtime account update performs first setup.
    do {
      let (account, http, preferences) = try await registrationAccount(allowed: false)
      let local = WorkerInstallationFixture(.fresh)
      let transport = WorkerFixtureTransport()
      transport.executed = { command, _ in
        if command == .install { local.set(.registered(serviceInstalled: true)) }
      }
      let model = DesktopWorkerModel(
        resources: nil, transport: transport, preferences: preferences,
        inspectInstallation: { local.inspect() })
      model.coordinateRegistration(account: account)
      await eventually { model.registrationState == .waiting }
      precondition(transport.nonStatusCalls.isEmpty)
      await expectIssuance(http, count: 0)
      account.receiveWorkerRegistration(true, scope: account.scope!)
      for _ in 0..<20 { model.registrationChanged() }
      await eventually { model.registrationState == .registered && !model.busy }
      await expectIssuance(http, count: 1)
      precondition(transport.nonStatusCalls.map(\.command) == [.install, .start])
      precondition(transport.nonStatusCalls[0].parameters["label"].string == "MusicMute Mac")
      precondition(transport.nonStatusCalls[0].parameters["enrollment_code"].string != nil)
      precondition(transport.nonStatusCalls[1].parameters["wait_ready"].bool == true)
      precondition(model.report == .null && model.reportCommand == nil)
      account.receiveWorkerRegistration(false, scope: account.scope!)
      await account.logout(all: false)
      model.hide()
      for _ in 0..<10 { model.registrationChanged() }
      try await Task.sleep(for: .milliseconds(30))
      precondition(transport.nonStatusCalls.map(\.command) == [.install, .start])
    }
    // A linked Google provider never authorizes a current password session.
    do {
      let (account, http, preferences) = try await registrationAccount(
        allowed: true, provider: "password")
      let transport = WorkerFixtureTransport()
      let model = DesktopWorkerModel(
        resources: nil, transport: transport, preferences: preferences,
        inspectInstallation: { .fresh })
      model.coordinateRegistration(account: account)
      await eventually { model.registrationState == .googleRequired }
      precondition(transport.nonStatusCalls.isEmpty)
      await expectIssuance(http, count: 0)
    }
    // Unknown/offline permission is never approved from a saved account or old snapshot.
    do {
      let (account, http, preferences) = try await registrationAccount(allowed: false)
      account.receiveWorkerRegistration(nil, scope: account.scope!)
      let transport = WorkerFixtureTransport()
      let model = DesktopWorkerModel(
        resources: nil, transport: transport, preferences: preferences,
        inspectInstallation: { .fresh })
      model.coordinateRegistration(account: account)
      await eventually { model.registrationState == .unavailable }
      precondition(transport.nonStatusCalls.isEmpty)
      await expectIssuance(http, count: 0)
    }
    // Reopening / reconnect / account changes must respect a stopped registered machine.
    for installed in [true, false] {
      let (account, http, preferences) = try await registrationAccount(allowed: true)
      let local = WorkerInstallationFixture(.registered(serviceInstalled: installed))
      let transport = WorkerFixtureTransport()
      transport.executed = { command, _ in
        if command == .install { local.set(.registered(serviceInstalled: true)) }
      }
      let model = DesktopWorkerModel(
        resources: nil, transport: transport, preferences: preferences,
        inspectInstallation: { local.inspect() })
      model.coordinateRegistration(account: account)
      await eventually { model.registrationState == (installed ? .registered : .preserved) }
      precondition(transport.nonStatusCalls.isEmpty)
      await expectIssuance(http, count: 0)
      if !installed {
        await account.logout(all: false)
        await model.startRegisteredWorker()
        precondition(transport.nonStatusCalls.map(\.command) == [.install, .start])
        precondition(
          transport.nonStatusCalls[0].parameters == .object(["label": .string("MusicMute Mac")]))
        await expectIssuance(http, count: 0)
      } else {
        await model.run(.stop)
        account.receiveWorkerRegistration(false, scope: account.scope!)
        account.receiveWorkerRegistration(true, scope: account.scope!)
        await account.logout(all: false)
        model.registrationChanged()
        await eventually { !model.busy && model.registrationState == .registered }
        precondition(transport.nonStatusCalls.map(\.command) == [.stop])
      }
    }
    // A late credential reply after sign-out never reaches the controller.
    do {
      let (account, http, preferences) = try await registrationAccount(allowed: true)
      await http.hold()
      let transport = WorkerFixtureTransport()
      let model = DesktopWorkerModel(
        resources: nil, transport: transport, preferences: preferences,
        inspectInstallation: { .fresh })
      model.coordinateRegistration(account: account)
      await eventually { (await http.issuanceCount()) == 1 }
      await account.logout(all: false)
      await http.release()
      await eventually { model.registrationState == .signedOut && !model.busy }
      precondition(transport.nonStatusCalls.isEmpty)
    }
    // Once accepted by the controller, GUI sign-out cannot cancel setup/startup.
    do {
      let (account, http, preferences) = try await registrationAccount(allowed: true)
      await http.hold()
      let local = WorkerInstallationFixture(.fresh)
      let transport = WorkerFixtureTransport()
      transport.executed = { command, _ in
        if command == .install { local.set(.registered(serviceInstalled: true)) }
      }
      let model = DesktopWorkerModel(
        resources: nil, transport: transport, preferences: preferences,
        inspectInstallation: { local.inspect() })
      model.coordinateRegistration(account: account)
      await eventually { (await http.issuanceCount()) == 1 }
      account.receiveWorkerRegistration(nil, scope: account.scope!)
      await http.release()
      await eventually { model.registrationState == .unavailable && !model.busy }
      precondition(transport.nonStatusCalls.isEmpty)
      account.receiveWorkerRegistration(true, scope: account.scope!)
      await eventually { model.registrationState == .registered && !model.busy }
      precondition(transport.nonStatusCalls.map(\.command) == [.install, .start])
      await expectIssuance(http, count: 2)
    }
    // Once accepted by the controller, GUI sign-out cannot cancel setup/startup.
    do {
      let (account, http, preferences) = try await registrationAccount(allowed: true)
      let local = WorkerInstallationFixture(.fresh)
      let transport = WorkerFixtureTransport()
      transport.hold = true
      transport.executed = { command, _ in
        if command == .install { local.set(.registered(serviceInstalled: true)) }
      }
      let model = DesktopWorkerModel(
        resources: nil, transport: transport, preferences: preferences,
        inspectInstallation: { local.inspect() })
      model.coordinateRegistration(account: account)
      await eventually { transport.gate != nil }
      await account.logout(all: false)
      transport.hold = false
      transport.gate?.resume()
      transport.gate = nil
      await eventually { model.registrationState == .registered && !model.busy }
      precondition(transport.nonStatusCalls.map(\.command) == [.install, .start])
      await expectIssuance(http, count: 1)
    }
    // Interrupted setup reuses the controller's private recovery secret; no account is needed.
    do {
      let (account, http, preferences) = try await registrationAccount(allowed: true)
      await account.logout(all: false)
      let local = WorkerInstallationFixture(.interrupted)
      let transport = WorkerFixtureTransport()
      transport.executed = { _, _ in local.set(.registered(serviceInstalled: true)) }
      let model = DesktopWorkerModel(
        resources: nil, transport: transport, preferences: preferences,
        inspectInstallation: { local.inspect() })
      model.coordinateRegistration(account: account)
      await eventually { model.registrationState == .interrupted }
      await model.retryRegistration()
      precondition(transport.nonStatusCalls.map(\.command) == [.install])
      precondition(
        transport.nonStatusCalls[0].parameters == .object(["label": .string("MusicMute Mac")]))
      await expectIssuance(http, count: 0)
    }
    // Missing flag decodes as false and a malformed flag does not silently become approval.
    // The non-secret registering UID survives app restart, while another account cannot replace it.
    do {
      let (account, http, preferences) = try await registrationAccount(allowed: true)
      let local = WorkerInstallationFixture(.fresh)
      let transport = WorkerFixtureTransport()
      transport.error = DesktopWorkerFailure("ENROLLMENT_FAILED")
      transport.executed = { command, _ in
        if command == .install { local.set(.interrupted) }
      }
      let original = DesktopWorkerModel(
        resources: nil, transport: transport, preferences: preferences,
        inspectInstallation: { local.inspect() })
      original.coordinateRegistration(account: account)
      await eventually { original.registrationState == .interrupted && !original.busy }
      await expectIssuance(http, count: 1)
      let (restoredAccount, restoredHTTP, _) = try await registrationAccount(
        allowed: true, preferences: preferences)
      let restoredTransport = WorkerFixtureTransport()
      restoredTransport.error = DesktopWorkerFailure("ENROLLMENT_FAILED")
      let restored = DesktopWorkerModel(
        resources: nil, transport: restoredTransport, preferences: preferences,
        inspectInstallation: { local.inspect() })
      restored.coordinateRegistration(account: restoredAccount)
      await eventually { restored.registrationState == .interrupted }
      precondition(!restored.canReplacePendingRegistration)
      await restored.retryRegistration()
      precondition(restored.canReplacePendingRegistration)
      await expectIssuance(restoredHTTP, count: 0)
      let (otherAccount, otherHTTP, otherPreferences) = try await registrationAccount(
        allowed: true, preferences: preferences, uid: "another-fixture-user")
      let otherTransport = WorkerFixtureTransport()
      otherTransport.error = DesktopWorkerFailure("ENROLLMENT_FAILED")
      let other = DesktopWorkerModel(
        resources: nil, transport: otherTransport, preferences: otherPreferences,
        inspectInstallation: { local.inspect() })
      other.coordinateRegistration(account: otherAccount)
      await eventually { other.registrationState == .interrupted }
      await other.retryRegistration()
      precondition(!other.canReplacePendingRegistration)
      await other.replacePendingRegistration()
      await expectIssuance(otherHTTP, count: 0)
      restoredTransport.error = nil
      restoredTransport.executed = { command, _ in
        if command == .install { local.set(.registered(serviceInstalled: true)) }
      }
      await restored.replacePendingRegistration()
      precondition(restoredTransport.nonStatusCalls.map(\.command) == [.install, .install, .start])
      precondition(restoredTransport.nonStatusCalls[1].parameters["new_code"].bool == true)
      await expectIssuance(restoredHTTP, count: 1)
      let values = preferences.dictionaryRepresentation()
      precondition(!values.values.contains { ($0 as? String) == String(repeating: "f", count: 43) })
    }
    // Unknown legacy pending state remains untouched by the new account's registration permission.
    do {
      let (account, http, preferences) = try await registrationAccount(allowed: true)
      let transport = WorkerFixtureTransport()
      transport.error = DesktopWorkerFailure("ENROLLMENT_FAILED")
      let model = DesktopWorkerModel(
        resources: nil, transport: transport, preferences: preferences,
        inspectInstallation: { .interrupted })
      model.coordinateRegistration(account: account)
      await eventually { model.registrationState == .interrupted }
      await model.retryRegistration()
      precondition(!model.canReplacePendingRegistration)
      await model.replacePendingRegistration()
      await expectIssuance(http, count: 0)
    }
    // Explicit purge/removal cannot be undone by approval events, reopening or a fresh model.
    do {
      let (account, http, preferences) = try await registrationAccount(allowed: true)
      let local = WorkerInstallationFixture(.registered(serviceInstalled: true))
      let transport = WorkerFixtureTransport()
      transport.executed = { command, _ in
        if command == .uninstall { local.set(.fresh) }
      }
      let original = DesktopWorkerModel(
        resources: nil, transport: transport, preferences: preferences,
        inspectInstallation: { local.inspect() })
      original.coordinateRegistration(account: account)
      await eventually { original.registrationState == .registered }
      await original.run(.uninstall, parameters: .object(["purge": .bool(true)]), confirmed: true)
      await eventually { original.registrationState == .removed }
      account.receiveWorkerRegistration(false, scope: account.scope!)
      account.receiveWorkerRegistration(true, scope: account.scope!)
      original.registrationChanged()
      let restoredTransport = WorkerFixtureTransport()
      restoredTransport.executed = { command, _ in
        if command == .install { local.set(.registered(serviceInstalled: true)) }
      }
      let restored = DesktopWorkerModel(
        resources: nil, transport: restoredTransport, preferences: preferences,
        inspectInstallation: { local.inspect() })
      let (restoredAccount, restoredHTTP, _) = try await registrationAccount(
        allowed: true, preferences: preferences)
      restored.coordinateRegistration(account: restoredAccount)
      await eventually { restored.registrationState == .removed }
      precondition(
        transport.nonStatusCalls.map(\.command) == [.uninstall]
          && restoredTransport.nonStatusCalls.isEmpty)
      await expectIssuance(http, count: 0)
      await expectIssuance(restoredHTTP, count: 0)
      await restored.registerThisMacAgain()
      await eventually { restored.registrationState == .registered && !restored.busy }
      precondition(restoredTransport.nonStatusCalls.map(\.command) == [.install, .start])
      await expectIssuance(restoredHTTP, count: 1)
    }
    // Approval inspection cannot steal command ownership after an unrelated action starts.
    do {
      let (account, http, preferences) = try await registrationAccount(allowed: true)
      let local = WorkerInstallationFixture(.fresh)
      local.pauseNextInspection()
      let transport = WorkerFixtureTransport()
      transport.hold = true
      transport.executed = { command, _ in
        if command == .install { local.set(.registered(serviceInstalled: true)) }
      }
      let model = DesktopWorkerModel(
        resources: nil, transport: transport, preferences: preferences,
        inspectInstallation: { local.inspect() })
      model.coordinateRegistration(account: account)
      await eventually { local.inspectionCount() == 1 }
      let operation = Task { await model.run(.versions) }
      await eventually { transport.gate != nil }
      local.releaseInspection()
      try await Task.sleep(for: .milliseconds(30))
      precondition(model.busy && model.currentCommand == .versions)
      precondition(transport.nonStatusCalls.map(\.command) == [.versions])
      await expectIssuance(http, count: 0)
      transport.hold = false
      transport.gate?.resume()
      transport.gate = nil
      await operation.value
      await eventually { model.registrationState == .registered && !model.busy }
      precondition(transport.nonStatusCalls.map(\.command) == [.versions, .install, .start])
      await expectIssuance(http, count: 1)
    }
    // Initial approval waits for Prepare rather than consuming an unusable credential.
    do {
      let (account, http, preferences) = try await registrationAccount(allowed: true)
      let local = WorkerInstallationFixture(.fresh)
      let transport = WorkerFixtureTransport()
      transport.executed = { command, _ in
        if command == .install { local.set(.registered(serviceInstalled: true)) }
      }
      let model = DesktopWorkerModel(
        resources: nil, transport: transport, preferences: preferences,
        inspectInstallation: { local.inspect() })
      model.canRegister = { false }
      model.coordinateRegistration(account: account)
      await eventually { model.registrationState == .setupRequired }
      await expectIssuance(http, count: 0)
      model.canRegister = { true }
      model.registrationRuntimeBecameReady()
      await eventually { model.registrationState == .registered && !model.busy }
      await expectIssuance(http, count: 1)
    }
    // Missing flag decodes as false and a malformed flag does not silently become approval.
    var profile: [String: DesktopJSON] = [
      "id": .string("fixture"), "display_name": .string("Fixture"), "email": .null,
      "email_verified": .bool(true), "providers": .array([]),
    ]
    let missing = try JSONDecoder().decode(
      DesktopUser.self, from: JSONEncoder().encode(DesktopJSON.object(profile)))
    precondition(!missing.workerRegistrationAllowed)
    profile["worker_registration_allowed"] = .string("true")
    precondition(
      (try? JSONDecoder().decode(
        DesktopUser.self, from: JSONEncoder().encode(DesktopJSON.object(profile)))) == nil)
  }
  @MainActor private static func deletionChecks() async throws {
    // A typed Delete retires only the old registration; stale cached approval cannot enroll anew.
    do {
      let (account, http, preferences) = try await registrationAccount(allowed: true)
      await http.setAllowed(false)
      let local = WorkerInstallationFixture(.registered(serviceInstalled: true))
      let transport = deletionTransport(local)
      let model = DesktopWorkerModel(
        resources: nil, transport: transport, preferences: preferences,
        inspectInstallation: { local.inspect() })
      model.coordinateRegistration(account: account)
      await eventually { model.registrationState == .waiting && !model.busy }
      precondition(model.deletedRegistrationObserved)
      precondition(transport.calls.map(\.command) == [.status, .status, .unpair, .recover])
      precondition(
        transport.calls[2].parameters
          == .object([
            "force": .bool(false), "expected_machine_id": .string(machine),
            "deleted_only": .bool(true),
          ]))
      precondition(transport.calls[3].parameters == .object([:]))
      await expectIssuance(http, count: 0)
      for _ in 0..<20 { model.registrationChanged() }
      try await Task.sleep(for: .milliseconds(30))
      precondition(transport.calls.map(\.command) == [.status, .status, .unpair, .recover])
      account.receiveWorkerRegistration(true, scope: account.scope!)
      await eventually { model.registrationState == .registered && !model.busy }
      await expectIssuance(http, count: 1)
      precondition(
        transport.nonStatusCalls.map(\.command) == [.unpair, .recover, .install, .start])
      precondition(!transport.calls.contains { $0.command == .uninstall })
      precondition(!model.deletedRegistrationObserved)
    }
    // Revoked/unknown credentials, network errors, disabled claims and mistyped deletion never reset state.
    for status in [
      checkedStatus("WORKER_UNAUTHENTICATED", http: 401),
      checkedStatus("WORKER_MACHINE_DELETED", http: 401),
      checkedStatus("WORKER_MACHINE_DELETED", http: 500),
      checkedStatus("WORKER_MACHINE_DELETED"), checkedStatus("BACKEND_UNAVAILABLE"),
      checkedStatus(),
    ] {
      let (account, http, preferences) = try await registrationAccount(allowed: true)
      let transport = WorkerFixtureTransport()
      transport.results[.status] = status
      let model = DesktopWorkerModel(
        resources: nil, transport: transport, preferences: preferences,
        inspectInstallation: { .registered(serviceInstalled: true) })
      model.coordinateRegistration(account: account)
      let rejected = status["remote"]["errorCode"].string == "WORKER_UNAUTHENTICATED"
      await eventually {
        !model.busy && model.registrationState == (rejected ? .authenticationRejected : .registered)
      }
      precondition(
        transport.calls.map(\.command) == [.status] && !model.deletedRegistrationObserved)
      await expectIssuance(http, count: 0)
      for _ in 0..<20 { model.registrationChanged() }
      try await Task.sleep(for: .milliseconds(20))
      precondition(transport.calls.map(\.command) == [.status])
    }
    // Full check is user-driven after a network failure; local streams never erase a rejection.
    do {
      let (account, http, preferences) = try await registrationAccount(allowed: true)
      await http.setAllowed(false)
      let local = WorkerInstallationFixture(.registered(serviceInstalled: true))
      let transport = deletionTransport(local)
      transport.results[.status] = checkedStatus("WORKER_UNAUTHENTICATED", http: 401)
      let model = DesktopWorkerModel(
        resources: nil, transport: transport, preferences: preferences,
        inspectInstallation: { local.inspect() })
      model.coordinateRegistration(account: account)
      await eventually { model.registrationState == .authenticationRejected && !model.busy }
      model.show()
      await eventually { !transport.subscribers.isEmpty }
      let predecessor = transport.subscribers[0]
      predecessor(fixture)
      precondition(model.registrationState == .authenticationRejected)
      transport.results[.status] = deletedStatus
      await model.run(.status)
      await eventually { model.registrationState == .waiting && !model.busy }
      await expectIssuance(http, count: 0)
      let count = transport.calls.count
      predecessor(checkedStatus("WORKER_MACHINE_DELETED", http: 410))
      try await Task.sleep(for: .milliseconds(20))
      precondition(transport.calls.count == count && model.registrationState == .waiting)
      model.hide()
    }
    // The background worker's strictly typed local notice also supports signed-out cleanup.
    for valid in [false, true] {
      let (account, http, preferences) = try await registrationAccount(allowed: false)
      await account.logout()
      let local = WorkerInstallationFixture(.registered(serviceInstalled: true))
      let transport = deletionTransport(local)
      transport.results[.status] = checkedStatus()
      let model = DesktopWorkerModel(
        resources: nil, transport: transport, preferences: preferences,
        inspectInstallation: { local.inspect() })
      model.coordinateRegistration(account: account)
      await eventually { model.registrationState == .registered && !model.busy }
      model.show()
      await eventually { !transport.subscribers.isEmpty }
      let notice: DesktopJSON = .object([
        "schemaVersion": .number(1), "code": .string("WORKER_MACHINE_DELETED"),
        "machineId": .string(machine),
        "httpStatus": .number(valid ? 410 : 401), "detectedAt": .string("2026-10-06T15:00:00.000Z"),
      ])
      if valid { transport.results[.status] = deletedStatus }
      transport.subscribers[0](checkedStatus(notice: notice))
      if valid {
        await eventually { model.registrationState == .signedOut && !model.busy }
        precondition(transport.nonStatusCalls.map(\.command) == [.unpair, .recover])
      } else {
        try await Task.sleep(for: .milliseconds(20))
        precondition(transport.nonStatusCalls.isEmpty && model.registrationState == .registered)
      }
      await expectIssuance(http, count: 0)
      model.hide()
    }
    // Missing deleted confirmation is fail-closed and cannot silently repeat cleanup.
    do {
      let (account, http, preferences) = try await registrationAccount(allowed: true)
      let local = WorkerInstallationFixture(.registered(serviceInstalled: true))
      let transport = deletionTransport(local)
      transport.results[.unpair] = .object(["confirmed": .bool(true)])
      let model = DesktopWorkerModel(
        resources: nil, transport: transport, preferences: preferences,
        inspectInstallation: { local.inspect() })
      model.coordinateRegistration(account: account)
      await eventually {
        !model.busy && model.failure?.code == "WORKER_DELETION_CONFIRMATION_REQUIRED"
      }
      for _ in 0..<10 { model.registrationChanged() }
      try await Task.sleep(for: .milliseconds(20))
      precondition(transport.calls.map(\.command) == [.status, .status, .unpair])
      await expectIssuance(http, count: 0)
    }
    // Each GUI crash boundary resumes the controller-owned deletion without another enrollment.
    for phase in ["unpair", "recover", "permission"] {
      let (account, http, preferences) = try await registrationAccount(allowed: true)
      await http.setAllowed(false)
      preferences.set(phase, forKey: "worker.deletedMachineCleanup")
      preferences.set(machine, forKey: "worker.deletedMachineTarget")
      preferences.set(true, forKey: "worker.deletedMachineObserved")
      let local = WorkerInstallationFixture(phase == "permission" ? .fresh : .unpaired)
      let transport = deletionTransport(local)
      let model = DesktopWorkerModel(
        resources: nil, transport: transport, preferences: preferences,
        inspectInstallation: { local.inspect() })
      model.coordinateRegistration(account: account)
      await eventually { model.registrationState == .waiting && !model.busy }
      precondition(
        transport.nonStatusCalls.map(\.command)
          == (phase == "unpair" ? [.unpair, .recover] : phase == "recover" ? [.recover] : []))
      precondition(preferences.object(forKey: "worker.deletedMachineCleanup") == nil)
      await expectIssuance(http, count: 0)
    }
    // A late approval read after sign-out cannot create a machine, and cleanup itself remains independent.
    do {
      let (account, http, preferences) = try await registrationAccount(allowed: true)
      await http.holdProfileRead()
      let local = WorkerInstallationFixture(.registered(serviceInstalled: true))
      let transport = deletionTransport(local)
      let model = DesktopWorkerModel(
        resources: nil, transport: transport, preferences: preferences,
        inspectInstallation: { local.inspect() })
      model.coordinateRegistration(account: account)
      await eventually { await http.isProfileBlocked() }
      precondition(
        model.isCriticalOperation && model.busy && account.workerRegistrationPermission == nil)
      await model.run(.start)
      precondition(!transport.calls.contains { $0.command == .start })
      await account.logout()
      await http.releaseProfileRead()
      await eventually { model.registrationState == .signedOut && !model.busy }
      await expectIssuance(http, count: 0)
      precondition(transport.nonStatusCalls.map(\.command) == [.unpair, .recover])
    }
    // An ordinary manually unpaired worker and an unknown deletion journal remain non-fresh.
    for state in [DesktopWorkerInstallation.unpaired, .deletionRecovery, .interrupted] {
      let (account, http, preferences) = try await registrationAccount(allowed: true)
      let transport = WorkerFixtureTransport()
      let model = DesktopWorkerModel(
        resources: nil, transport: transport, preferences: preferences,
        inspectInstallation: { state })
      model.coordinateRegistration(account: account)
      await eventually {
        model.registrationState
          == (state == .unpaired
            ? .unpaired : state == .deletionRecovery ? .deletingRegistration : .interrupted)
      }
      precondition(transport.calls.isEmpty)
      await expectIssuance(http, count: 0)
    }
    // A saved old target can never unpair a healthy replacement, regardless of cached approval.
    do {
      let (account, http, preferences) = try await registrationAccount(allowed: true)
      preferences.set("unpair", forKey: "worker.deletedMachineCleanup")
      preferences.set(machine, forKey: "worker.deletedMachineTarget")
      var replacement = checkedStatus()
      if case .object(var fields) = replacement {
        fields["machineId"] = .string("00000000-0000-4000-8000-000000000042")
        replacement = .object(fields)
      }
      let transport = WorkerFixtureTransport()
      transport.results[.status] = replacement
      let model = DesktopWorkerModel(
        resources: nil, transport: transport, preferences: preferences,
        inspectInstallation: { .registered(serviceInstalled: true) })
      model.coordinateRegistration(account: account)
      await eventually { !model.busy && model.registrationState == .registered }
      precondition(transport.nonStatusCalls.isEmpty)
      precondition(preferences.object(forKey: "worker.deletedMachineCleanup") == nil)
      await expectIssuance(http, count: 0)
    }
    // The controller rejects a replacement made after the status probe under its own lock.
    do {
      let (account, http, preferences) = try await registrationAccount(allowed: true)
      let local = WorkerInstallationFixture(.registered(serviceInstalled: true))
      let transport = deletionTransport(local)
      transport.executed = nil
      transport.commandErrors[.unpair] = DesktopWorkerFailure("WORKER_DELETION_TARGET_CHANGED")
      let model = DesktopWorkerModel(
        resources: nil, transport: transport, preferences: preferences,
        inspectInstallation: { local.inspect() })
      model.coordinateRegistration(account: account)
      await eventually { !model.busy && model.failure?.code == "WORKER_DELETION_TARGET_CHANGED" }
      precondition(local.inspect() == .registered(serviceInstalled: true))
      precondition(transport.nonStatusCalls.count == 1)
      precondition(
        transport.nonStatusCalls[0].parameters
          == .object([
            "force": .bool(false), "expected_machine_id": .string(machine),
            "deleted_only": .bool(true),
          ]))
      await expectIssuance(http, count: 0)
    }
    // Legitimate credential-first cleanup interruption requires a matching canonical deleted receipt.
    for canonical in [false, true] {
      let (account, http, preferences) = try await registrationAccount(allowed: true)
      await http.setAllowed(false)
      preferences.set("unpair", forKey: "worker.deletedMachineCleanup")
      preferences.set(machine, forKey: "worker.deletedMachineTarget")
      let local = WorkerInstallationFixture(.unpaired)
      let transport = deletionTransport(local)
      transport.results[.status] =
        canonical ? receiptStatus(configured: true) : checkedStatus("BACKEND_UNAVAILABLE")
      let partial = WorkerInstallationFixture(.deletionRecovery)
      transport.executed = { command, _ in
        if command == .unpair { partial.set(.unpaired) }
        if command == .recover { local.set(.fresh) }
      }
      let model = DesktopWorkerModel(
        resources: nil, transport: transport, preferences: preferences,
        inspectInstallation: {
          if partial.inspect() == .deletionRecovery {
            throw DesktopWorkerFailure("WORKER_LOCAL_STATE_UNSAFE")
          }
          return local.inspect()
        })
      model.coordinateRegistration(account: account)
      if canonical {
        await eventually { model.registrationState == .waiting && !model.busy }
        precondition(transport.nonStatusCalls.map(\.command) == [.unpair, .recover])
      } else {
        await eventually {
          !model.busy && model.failure?.code == "WORKER_DELETION_CONFIRMATION_REQUIRED"
        }
        precondition(transport.nonStatusCalls.isEmpty)
      }
      await expectIssuance(http, count: 0)
    }
    // A changed GUI account cannot authorize enrollment from a late old-owner approval read.
    do {
      let (account, http, preferences) = try await registrationAccount(allowed: true)
      await http.holdProfileRead()
      let local = WorkerInstallationFixture(.registered(serviceInstalled: true))
      let transport = deletionTransport(local)
      let model = DesktopWorkerModel(
        resources: nil, transport: transport, preferences: preferences,
        inspectInstallation: { local.inspect() })
      model.coordinateRegistration(account: account)
      await eventually { await http.isProfileBlocked() }
      let (nextAccount, nextHTTP, _) = try await registrationAccount(
        allowed: false, preferences: preferences, uid: "worker-new-owner")
      model.coordinateRegistration(account: nextAccount)
      await http.releaseProfileRead()
      await eventually { model.registrationState == .waiting && !model.busy }
      await expectIssuance(http, count: 0)
      await expectIssuance(nextHTTP, count: 0)
      precondition(nextAccount.workerRegistrationPermission == false)
    }
  }
  private static func installationPresenceChecks() throws {
    let home = FileManager.default.temporaryDirectory.appendingPathComponent(
      "worker-presence-\(UUID())")
    defer { try? FileManager.default.removeItem(at: home) }
    try FileManager.default.createDirectory(
      at: home, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    let root = home.appendingPathComponent("Library/Application Support/MusicMuteWorker")
    func check(_ expected: DesktopWorkerInstallation) throws {
      let actual = try DesktopWorkerInstallation.inspect(home: home)
      precondition(actual == expected)
    }
    func write(_ path: String) throws {
      let url = root.appendingPathComponent(path)
      try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700])
      try Data("fixture-not-a-real-secret".utf8).write(to: url)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    try check(.fresh)
    try write("state/transactions/install/enrollment.credential")
    try check(.interrupted)
    try FileManager.default.removeItem(
      at: root.appendingPathComponent("state/transactions/install/enrollment.credential"))
    try write("state/transactions/install/.enrollment-state.json")
    try check(.interrupted)
    try FileManager.default.removeItem(
      at: root.appendingPathComponent("state/transactions/install/.enrollment-state.json"))
    try write("config/runtime.json")
    try write("credentials/machine.credential")
    try check(.registered(serviceInstalled: false))
    try FileManager.default.createDirectory(
      at: root.appendingPathComponent("runtime"), withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    try FileManager.default.createSymbolicLink(
      atPath: root.appendingPathComponent("runtime/current").path,
      withDestinationPath: "releases/fixture.1")
    let agents = home.appendingPathComponent("Library/LaunchAgents")
    try FileManager.default.createDirectory(
      at: agents, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    try Data("fixture".utf8).write(to: agents.appendingPathComponent("com.musicmute.worker.plist"))
    try check(.registered(serviceInstalled: true))
    try FileManager.default.removeItem(at: root.appendingPathComponent("runtime/current"))
    try FileManager.default.createSymbolicLink(
      atPath: root.appendingPathComponent("runtime/current").path,
      withDestinationPath: "/private/foreign")
    rejects { _ = try DesktopWorkerInstallation.inspect(home: home) }
  }
  private static func deletionPresenceChecks() throws {
    let home = FileManager.default.temporaryDirectory.appendingPathComponent(
      "worker-deletion-presence-\(UUID())")
    defer { try? FileManager.default.removeItem(at: home) }
    let root = home.appendingPathComponent("Library/Application Support/MusicMuteWorker")
    let journal = root.appendingPathComponent("state/deleted-registration.json")
    try FileManager.default.createDirectory(
      at: journal.deletingLastPathComponent(), withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    var fields: [String: DesktopJSON] = [
      "schemaVersion": .number(1), "machineId": .string(machine),
      "confirmedAt": .string("2026-10-06T15:00:00.000Z"),
      "archiveId": .string("00000000-0000-4000-8000-000000000043"),
      "phase": .string("archiving"), "entries": .array([]),
    ]
    func write() throws {
      try JSONEncoder().encode(DesktopJSON.object(fields)).write(to: journal)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: journal.path)
    }
    try write()
    let interrupted = try DesktopWorkerInstallation.inspect(home: home)
    precondition(interrupted == .deletionRecovery)
    fields["phase"] = .string("complete")
    try write()
    let complete = try DesktopWorkerInstallation.inspect(home: home)
    precondition(complete == .fresh)
    fields["entries"] = .array([
      .object([
        "path": .string("config/runtime.json"), "dev": .number(1), "ino": .number(1),
        "directory": .bool(false),
      ])
    ])
    try write()
    rejects { _ = try DesktopWorkerInstallation.inspect(home: home) }
    fields["entries"] = .array([])
    fields["unexpected"] = .bool(true)
    try write()
    rejects { _ = try DesktopWorkerInstallation.inspect(home: home) }
    fields.removeValue(forKey: "unexpected")
    fields["phase"] = .string("unknown")
    try write()
    rejects { _ = try DesktopWorkerInstallation.inspect(home: home) }
  }
  @MainActor private static func processChecks() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "musicmute-worker-native-\(UUID())")
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(
      at: root.appendingPathComponent("runtime/runtime/node/bin"), withIntermediateDirectories: true
    )
    try FileManager.default.createDirectory(
      at: root.appendingPathComponent("worker"), withIntermediateDirectories: true)
    try Data("fixture".utf8).write(to: root.appendingPathComponent("worker/controller.js"))
    let node = root.appendingPathComponent("runtime/runtime/node/bin/node")
    let prefix = #"""
      #!/bin/sh
      IFS= read -r envelope
      id=$(printf '%s' "$envelope" | /usr/bin/sed -nE 's/.*"request_id":"([^"]+)".*/\1/p')
      """#
    func script(_ tail: String) throws {
      try Data((prefix + "\n" + tail + "\n").utf8).write(to: node)
      try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: node.path)
    }
    let result =
      #"printf '{"protocol_version":1,"request_id":"%s","type":"RESULT","payload":{"version":"fixture"}}\n' "$id""#
    let bridge = DesktopWorkerBridge(
      resources: root, support: root.appendingPathComponent("support"))
    try script(result)
    let cancelledProcess = DesktopWorkerProcess(
      resources: root, support: root.appendingPathComponent("cancelled-support"))
    let cancelledOpen = Task { @MainActor in
      try await cancelledProcess.open(
        command: .status, parameters: .object([:]), subscription: true,
        onFrame: { _ in preconditionFailure("Cancelled startup produced a frame") }, onEnd: { _ in }
      )
    }
    cancelledOpen.cancel()
    do {
      try await cancelledOpen.value
      preconditionFailure("Cancelled startup was accepted")
    } catch let failure as DesktopWorkerFailure {
      precondition(failure.code == "WORKER_OPERATION_CANCELLED")
    }
    await cancelledProcess.waitUntilClosed()
    precondition(!cancelledProcess.running)
    let success = try await bridge.execute(.versions, parameters: .object([:]), progress: { _ in })
    precondition(success["version"].string == "fixture")
    for tail in [
      result + "\nexit 1", result + "\n" + result, result + "\nprintf 'trailing'",
      #"printf '{"protocol_version":1,"request_id":"foreign","type":"RESULT","payload":{}}\n'"#,
    ] {
      try script(tail)
      do {
        _ = try await bridge.execute(.versions, parameters: .object([:]), progress: { _ in })
        preconditionFailure("Invalid disposable controller result accepted")
      } catch is DesktopWorkerFailure {}
    }
    try script("/usr/bin/head -c 4200000 /dev/zero")
    do {
      _ = try await bridge.execute(.versions, parameters: .object([:]), progress: { _ in })
      preconditionFailure("Unbounded disposable controller frame accepted")
    } catch let failure as DesktopWorkerFailure {
      precondition(failure.code == "WORKER_CONTROL_OUTPUT_LIMIT")
    }
    let payload = String(data: try JSONEncoder().encode(fixture), encoding: .utf8)!
    let checked = String(
      data: try JSONEncoder().encode(checkedStatus("WORKER_UNAUTHENTICATED", http: 401)),
      encoding: .utf8)!
    try script(
      """
      case "$envelope" in
        *'"type":"SUBSCRIBE"'*)
          printf '{"protocol_version":1,"request_id":"%s","type":"SNAPSHOT","payload":\(payload)}\\n' "$id"
          while IFS= read -r line; do :; done
          ;;
        *)
          printf '{"protocol_version":1,"request_id":"%s","type":"RESULT","payload":\(checked)}\\n' "$id"
          ;;
      esac
      """
    )
    var snapshots = 0
    var closed = false
    try await bridge.subscribe(
      .status, parameters: .object([:]),
      snapshot: { value in
        precondition(value == fixture)
        snapshots += 1
      },
      ended: { failure in
        precondition(failure == nil)
        closed = true
      })
    let deadline = ContinuousClock.now.advanced(by: .seconds(3))
    while snapshots == 0 && ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(10))
    }
    precondition(snapshots == 1 && !closed)
    var logSnapshots = 0
    var logsClosed = false
    try await bridge.subscribe(
      .logs, parameters: .object([:]),
      snapshot: { _ in logSnapshots += 1 },
      ended: { failure in
        precondition(failure == nil)
        logsClosed = true
      })
    var commandResult: DesktopJSON?
    var commandFailure: Error?
    let command = Task { @MainActor in
      do {
        commandResult = try await bridge.execute(
          .status, parameters: .object(["local": .bool(false)]), progress: { _ in })
      } catch { commandFailure = error }
    }
    let commandDeadline = ContinuousClock.now.advanced(by: .seconds(3))
    while commandResult == nil, commandFailure == nil, ContinuousClock.now < commandDeadline {
      try await Task.sleep(for: .milliseconds(10))
    }
    // Both subscriptions remain open: a completed COMMAND must never wait for their EOF.
    precondition(
      commandFailure == nil && commandResult == checkedStatus("WORKER_UNAUTHENTICATED", http: 401))
    precondition(snapshots == 1 && logSnapshots == 1 && !closed && !logsClosed)
    await command.value
    bridge.closeSubscriptions()
    await bridge.waitUntilSubscriptionsClose()
    precondition(closed && logsClosed)
  }
  @MainActor private static func renderUI(at destination: URL) throws {
    guard destination.isFileURL, destination.path.hasPrefix("/"), destination.path != "/" else {
      throw DesktopWorkerFailure("INVALID_REQUEST")
    }
    _ = NSApplication.shared
    NSApp.setActivationPolicy(.prohibited)
    try FileManager.default.createDirectory(
      at: destination, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    let previews: [(String, String, DesktopWorkerRegistrationState)] = [
      ("Overview", "overview", .registered), ("Worker setup", "setup", .registered),
      ("Jobs and logs", "jobs", .registered), ("Health and support", "health", .registered),
      ("Worker storage", "storage", .registered),
      ("Worker performance", "performance", .registered),
      ("Worker updates", "updates", .registered),
      ("Advanced worker actions", "advanced", .registered),
      ("Worker setup", "signed-out", .signedOut),
      ("Worker setup", "google-required", .googleRequired),
      ("Worker setup", "waiting", .waiting), ("Worker setup", "unavailable", .unavailable),
      ("Worker setup", "registering", .preparing), ("Worker setup", "preserved", .preserved),
      ("Worker setup", "interrupted", .interrupted), ("Worker setup", "removed", .removed),
      ("Worker setup", "prepare-required", .setupRequired),
      ("Overview", "authentication-rejected", .authenticationRejected),
      ("Worker setup", "deleted-cleanup", .deletingRegistration),
      ("Worker setup", "deleted-waiting", .waiting),
    ]
    for language in ["en", "ar"] {
      for (section, name, registration) in previews {
        let model = DesktopWorkerModel(
          resources: nil, fixture: true, preferences: privatePreferences())
        model.applyPreview(registration: registration, deleted: name == "deleted-waiting")
        let preview = DesktopWorkerView(worker: model, prepare: {}, initialSection: section)
          .environment(\.locale, Locale(identifier: language))
          .environment(\.layoutDirection, language == "ar" ? .rightToLeft : .leftToRight)
          .padding(24).frame(width: 1000, height: 1800, alignment: .topLeading).background(
            Brand.background
          )
          .tint(Brand.mint).accentColor(Brand.mint)
        let hosting = NSHostingView(rootView: preview)
        hosting.appearance = NSAppearance(named: .darkAqua)
        hosting.frame = NSRect(x: 0, y: 0, width: 1000, height: 1800)
        hosting.layoutSubtreeIfNeeded()
        guard let bitmap = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else {
          throw DesktopWorkerFailure("WORKER_UI_RENDER_FAILED")
        }
        hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
        guard let bytes = bitmap.representation(using: .png, properties: [:]), bytes.count > 10_000
        else {
          throw DesktopWorkerFailure("WORKER_UI_RENDER_FAILED")
        }
        try bytes.write(to: destination.appendingPathComponent("worker-\(language)-\(name).png"))
      }
    }
    print(
      "Rendered isolated Worker fixtures to \(destination.path); no app launched or service state changed"
    )
  }
  @MainActor static func main() async throws {
    defer {
      for domain in preferenceDomains {
        UserDefaults.standard.removePersistentDomain(forName: domain)
      }
    }
    if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--render-worker-ui" {
      try renderUI(at: URL(fileURLWithPath: CommandLine.arguments[2]))
      return
    }
    try await registrationChecks()
    try await deletionChecks()
    try deletionPresenceChecks()
    try installationPresenceChecks()
    let id = UUID().uuidString.lowercased()
    let parsed = try DesktopWorkerFrame.decode(frame("SNAPSHOT", id: id), requestID: id)
    precondition(parsed.kind == .snapshot && parsed.payload == fixture)
    let initialSnapshot = try DesktopWorkerSnapshot(fixture)
    precondition(initialSnapshot.installed)
    rejects {
      _ = try DesktopWorkerFrame.decode(frame("SNAPSHOT", id: UUID().uuidString), requestID: id)
    }
    rejects { _ = try DesktopWorkerFrame.decode(frame("unknown", id: id), requestID: id) }
    rejects {
      _ = try DesktopWorkerFrame.decode(frame("RESULT", id: id, payload: .array([])), requestID: id)
    }
    rejects {
      _ = try DesktopWorkerFrame.decode(Data(repeating: 32, count: 4_195_329), requestID: id)
    }
    rejects {
      _ = try DesktopWorkerFrame.decode(Data("{\"protocol_version\":1".utf8), requestID: id)
    }
    rejects { _ = try DesktopWorkerSnapshot(.object(["installed": .bool(true)])) }
    let safeError = try JSONEncoder().encode(
      DesktopJSON.object([
        "protocol_version": .number(1), "request_id": .string(id), "type": .string("ERROR"),
        "error_code": .string("BACKEND_UNAVAILABLE"),
      ]))
    let decodedError = try DesktopWorkerFrame.decode(safeError, requestID: id)
    precondition(decodedError.errorCode == "BACKEND_UNAVAILABLE")
    let unsafeError = try JSONEncoder().encode(
      DesktopJSON.object([
        "protocol_version": .number(1), "request_id": .string(id), "type": .string("ERROR"),
        "error_code": .string("private token https://secret.example/?password=hidden"),
      ]))
    rejects { _ = try DesktopWorkerFrame.decode(unsafeError, requestID: id) }
    precondition(DesktopWorkerFailure("private credential").code == "WORKER_OPERATION_FAILED")
    var fence = DesktopWorkerGeneration()
    let old = fence.advance()
    let current = fence.advance()
    precondition(!fence.accepts(old) && fence.accepts(current))
    precondition(DesktopWorkerCommand.allCases.count == 25)
    precondition(DesktopWorkerCommand.install.requiresConfirmation(.object([:])))
    precondition(DesktopWorkerCommand.adopt.requiresConfirmation(.object(["apply": .bool(true)])))
    precondition(DesktopWorkerCommand.adopt.isCritical(.object(["apply": .bool(true)])))
    precondition(!DesktopWorkerCommand.adopt.isCritical(.object([:])))
    precondition(!DesktopWorkerCommand.update.requiresConfirmation(.object(["check": .bool(true)])))
    precondition(DesktopWorkerCommand.cleanup.requiresConfirmation(.object(["apply": .bool(true)])))
    precondition(!DesktopWorkerCommand.cleanup.isCritical(.object([:])))
    precondition(DesktopWorkerCommand.uninstall.isCritical(.object(["purge": .bool(true)])))
    let projected = DesktopWorkerReport.rows(
      .object([
        "credential": .string("hidden-one"), "refreshToken": .string("hidden-two"),
        "nested": .object(["password": .string("hidden-three"), "stage": .string("separating")]),
      ]))
    precondition(projected.count == 1 && projected[0].value == "separating")
    let bounded = DesktopWorkerReport.rows(.array((0..<2000).map { .number(Double($0)) }))
    precondition(bounded.count == 1000)
    precondition(
      DesktopWorkerReport.projection(.array((0..<2000).map { .number(Double($0)) })).truncated)
    _ = try DesktopWorkerRequest(
      command: .install, parameters: .object(["label": .string(String(repeating: "م", count: 120))])
    )
    precondition(DesktopWorkerReport.label("jobId") == "Job ID")
    let resources = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("Resources")
    precondition(
      DesktopWorkerReport.localizedLabel(
        "Job ID · Stage", locale: Locale(identifier: "ar"), resources: resources)
        == "معرّف المهمة · المرحلة")
    precondition(!DesktopWorkerReport.projection(.object(["stage": .string("ready")])).truncated)

    rejects {
      _ = try DesktopWorkerRequest(
        command: .start, parameters: .object(["shell": .string("arbitrary")]))
    }
    rejects {
      _ = try DesktopWorkerRequest(command: .capacity, parameters: .object(["workers": .number(3)]))
    }
    rejects {
      _ = try DesktopWorkerRequest(
        command: .benchmarkFile, parameters: .object(["input": .string("relative/song.mp3")]))
    }
    rejects {
      _ = try DesktopWorkerRequest(command: .logs, parameters: .object(["since": .string("1h")]))
    }
    rejects {
      _ = try DesktopWorkerRequest(
        command: .logs, parameters: .object(["clear": .bool(true)]), subscription: true)
    }
    rejects {
      _ = try DesktopWorkerRequest(
        command: .update, parameters: .object(["check": .bool(true), "force": .bool(true)]))
    }
    rejects {
      _ = try DesktopWorkerRequest(
        command: .install, parameters: .object(["label": .string("bad\nlabel")]))
    }
    _ = try DesktopWorkerRequest(
      command: .unpair,
      parameters: .object([
        "force": .bool(false), "expected_machine_id": .string(machine), "deleted_only": .bool(true),
      ]))
    for fields: [String: DesktopJSON] in [
      ["expected_machine_id": .string(machine)],
      ["deleted_only": .bool(true)],
      ["expected_machine_id": .string(machine), "deleted_only": .bool(false)],
      ["expected_machine_id": .string(machine), "deleted_only": .bool(true), "force": .bool(true)],
    ] {
      rejects { _ = try DesktopWorkerRequest(command: .unpair, parameters: .object(fields)) }
    }
    _ = try DesktopWorkerRequest(
      command: .update, parameters: .object(["source": .string("catalog"), "check": .bool(true)]))
    rejects {
      _ = try DesktopWorkerRequest(
        command: .update, parameters: .object(["source": .string("unknown")]))
    }
    _ = try DesktopWorkerRequest(
      command: .install,
      parameters: .object(["label": .string("Mac"), "group_id": .string("existing-group")]))
    _ = try DesktopWorkerRequest(
      command: .logs, parameters: .object(["events": .bool(true), "since": .string("30d")]),
      subscription: true)
    _ = try DesktopWorkerRequest(
      command: .benchmarkFile,
      parameters: .object([
        "input": .string("/tmp/synthetic.mp3"), "runs": .number(3), "group_size": .number(2),
      ]))
    precondition(!DesktopWorkerRequest.validSince("31d") && DesktopWorkerRequest.validSince("1s"))
    let transport = WorkerFixtureTransport()
    let model = DesktopWorkerModel(
      resources: nil, transport: transport, preferences: privatePreferences())
    model.show()
    await Task.yield()
    await Task.yield()
    precondition(transport.subscribers.count == 1)
    transport.subscribers[0](fixture)
    precondition(model.connected && model.snapshot?.phase == "ready")
    model.hide()
    precondition(!model.connected && transport.closes == 1)
    transport.subscribers[0](fixture)
    precondition(!model.connected)  // Late predecessor frames cannot reconnect the UI.
    model.show()
    await Task.yield()
    await Task.yield()
    transport.endings[0](DesktopWorkerFailure("SUBSCRIPTION_FAILED"))
    precondition(model.failure == nil)
    transport.subscribers[1](fixture)
    precondition(model.connected)
    await model.run(.cleanup, parameters: .object(["apply": .bool(true)]))
    precondition(model.failure?.code == "WORKER_CONFIRMATION_REQUIRED")
    precondition(!transport.calls.contains { $0.command == .cleanup })
    await model.run(.cleanup, parameters: .object(["apply": .bool(true)]), confirmed: true)
    precondition(
      transport.calls.last?.command == .cleanup
        && transport.calls.last?.parameters["apply"].bool == true)
    precondition(model.reportCommand == .cleanup && !model.busy)
    for force in [false, true] {
      let parameters = DesktopJSON.object(["source": .string("catalog"), "force": .bool(force)])
      let beforeConfirmation = transport.calls.count
      await model.run(.update, parameters: parameters)
      precondition(
        transport.calls.count == beforeConfirmation
          && model.failure?.code == "WORKER_CONFIRMATION_REQUIRED")
      await model.run(.update, parameters: parameters, confirmed: true)
      precondition(
        transport.calls.last?.command == .update
          && transport.calls.last?.parameters == parameters
          && model.reportCommand == .update && !model.busy)
    }
    transport.error = DesktopWorkerFailure("BACKEND_UNAVAILABLE")
    await model.run(.status)
    precondition(model.failure?.code == "BACKEND_UNAVAILABLE" && !model.busy)
    transport.error = nil
    let beforeInvalid = transport.calls.count
    await model.run(.job, parameters: .object(["job_id": .string("invalid")]))
    precondition(transport.calls.count == beforeInvalid && model.failure?.code == "INVALID_REQUEST")
    model.canOperate = { false }
    await model.run(.start)
    precondition(model.failure?.code == "WORKER_OPERATION_BUSY")
    model.canOperate = { true }
    transport.hold = true
    let operation = Task { await model.run(.drain) }
    await Task.yield()
    await Task.yield()
    precondition(model.busy && model.isCriticalOperation && model.currentCommand == .drain)
    let count = transport.calls.count
    await model.run(.start)
    // A reentrant action cannot replace a critical operation.
    precondition(transport.calls.count == count)
    model.hide()
    // GUI disconnect never cancels the command/service.
    precondition(model.busy && model.isCriticalOperation)
    transport.gate?.resume()
    transport.gate = nil
    await operation.value
    precondition(!model.busy && !model.isCriticalOperation)
    let preview = DesktopWorkerModel(
      resources: nil, fixture: true, transport: transport, preferences: privatePreferences())
    preview.show()
    await preview.run(.start)
    precondition(transport.calls.count == count)
    let unavailable = DesktopWorkerProcess(resources: nil)
    do {
      try await unavailable.open(
        command: .status, parameters: .object([:]), subscription: true,
        onFrame: { _ in preconditionFailure("Missing runtime launched controller") },
        onEnd: { _ in })
      preconditionFailure("Missing resources accepted")
    } catch let failure as DesktopWorkerFailure {
      precondition(failure.code == "WORKER_RUNTIME_UNAVAILABLE" && !unavailable.running)
    }
    try await processChecks()
    print(
      "Worker native protocol/model fixtures passed: decoding, bounds, safe errors, confirmation, generation fencing, missing runtime and independent subscription shutdown"
    )
  }
}
