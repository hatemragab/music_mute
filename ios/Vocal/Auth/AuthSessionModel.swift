import Combine
import Foundation

enum AuthPhase: Equatable {
  case restoring
  case signedOut
  case authenticating
  case bootstrapping
  case recoveryRequired
  case authenticated
  case blocked
}

@MainActor final class AuthSessionModel: ObservableObject {
  private struct SessionTicket {
    let generation: Int
    let uid: String
  }

  @Published private(set) var phase: AuthPhase = .restoring
  @Published private(set) var identity: IdentitySnapshot?
  @Published private(set) var profile: AccountProfile?
  @Published private(set) var policy: AppPolicy?
  @Published private(set) var access: ProcessingAccess?
  @Published private(set) var currentInstallationID: String?
  @Published private(set) var currentDevice: RegisteredDevice?
  @Published private(set) var devices: [RegisteredDevice] = []
  @Published private(set) var devicesNextCursor: String?
  @Published private(set) var isOffline = false
  @Published private(set) var isBusy = false
  @Published private(set) var isLoadingDevices = false
  @Published private(set) var profileSyncPending = false
  @Published private(set) var lastFailure: AuthFailure?
  @Published private(set) var mailOutcome: MailOutcome?
  @Published private(set) var recoveryAccepted = false
  @Published private(set) var verificationCooldownUntil: Date?
  @Published private(set) var resetCooldownUntil: Date?
  @Published private(set) var logoutAllUncertain = false
  @Published private(set) var accountRecovery: AccountRecoveryStatus?

  @Published private(set) var deletionReceipt: AccountDeletionReceipt?
  @Published private(set) var deletionUncertain = false
  var purgeAccountData: @MainActor (String) async throws -> Void = { _ in }
  private let deletionStore: AccountDeletionStore
  private let deletionRequest: (@MainActor () async throws -> AccountDeletionReceipt)?
  private var deletingAccount = false

  private let firebase: FirebaseAuthenticating
  private let apple: AppleCredentialProvider
  private let installationStore: InstallationStore
  private let api: AuthAPIClient?
  private var observer: NSObjectProtocol?
  private var generation = 0
  private var started = false
  private var foregroundTask: Task<Void, Never>?
  private var signOutCleanup: Task<Void, Never>?
  private let beforeSignOut: @MainActor (String, String?) async -> Void

  init(
    firebase: FirebaseAuthenticating, apple: AppleCredentialProvider,
    installationStore: InstallationStore, api: AuthAPIClient?,
    deletionStore: AccountDeletionStore = AccountDeletionStore(),
    deletionRequest: (@MainActor () async throws -> AccountDeletionReceipt)? = nil,
    beforeSignOut: @escaping @MainActor (String, String?) async -> Void = { _, _ in }
  ) {
    self.firebase = firebase
    self.apple = apple
    self.installationStore = installationStore
    self.api = api
    self.beforeSignOut = beforeSignOut
    self.deletionStore = deletionStore
    self.deletionRequest = deletionRequest
  }

  func start() {
    guard !started else { return }
    started = true
    apple.observeRevocation { [weak self] in self?.handleAppleRevocation() }
    Task { [weak self] in
      guard let self else { return }
      do {
        for pending in try await self.deletionStore.allPending()
        where pending.needsReauthentication != true {
          if pending.localOnly != true {
            self.deletionReceipt = pending.receipt
            self.deletionUncertain = pending.receipt == nil
          }
          if self.firebase.identity?.uid == pending.uid {
            await self.localSignOut(clearBootstrap: true)
          }
          try await self.purgeAccountData(pending.uid)
          if pending.receipt != nil || pending.localOnly == true {
            try await self.deletionStore.clear(pending.uid)
          }
        }
      } catch {
        self.applyFailure(error)
        self.phase = .blocked
        return
      }
      if self.firebase.identity != nil { self.phase = .restoring }
      self.observer = self.firebase.observe { [weak self] identity in
        self?.identityDidChange(identity)
      }
    }
  }

  func signInEmail(email: String, password: String) async {
    await authenticate { _ in try await self.firebase.signIn(email: email, password: password) }
  }

