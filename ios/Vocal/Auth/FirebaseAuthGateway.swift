import FirebaseAuth
import Foundation

@MainActor protocol FirebaseAuthenticating: IDTokenSource {
  var identity: IdentitySnapshot? { get }
  var appleProviderUserID: String? { get }
  func observe(_ listener: @escaping @MainActor (IdentitySnapshot?) -> Void) -> NSObjectProtocol
  func removeObserver(_ handle: NSObjectProtocol)
  func register(email: String, password: String) async throws -> IdentitySnapshot
  func signIn(email: String, password: String) async throws -> IdentitySnapshot
  func signIn(apple payload: AppleCredentialPayload) async throws -> IdentitySnapshot
  func reload() async throws -> IdentitySnapshot
  func reauthenticatePassword(_ password: String) async throws
  func reauthenticateApple(_ payload: AppleCredentialPayload) async throws
  func linkPassword(_ password: String) async throws -> IdentitySnapshot
  func linkApple(_ payload: AppleCredentialPayload) async throws -> IdentitySnapshot
  func unlink(_ provider: ProviderID) async throws -> IdentitySnapshot
  func signOut() throws
  func revokeAppleToken(_ authorizationCode: String) async throws
}

extension FirebaseAuthenticating {
  func revokeAppleToken(_ authorizationCode: String) async throws {
    throw AuthFailure.configuration
  }
}

@MainActor final class FirebaseAuthGateway: FirebaseAuthenticating {
  private let auth: Auth
  private var forcedTokenTask: (id: UUID, uid: String, epoch: Int, task: Task<String, Error>)?
  private var activeSignIn: (id: UUID, task: Task<IdentitySnapshot, Error>)?
  private var identityEpoch = 0

  init(auth: Auth = Auth.auth()) {
    self.auth = auth
  }

  var identity: IdentitySnapshot? { auth.currentUser.map(Self.snapshot) }
  var tokenSession: IDTokenSession? {
    auth.currentUser.map { IDTokenSession(uid: $0.uid, epoch: identityEpoch) }
  }
  var appleProviderUserID: String? {
    auth.currentUser?.providerData.first { $0.providerID == ProviderID.apple.rawValue }?.uid
  }

  func observe(_ listener: @escaping @MainActor (IdentitySnapshot?) -> Void) -> NSObjectProtocol {
    auth.addStateDidChangeListener { _, user in listener(user.map(Self.snapshot)) }
  }

  func removeObserver(_ handle: NSObjectProtocol) {
    auth.removeStateDidChangeListener(handle)
  }

  func register(email: String, password: String) async throws -> IdentitySnapshot {
    guard email.count <= 254, email.contains("@"), password.count >= 6 else {
      throw AuthFailure.invalidInput
    }
    return try await runSignIn {
      Self.snapshot(try await self.auth.createUser(withEmail: email, password: password).user)
    }
  }

  func signIn(email: String, password: String) async throws -> IdentitySnapshot {
    guard email.count <= 254, email.contains("@"), !password.isEmpty else {
      throw AuthFailure.invalidInput
    }
    return try await runSignIn {
      Self.snapshot(try await self.auth.signIn(withEmail: email, password: password).user)
    }
  }

  func signIn(apple payload: AppleCredentialPayload) async throws -> IdentitySnapshot {
    try await runSignIn {
      Self.snapshot(try await self.auth.signIn(with: Self.appleCredential(payload)).user)
    }
  }

  func reload() async throws -> IdentitySnapshot {
    guard let user = auth.currentUser else { throw AuthFailure.sessionExpired }
    let uid = user.uid
    do {
      try await user.reload()
      guard let current = auth.currentUser, current.uid == uid else {
        throw AuthFailure.sessionExpired
      }
      return Self.snapshot(current)
    } catch let failure as AuthFailure {
      throw failure
    } catch { throw Self.map(error) }
  }

  func idToken(forceRefresh: Bool) async throws -> String {
    guard let user = auth.currentUser else { throw AuthFailure.sessionExpired }
    let uid = user.uid
    let epoch = identityEpoch
    if forceRefresh, let shared = forcedTokenTask, shared.uid == uid, shared.epoch == epoch {
      do {
        let token = try await shared.task.value
        guard auth.currentUser?.uid == uid, identityEpoch == epoch else {
          throw AuthFailure.sessionExpired
        }
        return token
      } catch let failure as AuthFailure {
        throw failure
      } catch {
        throw Self.map(error)
      }
    }
    if forceRefresh {
      forcedTokenTask?.task.cancel()
      forcedTokenTask = nil
    }
    let taskID = UUID()
    let task = Task { try await user.getIDToken(forcingRefresh: forceRefresh) }
    if forceRefresh { forcedTokenTask = (taskID, uid, epoch, task) }
    defer {
      if forceRefresh, forcedTokenTask?.id == taskID { forcedTokenTask = nil }
    }
    do {
      let token = try await task.value
      guard auth.currentUser?.uid == uid, identityEpoch == epoch else {
        throw AuthFailure.sessionExpired
      }
      return token
    } catch let failure as AuthFailure {
      throw failure
    } catch { throw Self.map(error) }
  }

  func reauthenticatePassword(_ password: String) async throws {
    guard let user = auth.currentUser, let email = user.email, !password.isEmpty else {
      throw AuthFailure.invalidInput
    }
    try await reauthenticate(
      user: user, credential: EmailAuthProvider.credential(withEmail: email, password: password))
  }

