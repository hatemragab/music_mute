import Foundation

struct IDTokenSession: Equatable, Sendable {
  let uid: String
  let epoch: Int
}

@MainActor protocol IDTokenSource: AnyObject {
  var tokenSession: IDTokenSession? { get }
  func idToken(forceRefresh: Bool) async throws -> String
}

extension IDTokenSource {
  // Fixed test/service token sources may omit an identity. Mutable account sources
  // expose their current UID and generation to fence authenticated replay.
  var tokenSession: IDTokenSession? { nil }
}

final class AuthRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  private let origin: URL
  private let rejectAll: Bool

  init(origin: URL, rejectAll: Bool = false) {
    self.origin = origin
    self.rejectAll = rejectAll
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    guard !rejectAll, request.url?.scheme == origin.scheme, request.url?.host == origin.host,
      request.url?.port == origin.port
    else {
      completionHandler(nil)
      return
    }
    completionHandler(request)
  }
}

@MainActor final class AuthAPIClient {
  private struct EmptyBody: Encodable {}
  private struct ServerError: Decodable { let code: String? }

  private weak var tokenSource: IDTokenSource?
  private let transport: AuthHTTPTransport
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder.authDecoder()

  init(
    configuration: AuthConfiguration, tokenSource: IDTokenSource,
    sessionConfiguration: URLSessionConfiguration? = nil
  ) {
    self.tokenSource = tokenSource
    transport = AuthHTTPTransport(
      configuration: configuration, sessionConfiguration: sessionConfiguration)
  }

  func bootstrap(_ report: InstallationReport) async throws -> SessionResponse {
    try await send("POST", "/auth/session", body: encoder.encode(report), authenticated: true)
  }

  func profileSync() async throws -> ProfileSyncResponse {
    try await send(
      "POST", "/auth/profile-sync", body: encoder.encode(EmptyBody()), authenticated: true)
  }

  func deleteAccount() async throws -> AccountDeletionReceipt {
    guard let tokenSource else { throw AuthFailure.sessionExpired }
    let fence = tokenSource.tokenSession
    let token = try await tokenSource.idToken(forceRefresh: true)
    guard tokenSource.tokenSession == fence else { throw AuthFailure.sessionExpired }
    let (data, response) = try await transport.perform(
      method: "DELETE", path: "/users/me", body: nil, bearer: token)
    let receipt = try decode(AccountDeletionReceipt.self, data: data, response: response)
    guard response.statusCode == 202, receipt.status == "accepted", !receipt.requestId.isEmpty
    else {
      throw AuthFailure.malformedResponse
    }
    return receipt
  }

  func me() async throws -> AccountProfile {
    try await send("GET", "/users/me", authenticated: true)
  }

  func accountRecovery() async throws -> AccountRecoveryStatus {
    try await send("GET", "/users/me/account-recovery", authenticated: true)
  }

  func requestAccountRecovery(reason: String?) async throws -> AccountRecoveryRequest {
    struct Body: Encodable { let reason: String? }
    let trimmed = reason?.trimmingCharacters(in: .whitespacesAndNewlines)
    return try await send(
      "POST", "/users/me/account-recovery",
      body: encoder.encode(Body(reason: trimmed?.isEmpty == false ? trimmed : nil)),
      authenticated: true, replayOnUnauthorized: false)
  }

  func devices(limit: Int = 20, before: String? = nil) async throws -> DevicePage {
    guard (1...50).contains(limit) else { throw AuthFailure.invalidInput }
    var components = URLComponents()
    components.queryItems = [URLQueryItem(name: "limit", value: String(limit))]
    if let before { components.queryItems?.append(URLQueryItem(name: "before", value: before)) }
    return try await send(
      "GET", "/users/me/devices?\(components.percentEncodedQuery ?? "")", authenticated: true)
  }

  func reportInstallation(id: String, metadata: InstallationMetadata) async throws
    -> RegisteredDevice
  {
    guard let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else {
      throw AuthFailure.invalidInput
    }
    return try await send(
      "PUT", "/users/me/devices/\(encoded)", body: encoder.encode(metadata), authenticated: true)
  }

  func policy() async throws -> AppPolicy {
    try await send("GET", "/app-policy", authenticated: false, replayOnUnauthorized: false)
  }

  func requestVerification() async throws -> MailOutcome {
    let response: MailResponse = try await send(
      "POST", "/auth/verification-email", body: encoder.encode(EmptyBody()), authenticated: true,
      replayOnUnauthorized: false)
    return response.status
  }

  func requestPasswordReset(email: String) async throws -> MailOutcome {
    struct Body: Encodable { let email: String }
    let response: MailResponse = try await send(
      "POST", "/auth/password-reset", body: encoder.encode(Body(email: email)),
      authenticated: false, replayOnUnauthorized: false)
    return response.status
  }

  func logoutAll() async throws {
    let _: EmptyResponse = try await send(
      "POST", "/auth/logout-all", body: encoder.encode(EmptyBody()), authenticated: true,
      replayOnUnauthorized: false)
  }

  private struct EmptyResponse: Decodable {}