  func registerEmail(email: String, password: String, confirmation: String) async {
    guard password == confirmation else {
      lastFailure = .invalidInput
      return
    }
    await authenticate { _ in try await self.firebase.register(email: email, password: password) }
  }

  func signInApple() async {
    await authenticate { actionGeneration in
      let credential = try await self.apple.authorize()
      guard self.generation == actionGeneration else { throw AuthFailure.cancelled }
      return try await self.firebase.signIn(apple: credential)
    }
  }

  func retryBootstrap() async {
    guard let identity = firebase.identity, !isBusy else { return }
    let actionGeneration = generation
    isBusy = true
    phase = .bootstrapping
    lastFailure = nil
    await bootstrap(identity, allowOffline: false, generation: actionGeneration)
    if generation == actionGeneration { isBusy = false }
  }

  func requestAccountRecovery(reason: String?) async {
    guard phase == .recoveryRequired, !isBusy, let ticket = sessionTicket() else { return }
    isBusy = true
    lastFailure = nil
    defer { if isCurrent(ticket) { isBusy = false } }
    do {
      guard let api else { throw AuthFailure.configuration }
      let request = try await api.requestAccountRecovery(reason: reason)
      try validate(ticket)
      if let current = accountRecovery {
        accountRecovery = AccountRecoveryStatus(
          accountStatus: current.accountStatus, deletion: current.deletion, request: request)
      }
    } catch {
      guard isCurrent(ticket) else { return }
      applyFailure(error)
      await closeGateIfSessionInvalid()
    }
  }

  func refreshAccountRecovery() async {
    guard phase == .recoveryRequired, !isBusy, let ticket = sessionTicket() else { return }
    isBusy = true
    lastFailure = nil
    defer { if isCurrent(ticket) { isBusy = false } }
    do {
      guard let api else { throw AuthFailure.configuration }
      let recovery = try await api.accountRecovery()
      try validate(ticket)
      accountRecovery = recovery
      if recovery.accountStatus == "active" || recovery.request?.status == "approved" {
        guard let current = firebase.identity else { throw AuthFailure.sessionExpired }
        await bootstrap(current, allowOffline: false, generation: ticket.generation)
      }
    } catch {
      guard isCurrent(ticket) else { return }
      applyFailure(error)
      await closeGateIfSessionInvalid()
    }
  }

  func requestPasswordReset(email: String) async {
    if let resetCooldownUntil, resetCooldownUntil > Date() {
      lastFailure = .rateLimited(retryAt: resetCooldownUntil)
      return
    }
    guard !isBusy, email.count <= 254, email.contains("@") else {
      lastFailure = .invalidInput
      return
    }
    isBusy = true
    lastFailure = nil
    recoveryAccepted = false
    defer { isBusy = false }
    do {
      guard let api else { throw AuthFailure.configuration }
      mailOutcome = try await api.requestPasswordReset(email: email)
      recoveryAccepted = true
      resetCooldownUntil = Date().addingTimeInterval(60)
    } catch {
      applyFailure(error)
      if case .rateLimited(let retryAt) = lastFailure { resetCooldownUntil = retryAt }
    }
  }

  func requestVerification() async {
    if let verificationCooldownUntil, verificationCooldownUntil > Date() {
      lastFailure = .rateLimited(retryAt: verificationCooldownUntil)
      return
    }
    guard phase == .authenticated, !isBusy else { return }
    guard let ticket = sessionTicket() else {
      await localSignOut(clearBootstrap: true)
      return
    }
    isBusy = true
    lastFailure = nil
    defer { if isCurrent(ticket) { isBusy = false } }
    do {
      guard let api else { throw AuthFailure.configuration }
      let outcome = try await api.requestVerification()
      try validate(ticket)
      mailOutcome = outcome
      verificationCooldownUntil = Date().addingTimeInterval(60)
    } catch {
      guard isCurrent(ticket) else { return }
      applyFailure(error)
      if case .rateLimited(let retryAt) = lastFailure { verificationCooldownUntil = retryAt }
      await closeGateIfSessionInvalid()
    }
  }