  func reauthenticateApple(_ payload: AppleCredentialPayload) async throws {
    guard let user = auth.currentUser else { throw AuthFailure.sessionExpired }
    try await reauthenticate(user: user, credential: Self.appleCredential(payload))
  }

  func linkPassword(_ password: String) async throws -> IdentitySnapshot {
    guard let user = auth.currentUser, let email = user.email, password.count >= 6 else {
      throw AuthFailure.invalidInput
    }
    return try await link(
      user: user, credential: EmailAuthProvider.credential(withEmail: email, password: password))
  }

  func linkApple(_ payload: AppleCredentialPayload) async throws -> IdentitySnapshot {
    guard let user = auth.currentUser else { throw AuthFailure.sessionExpired }
    return try await link(user: user, credential: Self.appleCredential(payload))
  }

  func unlink(_ provider: ProviderID) async throws -> IdentitySnapshot {
    guard let user = auth.currentUser, provider == .password || provider == .apple else {
      throw AuthFailure.providerMissing
    }
    let uid = user.uid
    do {
      let result = try await user.unlink(fromProvider: provider.rawValue)
      guard result.uid == uid, auth.currentUser?.uid == uid else {
        throw AuthFailure.sessionExpired
      }
      return Self.snapshot(result)
    } catch let failure as AuthFailure {
      throw failure
    } catch { throw Self.map(error) }
  }

  func revokeAppleToken(_ authorizationCode: String) async throws {
    do { try await auth.revokeToken(withAuthorizationCode: authorizationCode) } catch {
      throw Self.map(error)
    }
  }

  func signOut() throws {
    identityEpoch += 1
    forcedTokenTask?.task.cancel()
    forcedTokenTask = nil
    do { try auth.signOut() } catch { throw Self.map(error) }
  }

  private func runSignIn(
    _ operation: @escaping @MainActor () async throws -> IdentitySnapshot
  ) async throws -> IdentitySnapshot {
    let epoch = identityEpoch
    while let existing = activeSignIn {
      _ = try? await existing.task.value
      if activeSignIn?.id == existing.id { activeSignIn = nil }
      guard epoch == identityEpoch, !Task.isCancelled else { throw AuthFailure.cancelled }
    }
    guard epoch == identityEpoch, !Task.isCancelled else { throw AuthFailure.cancelled }
    let id = UUID()
    let task = Task { try await operation() }
    activeSignIn = (id, task)
    do {
      let result = try await task.value
      if activeSignIn?.id == id { activeSignIn = nil }
      guard epoch == identityEpoch, !Task.isCancelled else {
        if auth.currentUser?.uid == result.uid { try? auth.signOut() }
        throw AuthFailure.cancelled
      }
      return result
    } catch {
      if activeSignIn?.id == id { activeSignIn = nil }
      if epoch != identityEpoch { throw AuthFailure.cancelled }
      throw Self.map(error)
    }
  }

  private func reauthenticate(user: User, credential: AuthCredential) async throws {
    let uid = user.uid
    do {
      let result = try await user.reauthenticate(with: credential)
      guard result.user.uid == uid, auth.currentUser?.uid == uid else {
        throw AuthFailure.sessionExpired
      }
    } catch let failure as AuthFailure {
      throw failure
    } catch { throw Self.map(error) }
  }

  private func link(user: User, credential: AuthCredential) async throws -> IdentitySnapshot {
    let uid = user.uid
    do {
      let result = try await user.link(with: credential)
      guard result.user.uid == uid, auth.currentUser?.uid == uid else {
        throw AuthFailure.sessionExpired
      }
      return Self.snapshot(result.user)
    } catch let failure as AuthFailure {
      throw failure
    } catch { throw Self.map(error) }
  }

  private static func appleCredential(_ payload: AppleCredentialPayload) -> AuthCredential {
    OAuthProvider.appleCredential(
      withIDToken: payload.idToken, rawNonce: payload.rawNonce, fullName: payload.fullName)
  }

  private static func snapshot(_ user: User) -> IdentitySnapshot {
    IdentitySnapshot(
      uid: user.uid, email: user.email, emailVerified: user.isEmailVerified,
      providers: Set(user.providerData.compactMap { ProviderID(rawValue: $0.providerID) }))
  }

  private static func map(_ error: Error) -> AuthFailure {
    if error is CancellationError { return .cancelled }
    let code = AuthErrorCode(rawValue: (error as NSError).code)
    switch code {
    case .invalidEmail, .missingEmail: return .invalidInput
    case .wrongPassword, .userNotFound, .invalidCredential: return .invalidCredentials
    case .weakPassword: return .weakPassword
    case .userDisabled: return .accountDisabled
    case .accountExistsWithDifferentCredential, .credentialAlreadyInUse, .emailAlreadyInUse:
      return .collision
    case .providerAlreadyLinked: return .providerAlreadyLinked
    case .noSuchProvider: return .providerMissing
    case .requiresRecentLogin: return .recentLoginRequired
    case .networkError: return .offline
    case .tooManyRequests, .quotaExceeded:
      return .rateLimited(retryAt: Date().addingTimeInterval(60))
    case .invalidUserToken, .userTokenExpired, .userMismatch: return .sessionExpired
    case .operationNotAllowed, .appNotAuthorized, .invalidAPIKey: return .configuration
    default: return .unknown
    }
  }
}
