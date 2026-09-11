import AuthenticationServices
import CryptoKit
import Foundation
import Security
import UIKit

struct AppleCredentialPayload: @unchecked Sendable {
  let idToken: String
  let rawNonce: String
  let fullName: PersonNameComponents?
  let appleUserID: String
  var authorizationCode: String? = nil
}

@MainActor final class AppleCredentialProvider: NSObject {
  private struct Attempt {
    let id: UUID
    let nonce: String
    let controller: ASAuthorizationController
    let continuation: CheckedContinuation<AppleCredentialPayload, Error>
  }

  private let apple = ASAuthorizationAppleIDProvider()
  private var attempt: Attempt?
  private var revocationObserver: NSObjectProtocol?

  override init() {
    super.init()
  }

  deinit {
    if let revocationObserver { NotificationCenter.default.removeObserver(revocationObserver) }
  }

  func authorize() async throws -> AppleCredentialPayload {
    try Task.checkCancellation()
    guard attempt == nil else { throw AuthFailure.cancelled }
    let attemptID = UUID()
    return try await withTaskCancellationHandler {
      try Task.checkCancellation()
      return try await withCheckedThrowingContinuation {
        (continuation: CheckedContinuation<AppleCredentialPayload, Error>) in
        do {
          guard !Task.isCancelled else {
            continuation.resume(throwing: AuthFailure.cancelled)
            return
          }
          let rawNonce = try Self.randomNonce()
          let request = apple.createRequest()
          request.requestedScopes = [.fullName, .email]
          request.nonce = Self.sha256(rawNonce)
          let controller = ASAuthorizationController(authorizationRequests: [request])
          self.attempt = Attempt(
            id: attemptID, nonce: rawNonce, controller: controller, continuation: continuation)
          controller.delegate = self
          controller.presentationContextProvider = self
          controller.performRequests()
        } catch {
          continuation.resume(throwing: error)
        }
      }
    } onCancel: {
      Task { @MainActor [weak self] in
        self?.finish(attemptID: attemptID, result: .failure(AuthFailure.cancelled))
      }
    }
  }

  func observeRevocation(_ action: @escaping @MainActor () -> Void) {
    if let revocationObserver { NotificationCenter.default.removeObserver(revocationObserver) }
    revocationObserver = NotificationCenter.default.addObserver(
      forName: ASAuthorizationAppleIDProvider.credentialRevokedNotification, object: nil,
      queue: .main
    ) { _ in Task { @MainActor in action() } }
  }

  func credentialState(userID: String) async throws
    -> ASAuthorizationAppleIDProvider.CredentialState
  {
    try await withCheckedThrowingContinuation { continuation in
      apple.getCredentialState(forUserID: userID) { state, error in
        if let error {
          continuation.resume(throwing: error)
        } else {
          continuation.resume(returning: state)
        }
      }
    }
  }

  private func finish(
    attemptID: UUID, controller: ASAuthorizationController? = nil,
    result: Result<AppleCredentialPayload, Error>
  ) {
    guard let attempt, attempt.id == attemptID,
      controller == nil || attempt.controller === controller
    else { return }
    self.attempt = nil
    attempt.controller.delegate = nil
    attempt.controller.presentationContextProvider = nil
    attempt.continuation.resume(with: result)
  }

  private static func randomNonce(length: Int = 32) throws -> String {
    precondition(length > 0)
    let characters = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
    var result = ""
    var bytes = [UInt8](repeating: 0, count: 16)
    while result.count < length {
      guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
        throw AuthFailure.unknown
      }
      for byte in bytes where byte < characters.count * (256 / characters.count) {
        result.append(characters[Int(byte) % characters.count])
        if result.count == length { break }
      }
    }
    return result
  }

  private static func sha256(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}

extension AppleCredentialProvider: ASAuthorizationControllerDelegate {
  func authorizationController(
    controller: ASAuthorizationController,
    didCompleteWithAuthorization authorization: ASAuthorization
  ) {
    guard let attempt, attempt.controller === controller else { return }
    guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
      let data = credential.identityToken,
      let token = String(data: data, encoding: .utf8), !token.isEmpty
    else {
      finish(
        attemptID: attempt.id, controller: controller,
        result: .failure(AuthFailure.invalidCredentials))
      return
    }
    finish(
      attemptID: attempt.id, controller: controller,
      result: .success(
        AppleCredentialPayload(
          idToken: token, rawNonce: attempt.nonce, fullName: credential.fullName,
          appleUserID: credential.user,
          authorizationCode: credential.authorizationCode.flatMap {
            String(data: $0, encoding: .utf8)
          })))
  }

  func authorizationController(
    controller: ASAuthorizationController, didCompleteWithError error: Error
  ) {
    guard let attempt, attempt.controller === controller else { return }
    let code = ASAuthorizationError.Code(rawValue: (error as NSError).code)
    finish(
      attemptID: attempt.id, controller: controller,
      result: .failure(code == .canceled ? AuthFailure.cancelled : AuthFailure.unknown))
  }
}

extension AppleCredentialProvider: ASAuthorizationControllerPresentationContextProviding {
  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
  }
}