  func refreshAccount() async {
    guard phase == .authenticated, !isBusy else { return }
    guard let ticket = sessionTicket() else {
      await localSignOut(clearBootstrap: true)
      return
    }
    isBusy = true
    lastFailure = nil
    defer { if isCurrent(ticket) { isBusy = false } }
    do {
      let refreshed = try await firebase.reload()
      try validate(ticket, resultUID: refreshed.uid)
      _ = try await firebase.idToken(forceRefresh: true)
      try validate(ticket)
      guard let api else { throw AuthFailure.configuration }
      let result = try await api.profileSync()
      try validate(ticket)
      identity = refreshed
      profile = result.user
      policy = result.policy
      access = nil
      profileSyncPending = false
      isOffline = false
      mailOutcome = nil
      await bootstrap(
        refreshed, allowOffline: false, preserveAuthenticatedOnFailure: true,
        generation: ticket.generation)
    } catch {
      guard isCurrent(ticket) else { return }
      profileSyncPending = true
      access = nil
      applyFailure(error)
      await closeGateIfSessionInvalid()
    }
  }

  func validateOnForeground() {
    guard phase == .authenticated, foregroundTask == nil else { return }
    foregroundTask = Task { [weak self] in
      guard let self else { return }
      if self.mailOutcome == .accepted, self.profile?.emailVerified != true {
        await self.refreshAccount()
      } else {
        await self.validateRestoredSession()
      }
      self.foregroundTask = nil
    }
  }

  func loadDevices(reset: Bool = false) async {
    guard phase == .authenticated, !isLoadingDevices else { return }
    guard let ticket = sessionTicket() else {
      await localSignOut(clearBootstrap: true)
      return
    }
    let cursor = reset ? nil : devicesNextCursor
    if !reset, !devices.isEmpty, cursor == nil { return }
    isLoadingDevices = true
    if reset {
      devices = []
      devicesNextCursor = nil
    }
    lastFailure = nil
    defer { if isCurrent(ticket) { isLoadingDevices = false } }
    do {
      guard let api else { throw AuthFailure.configuration }
      var page: DevicePage
      do {
        page = try await api.devices(limit: 20, before: cursor)
        try validate(ticket)
      } catch AuthFailure.profileSyncRequired {
        try validate(ticket)
        guard let current = firebase.identity else { throw AuthFailure.sessionExpired }
        await bootstrap(current, allowOffline: false, generation: ticket.generation)
        guard phase == .authenticated, isCurrent(ticket) else { return }
        page = try await api.devices(limit: 20, before: cursor)
        try validate(ticket)
      }
      let existing = Set(devices.map(\.installationId))
      devices.append(contentsOf: page.items.filter { !existing.contains($0.installationId) })
      if let currentDevice,
        !devices.contains(where: { $0.installationId == currentDevice.installationId })
      {
        devices.insert(currentDevice, at: 0)
      }
      devicesNextCursor = page.nextCursor
    } catch {
      guard isCurrent(ticket) else { return }
      applyFailure(error)
      await closeGateIfSessionInvalid()
    }
  }

  func removeDeviceHistory(_ device: RegisteredDevice) async {
    guard phase == .authenticated, !isBusy, !isLoadingDevices,
      device.installationId != currentInstallationID, let ticket = sessionTicket()
    else { return }
    isLoadingDevices = true
    lastFailure = nil
    defer { if isCurrent(ticket) { isLoadingDevices = false } }
    do {
      guard let api else { throw AuthFailure.configuration }
      try await api.removeDeviceHistory(id: device.installationId)
      try validate(ticket)
      devices.removeAll { $0.installationId == device.installationId }
    } catch {
      guard isCurrent(ticket) else { return }
      applyFailure(error)
      await closeGateIfSessionInvalid()
    }
  }

  func linkPassword(password: String) async {
    await mutateAccount { ticket in
      let identity = try self.requireIdentity()
      guard identity.providers.contains(.apple), !identity.providers.contains(.password) else {
        throw AuthFailure.providerAlreadyLinked
      }
      let appleCredential = try await self.apple.authorize()
      try self.validate(ticket)
      try await self.firebase.reauthenticateApple(appleCredential)
      try self.validate(ticket)
      _ = try await self.firebase.linkPassword(password)
      try self.validate(ticket)
    }
  }