  private func send<Response: Decodable>(
    _ method: String, _ path: String, body: Data? = nil, authenticated: Bool,
    replayOnUnauthorized: Bool = true
  ) async throws -> Response {
    try Task.checkCancellation()
    let token = authenticated ? try await requireToken(forceRefresh: false) : nil
    let (data, response) = try await transport.perform(
      method: method, path: path, body: body, bearer: token)

    if response.statusCode == 401, authenticated, replayOnUnauthorized {
      let refreshed = try await requireToken(forceRefresh: true)
      let (retryData, retryResponse) = try await transport.perform(
        method: method, path: path, body: body, bearer: refreshed)
      guard retryResponse.statusCode != 401 else { throw AuthFailure.sessionExpired }
      return try decode(Response.self, data: retryData, response: retryResponse)
    }
    return try decode(Response.self, data: data, response: response)
  }

  private func decode<Response: Decodable>(
    _ type: Response.Type, data: Data, response: HTTPURLResponse
  ) throws -> Response {
    if (200...299).contains(response.statusCode) {
      let payload = type == EmptyResponse.self && data.isEmpty ? Data("{}".utf8) : data
      do { return try decoder.decode(type, from: payload) } catch {
        throw AuthFailure.malformedResponse
      }
    }
    let code = (try? decoder.decode(ServerError.self, from: data))?.code
    switch (response.statusCode, code) {
    case (_, "REAUTHENTICATION_REQUIRED"): throw AuthFailure.recentLoginRequired
    case (400, _): throw AuthFailure.invalidInput
    case (401, _): throw AuthFailure.sessionExpired
    case (403, "ACCOUNT_DISABLED"): throw AuthFailure.accountDisabled
    case (403, "ACCOUNT_DELETION_PENDING"): throw AuthFailure.accountDeletionPending
    case (410, "ACCOUNT_RECOVERY_EXPIRED"): throw AuthFailure.accountRecoveryExpired
    case (409, "PROFILE_SYNC_REQUIRED"): throw AuthFailure.profileSyncRequired
    case (409, "DEVICE_REPORT_CONFLICT"): throw AuthFailure.deviceConflict
    case (429, _): throw AuthFailure.rateLimited(retryAt: retryDate(response))
    case (503, _): throw AuthFailure.serviceUnavailable
    default: throw AuthFailure.serviceUnavailable
    }
  }

  private func requireToken(forceRefresh: Bool) async throws -> String {
    guard let tokenSource else { throw AuthFailure.sessionExpired }
    return try await tokenSource.idToken(forceRefresh: forceRefresh)
  }

  private func retryDate(_ response: HTTPURLResponse) -> Date {
    guard let value = response.value(forHTTPHeaderField: "Retry-After") else {
      return Date().addingTimeInterval(60)
    }
    if let seconds = TimeInterval(value), seconds >= 0, seconds <= 86_400 {
      return Date().addingTimeInterval(seconds)
    }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "EEE',' dd MMM yyyy HH':'mm':'ss z"
    return formatter.date(from: value) ?? Date().addingTimeInterval(60)
  }
}

/// Bounded JSON transport shared by account and job APIs; never used for storage transfers.
@MainActor final class AuthHTTPTransport {
  private let configuration: AuthConfiguration
  private let session: URLSession

  init(
    configuration: AuthConfiguration, sessionConfiguration: URLSessionConfiguration? = nil,
    rejectRedirects: Bool = false
  ) {
    self.configuration = configuration
    let config = sessionConfiguration ?? URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 15
    config.timeoutIntervalForResource = 15
    config.httpShouldSetCookies = false
    config.httpCookieAcceptPolicy = .never
    config.httpCookieStorage = nil
    config.urlCache = nil
    config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    session = URLSession(
      configuration: config,
      delegate: AuthRedirectDelegate(origin: configuration.apiOrigin, rejectAll: rejectRedirects),
      delegateQueue: nil)
  }

  func perform(
    method: String, path: String, body: Data?, bearer: String?, headers: [String: String] = [:]
  ) async throws
    -> (Data, HTTPURLResponse)
  {
    let url: URL
    if let queryIndex = path.firstIndex(of: "?") {
      let route = String(path[..<queryIndex])
      let query = String(path[path.index(after: queryIndex)...])
      var components = URLComponents(
        url: try configuration.endpoint(route), resolvingAgainstBaseURL: false)
      components?.percentEncodedQuery = query
      guard let built = components?.url else { throw AuthFailure.configuration }
      url = built
    } else {
      url = try configuration.endpoint(path)
    }
    var request = URLRequest(url: url, timeoutInterval: 15)
    request.httpMethod = method
    request.httpBody = body
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }

    for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }

    do {
      let (bytes, response) = try await session.bytes(for: request)
      guard let http = response as? HTTPURLResponse else {
        throw AuthFailure.malformedResponse
      }
      var data = Data()
      data.reserveCapacity(min(max(Int(http.expectedContentLength), 0), 1_048_576))
      for try await byte in bytes {
        guard data.count < 1_048_576 else { throw AuthFailure.malformedResponse }
        data.append(byte)
      }
      guard http.url?.scheme == configuration.apiOrigin.scheme,
        http.url?.host == configuration.apiOrigin.host,
        http.url?.port == configuration.apiOrigin.port
      else { throw AuthFailure.configuration }
      return (data, http)
    } catch is CancellationError {
      throw CancellationError()
    } catch let failure as AuthFailure {
      throw failure
    } catch let error as URLError where error.code == .cancelled {
      throw CancellationError()
    } catch let error as URLError
      where [
        .notConnectedToInternet, .networkConnectionLost, .timedOut, .cannotConnectToHost,
        .cannotFindHost, .dnsLookupFailed,
      ].contains(error.code)
    {
      throw AuthFailure.offline
    } catch {
      throw AuthFailure.serviceUnavailable
    }
  }

}