  func linkApple(password: String) async {
    await mutateAccount { ticket in
      let identity = try self.requireIdentity()
      guard identity.providers.contains(.password), !identity.providers.contains(.apple) else {
        throw AuthFailure.providerAlreadyLinked
      }
      try await self.firebase.reauthenticatePassword(password)
      try self.validate(ticket)
      let appleCredential = try await self.apple.authorize()
      try self.validate(ticket)
      _ = try await self.firebase.linkApple(appleCredential)
      try self.validate(ticket)
    }
  }

  func unlink(_ provider: ProviderID, password: String = "") async {
    await mutateAccount { ticket in
      let refreshed = try await self.firebase.reload()
      try self.validate(ticket, resultUID: refreshed.uid)
      self.identity = refreshed
      let remaining = refreshed.providers.subtracting([provider]).filter(\.isUsableOnIOS)
      guard refreshed.providers.contains(provider), !remaining.isEmpty else {
        throw AuthFailure.providerMissing
      }
      if remaining.contains(.password) {
        try await self.firebase.reauthenticatePassword(password)
        try self.validate(ticket)
      } else if remaining.contains(.apple) {
        let credential = try await self.apple.authorize()
        try self.validate(ticket)
        try await self.firebase.reauthenticateApple(credential)
        try self.validate(ticket)
      } else {
        throw AuthFailure.providerMissing
      }
      _ = try await self.firebase.unlink(provider)
      try self.validate(ticket)
    }
  }

  func deleteAccount(password: String = "") async {
    guard !isBusy, let ticket = sessionTicket() else { return }
    isBusy = true
    deletingAccount = true
    lastFailure = nil
    defer {
      deletingAccount = false
      if isCurrent(ticket) { isBusy = false }
    }
    var requestStarted = false
    var previousPending: AccountDeletionStore.Pending?
    do {
      previousPending = try await deletionStore.pending(ticket.uid)
      try validate(ticket)
      if let receipt = previousPending?.receipt {
        deletionReceipt = receipt
        deletionUncertain = false
        await localSignOut(clearBootstrap: true)
        try await purgeAccountData(ticket.uid)
        try await deletionStore.clear(ticket.uid)
        return
      }
      guard api != nil || deletionRequest != nil else { throw AuthFailure.configuration }
      if identity?.providers.contains(.apple) == true {
        let credential = try await apple.authorize()
        try validate(ticket)
        try await firebase.reauthenticateApple(credential)
        try validate(ticket)
        guard let code = credential.authorizationCode, !code.isEmpty else {
          throw AuthFailure.invalidCredentials
        }
        try await firebase.revokeAppleToken(code)
      } else {
        try await firebase.reauthenticatePassword(password)
      }
      try validate(ticket)
      try await deletionStore.save(.init(uid: ticket.uid))
      try validate(ticket)
      requestStarted = true
      let receipt: AccountDeletionReceipt
      if let deletionRequest {
        receipt = try await deletionRequest()
      } else if let api {
        receipt = try await api.deleteAccount()
      } else {
        throw AuthFailure.configuration
      }
      // Persist the deleting account's receipt even if another identity replaced it while HTTP was in flight.
      try await deletionStore.save(.init(uid: ticket.uid, receipt: receipt))
      if isCurrent(ticket) {
        deletionReceipt = receipt
        deletionUncertain = false
        await localSignOut(clearBootstrap: true)
      }
      try await purgeAccountData(ticket.uid)
      try await deletionStore.clear(ticket.uid)
    } catch {
      guard isCurrent(ticket) || (phase == .signedOut && identity == nil) else { return }
      applyFailure(error)
      if !requestStarted && (lastFailure == .sessionExpired || lastFailure == .accountDisabled) {
        await discardRevokedSessionData(uid: ticket.uid)
      }
      let definitelyRejected: Bool
      switch lastFailure {
      case .recentLoginRequired, .invalidInput, .rateLimited: definitelyRejected = true
      default: definitelyRejected = false
      }
      if requestStarted && definitelyRejected {
        if let previousPending, previousPending.localOnly != true,
          previousPending.needsReauthentication != true
        {
          try? await deletionStore.save(previousPending)
          deletionUncertain = previousPending.receipt == nil
          access = nil
          phase = .blocked
        } else {
          try? await deletionStore.save(.init(uid: ticket.uid, needsReauthentication: true))
        }
      }
      if requestStarted && !definitelyRejected {
        deletionUncertain = deletionReceipt == nil
        await localSignOut(clearBootstrap: true)
        do { try await purgeAccountData(ticket.uid) } catch { applyFailure(error) }
      }
    }
  }

  func signOut() async {
    await localSignOut(clearBootstrap: true)
  }

  func logoutAll() async {
    guard phase == .authenticated, !isBusy else { return }
    guard let ticket = sessionTicket() else {
      await localSignOut(clearBootstrap: true)
      return
    }
    isBusy = true
    logoutAllUncertain = false
    do {
      guard let api else { throw AuthFailure.configuration }
      try await api.logoutAll()
      try validate(ticket)
    } catch {
      guard isCurrent(ticket) else { return }
      logoutAllUncertain = true
      applyFailure(error)
    }
    guard isCurrent(ticket) else { return }
    await localSignOut(clearBootstrap: true)
  }

  private func authenticate(
    _ action: @escaping @MainActor (Int) async throws -> IdentitySnapshot
  ) async {
    if let cleanup = signOutCleanup { await cleanup.value }
    guard !isBusy else { return }
    generation += 1
    let actionGeneration = generation
    isBusy = true
    phase = .authenticating
    lastFailure = nil
    recoveryAccepted = false
    do {
      let authenticated = try await action(actionGeneration)
      guard generation == actionGeneration, firebase.identity?.uid == authenticated.uid else {
        return
      }
      identity = authenticated
      phase = .bootstrapping
      await bootstrap(authenticated, allowOffline: false, generation: actionGeneration)
    } catch {
      guard generation == actionGeneration else { return }
      applyFailure(error)
      if lastFailure != .cancelled { phase = .signedOut } else { phase = .signedOut }
    }
    if generation == actionGeneration { isBusy = false }
  }

  private func bootstrap(
    _ expected: IdentitySnapshot, allowOffline: Bool,
    preserveAuthenticatedOnFailure: Bool = false, generation actionGeneration: Int
  ) async {
    do {
      if let pending = try await deletionStore.pending(expected.uid),
        pending.needsReauthentication != true
      {
        guard isCurrent(actionGeneration, uid: expected.uid) else { return }
        identity = expected
        deletionReceipt = pending.receipt
        deletionUncertain = pending.receipt == nil
        access = nil
        phase = .blocked
        lastFailure = .serviceUnavailable
        return
      }
      guard let api else { throw AuthFailure.configuration }
      let metadata = try InstallationStore.currentMetadata()
      var report = try await installationStore.report(currentMetadata: metadata)
      guard isCurrent(actionGeneration, uid: expected.uid) else { return }
      currentInstallationID = report.installationId
      let result: SessionResponse
      do {
        result = try await api.bootstrap(report)
        guard isCurrent(actionGeneration, uid: expected.uid) else { return }
      } catch AuthFailure.deviceConflict {
        guard isCurrent(actionGeneration, uid: expected.uid) else { return }
        guard
          let registered = try await findCurrentInstallation(
            report.installationId, generation: actionGeneration, uid: expected.uid)
        else {
          throw AuthFailure.deviceConflict
        }
        report = try await installationStore.reconcile(serverDevice: registered)
        guard isCurrent(actionGeneration, uid: expected.uid) else { return }
        result = try await api.bootstrap(report)
        guard isCurrent(actionGeneration, uid: expected.uid) else { return }
      }
      try await installationStore.markSuccessfulBootstrap(uid: expected.uid)
      guard isCurrent(actionGeneration, uid: expected.uid) else { return }
      identity = expected
      profile = result.user
      policy = result.policy
      access = result.access
      currentInstallationID = result.device.installationId
      currentDevice = result.device
      isOffline = false
      profileSyncPending = false
      accountRecovery = nil
      lastFailure = nil
      phase = .authenticated
    } catch AuthFailure.accountDeletionPending {
      guard isCurrent(actionGeneration, uid: expected.uid) else { return }
      do {
        guard let api else { throw AuthFailure.configuration }
        accountRecovery = try await api.accountRecovery()
        guard isCurrent(actionGeneration, uid: expected.uid) else { return }
        identity = expected
        profile = nil
        policy = nil
        access = nil
        isOffline = false
        profileSyncPending = false
        lastFailure = nil
        phase = .recoveryRequired
      } catch {
        guard isCurrent(actionGeneration, uid: expected.uid) else { return }
        applyFailure(error)
        phase = .blocked
        await closeGateIfSessionInvalid()
      }
    } catch AuthFailure.offline where allowOffline {
      let cachedUID = try? await installationStore.successfulBootstrapUID()
      guard isCurrent(actionGeneration, uid: expected.uid) else { return }
      guard cachedUID == expected.uid else {
        lastFailure = .offline
        phase = .blocked
        return
      }
      identity = expected
      profile = offlineProfile(expected)
      policy = nil
      access = nil
      isOffline = true
      profileSyncPending = true
      lastFailure = .offline
      phase = .authenticated
    } catch {
      guard isCurrent(actionGeneration, uid: expected.uid) else { return }
      applyFailure(error)
      if preserveAuthenticatedOnFailure,
        lastFailure != .sessionExpired, lastFailure != .accountDisabled
      {
        access = nil
        isOffline = lastFailure == .offline
        profileSyncPending = true
        phase = .authenticated
      } else {
        phase = .blocked
        await closeGateIfSessionInvalid()
      }
    }
  }

  private func validateRestoredSession() async {
    guard let expected = firebase.identity else {
      await localSignOut(clearBootstrap: true)
      return
    }
    let actionGeneration = generation
    do {
      guard let api else { throw AuthFailure.configuration }
      let account = try await api.me()
      guard isCurrent(actionGeneration, uid: expected.uid) else { return }
      identity = expected
      profile = account
      access = nil
      isOffline = false
      lastFailure = nil
    } catch AuthFailure.offline {
      guard isCurrent(actionGeneration, uid: expected.uid) else { return }
      isOffline = true
      lastFailure = .offline
    } catch AuthFailure.profileSyncRequired {
      guard isCurrent(actionGeneration, uid: expected.uid) else { return }
      await bootstrap(expected, allowOffline: false, generation: actionGeneration)
    } catch {
      guard isCurrent(actionGeneration, uid: expected.uid) else { return }
      applyFailure(error)
      await closeGateIfSessionInvalid()
    }
  }

  private func mutateAccount(
    _ action: @escaping @MainActor (SessionTicket) async throws -> Void
  ) async {
    guard phase == .authenticated, !isBusy else { return }
    guard let ticket = sessionTicket() else {
      await localSignOut(clearBootstrap: true)
      return
    }
    isBusy = true
    lastFailure = nil
    defer { if isCurrent(ticket) { isBusy = false } }
    do {
      try await action(ticket)
      try validate(ticket)
      let refreshed = try await firebase.reload()
      try validate(ticket, resultUID: refreshed.uid)
      _ = try await firebase.idToken(forceRefresh: true)
      try validate(ticket)
      identity = refreshed
      access = nil
      if let current = profile {
        profile = AccountProfile(
          id: current.id, displayName: current.displayName, email: current.email,
          emailVerified: refreshed.emailVerified,
          providers: refreshed.providers.sorted { $0.rawValue < $1.rawValue })
      }
      do {
        guard let api else { throw AuthFailure.configuration }
        let synced = try await api.profileSync()
        try validate(ticket)
        profile = synced.user
        policy = synced.policy
        access = nil
        profileSyncPending = false
      } catch {
        guard isCurrent(ticket) else { return }
        profileSyncPending = true
        access = nil
        applyFailure(error)
        await closeGateIfSessionInvalid()
      }
    } catch {
      guard isCurrent(ticket) else { return }
      applyFailure(error)
      await closeGateIfSessionInvalid()
    }
  }

  private func findCurrentInstallation(
    _ id: String, generation actionGeneration: Int, uid: String
  ) async throws -> RegisteredDevice? {
    guard let api else { throw AuthFailure.configuration }
    var cursor: String?
    for _ in 0..<5 {
      let page = try await api.devices(limit: 50, before: cursor)
      guard isCurrent(actionGeneration, uid: uid) else { throw AuthFailure.cancelled }
      if let match = page.items.first(where: { $0.installationId == id }) { return match }
      guard let next = page.nextCursor, next != cursor else { return nil }
      cursor = next
    }
    return nil
  }

  private func identityDidChange(_ newIdentity: IdentitySnapshot?) {
    switch (phase, newIdentity) {
    case (.restoring, .none):
      identity = nil
      phase = .signedOut
    case (.restoring, .some(let restored)):
      identity = restored
      generation += 1
      let actionGeneration = generation
      phase = .bootstrapping
      isBusy = true
      Task { [weak self] in
        guard let self else { return }
        if let pending = try? await self.deletionStore.pending(restored.uid),
          pending.needsReauthentication != true
        {
          self.deletionReceipt = pending.receipt
          self.deletionUncertain = pending.receipt == nil
          await self.localSignOut(clearBootstrap: true)
          do { try await self.purgeAccountData(restored.uid) } catch { self.applyFailure(error) }
          return
        }
        let cachedUID = try? await self.installationStore.successfulBootstrapUID()
        guard self.isCurrent(actionGeneration, uid: restored.uid) else { return }
        guard cachedUID == restored.uid else {
          await self.localSignOut(clearBootstrap: true)
          return
        }
        guard await self.appleCredentialRemainsValid(restored) else {
          guard self.isCurrent(actionGeneration, uid: restored.uid) else { return }
          await self.discardRevokedSessionData(uid: restored.uid)
          return
        }
        guard self.isCurrent(actionGeneration, uid: restored.uid) else { return }
        await self.bootstrap(restored, allowOffline: true, generation: actionGeneration)
        if self.generation == actionGeneration { self.isBusy = false }
      }
    case (.authenticated, .none), (.recoveryRequired, .none):
      let oldUID = identity?.uid
      let observedGeneration = generation
      Task { [weak self] in
        guard let self, self.generation == observedGeneration, self.firebase.identity == nil else {
          return
        }
        await self.discardRevokedSessionData(uid: oldUID)
      }
    case (.authenticated, .some(let changed)),
      (.recoveryRequired, .some(let changed))
    where changed.uid != identity?.uid:
      generation += 1
      let actionGeneration = generation
      identity = changed
      profile = nil
      phase = .bootstrapping
      isBusy = true
      Task { [weak self] in
        guard let self else { return }
        guard self.isCurrent(actionGeneration, uid: changed.uid) else { return }
        guard await self.appleCredentialRemainsValid(changed) else {
          guard self.isCurrent(actionGeneration, uid: changed.uid) else { return }
          await self.localSignOut(clearBootstrap: true)
          return
        }
        guard self.isCurrent(actionGeneration, uid: changed.uid) else { return }
        await self.bootstrap(changed, allowOffline: true, generation: actionGeneration)
        if self.generation == actionGeneration { self.isBusy = false }
      }
    default:
      break
    }
  }

  private func localSignOut(clearBootstrap: Bool) async {
    if let cleanup = signOutCleanup {
      await cleanup.value
      return
    }
    let oldUID = identity?.uid ?? firebase.identity?.uid
    let oldInstallation = currentInstallationID
    generation += 1
    foregroundTask?.cancel()
    foregroundTask = nil
    phase = .signedOut
    identity = nil
    profile = nil
    policy = nil
    access = nil
    accountRecovery = nil
    devices = []
    devicesNextCursor = nil
    currentInstallationID = nil
    currentDevice = nil
    isOffline = false
    profileSyncPending = false
    isBusy = false
    isLoadingDevices = false
    mailOutcome = nil
    let cleanup = Task { @MainActor [self] in
      await performBoundedSignOutCleanup(
        before: {
          if let oldUID { await self.beforeSignOut(oldUID, oldInstallation) }
        }, clearIdentity: { try? self.firebase.signOut() })
      if clearBootstrap { try? await self.installationStore.clearSuccessfulBootstrap() }
    }
    signOutCleanup = cleanup
    await cleanup.value
    signOutCleanup = nil
  }

  private func discardRevokedSessionData(uid: String?) async {
    var preservesDeletionRequest = false
    if let uid {
      let previous = try? await deletionStore.pending(uid)
      preservesDeletionRequest =
        previous != nil && previous?.localOnly != true && previous?.needsReauthentication != true
      do { try await deletionStore.save(.init(uid: uid, localOnly: true)) } catch {
        applyFailure(error)
      }
    }
    await localSignOut(clearBootstrap: true)
    if let uid {
      do {
        try await purgeAccountData(uid)
        if !preservesDeletionRequest { try await deletionStore.clear(uid) }
      } catch { applyFailure(error) }
    }
  }

  private func closeGateIfSessionInvalid() async {
    guard lastFailure == .sessionExpired || lastFailure == .accountDisabled else { return }
    await discardRevokedSessionData(uid: identity?.uid)
  }

  private func handleAppleRevocation() {
    guard !deletingAccount, identity?.providers.contains(.apple) == true,
      let ticket = sessionTicket()
    else { return }
    lastFailure = .sessionExpired
    Task { [weak self] in
      guard let self, self.isCurrent(ticket) else { return }
      await self.discardRevokedSessionData(uid: ticket.uid)
    }
  }

  private func appleCredentialRemainsValid(_ identity: IdentitySnapshot) async -> Bool {
    guard identity.providers.contains(.apple), let appleUserID = firebase.appleProviderUserID else {
      return true
    }
    do {
      let state = try await apple.credentialState(userID: appleUserID)
      return state == .authorized
    } catch {
      // A state-query failure is not evidence that Apple revoked the credential.
      return true
    }
  }

  private func applyFailure(_ error: Error) {
    if let failure = error as? AuthFailure {
      lastFailure = failure
    } else if error is CancellationError {
      lastFailure = .cancelled
    } else {
      lastFailure = .unknown
    }
  }

  private func sessionTicket() -> SessionTicket? {
    guard let identity, firebase.identity?.uid == identity.uid else { return nil }
    return SessionTicket(generation: generation, uid: identity.uid)
  }

  private func isCurrent(_ ticket: SessionTicket) -> Bool {
    isCurrent(ticket.generation, uid: ticket.uid)
  }

  private func isCurrent(_ actionGeneration: Int, uid: String) -> Bool {
    generation == actionGeneration && firebase.identity?.uid == uid
  }

  private func validate(_ ticket: SessionTicket, resultUID: String? = nil) throws {
    guard isCurrent(ticket), resultUID == nil || resultUID == ticket.uid else {
      throw AuthFailure.cancelled
    }
  }

  private func requireIdentity() throws -> IdentitySnapshot {
    guard let identity, firebase.identity?.uid == identity.uid else {
      throw AuthFailure.sessionExpired
    }
    return identity
  }

  private func offlineProfile(_ identity: IdentitySnapshot) -> AccountProfile {
    let name = identity.email?.split(separator: "@").first.map(String.init) ?? "MusicMute"
    return AccountProfile(
      id: "", displayName: name, email: identity.email, emailVerified: identity.emailVerified,
      providers: identity.providers.sorted { $0.rawValue < $1.rawValue })
  }
}

/// Native URLSession cleanup cooperates with cancellation; old credentials clear before any new login.
@MainActor func performBoundedSignOutCleanup(
  before: @escaping @MainActor () async throws -> Void,
  clearIdentity: @MainActor () -> Void,
  timeoutNanoseconds: UInt64 = 2_000_000_000
) async {
  await withTaskGroup(of: Void.self) { group in
    group.addTask { try? await before() }
    group.addTask { try? await Task.sleep(nanoseconds: timeoutNanoseconds) }
    _ = await group.next()
    group.cancelAll()
  }
  clearIdentity()
}
