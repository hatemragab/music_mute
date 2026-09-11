import Foundation

@MainActor protocol JobsAPI {
  func create(requestId: UUID, input: InputDeclaration) async throws -> CreateReservation
  func create(requestId: UUID, input: InputDeclaration, metadata: JobSourceMetadata) async throws
    -> CreateReservation
  func renewUpload(id: String) async throws -> UploadGrant
  func confirmUpload(id: String) async throws -> JobMutation
  func list(cursor: String?, status: String?) async throws -> JobPage
  func detail(id: String) async throws -> Job
  func cancel(id: String) async throws -> JobMutation
  func retry(id: String, requestId: UUID) async throws -> JobMutation
  func download(id: String, artifact: String) async throws -> DownloadGrant
  func rename(id: String, displayName: String) async throws -> Job
  func delete(id: String) async throws
  func report(_ event: ClientErrorEvent) async throws -> ClientErrorReceipt
  func report(_ event: ClientErrorEvent, ownerUid: String) async throws -> ClientErrorReceipt
}

extension JobsAPI {
  func create(requestId: UUID, input: InputDeclaration, metadata: JobSourceMetadata) async throws
    -> CreateReservation
  {
    try await create(requestId: requestId, input: input)
  }
  func rename(id: String, displayName: String) async throws -> Job {
    throw JobsFailure.serviceUnavailable
  }
  func delete(id: String) async throws { throw JobsFailure.serviceUnavailable }
  func report(_ event: ClientErrorEvent) async throws -> ClientErrorReceipt {
    throw JobsFailure.serviceUnavailable
  }
  func report(_ event: ClientErrorEvent, ownerUid: String) async throws -> ClientErrorReceipt {
    try await report(event)
  }
}

@MainActor final class JobsAPIClient: JobsAPI {
  private struct Empty: Encodable {}
  private struct ServerError: Decodable { let code: String? }
  private weak var tokenSource: IDTokenSource?
  private let installationId: @MainActor () -> String?
  private let transport: AuthHTTPTransport
  private let encoder: JSONEncoder = {
    let value = JSONEncoder()
    value.dateEncodingStrategy = .custom { date, encoder in
      var container = encoder.singleValueContainer()
      try container.encode(JobsAPIClient.iso8601(date))
    }
    return value
  }()
  private let decoder = JSONDecoder.authDecoder()

  init(
    configuration: AuthConfiguration, tokenSource: IDTokenSource,
    installationId: @escaping @MainActor () -> String?,
    sessionConfiguration: URLSessionConfiguration? = nil
  ) {
    self.tokenSource = tokenSource
    self.installationId = installationId
    transport = AuthHTTPTransport(
      configuration: configuration,
      sessionConfiguration: sessionConfiguration, rejectRedirects: true)
  }

  func create(requestId: UUID, input: InputDeclaration) async throws -> CreateReservation {
    try await create(requestId: requestId, input: input, metadata: JobSourceMetadata())
  }
  func create(requestId: UUID, input: InputDeclaration, metadata: JobSourceMetadata) async throws
    -> CreateReservation
  {
    struct Body: Encodable {
      let requestId: String
      let input: InputDeclaration
      let sourceTitle: String?
      let sourceKind: JobSourceKind?
      let sourceUrl: String?
      let clientStartedAt: String?
    }
    let title = try normalizedName(metadata.sourceTitle, optional: true)
    return try await send(
      "POST", "/jobs",
      body: encoder.encode(
        Body(
          requestId: try requestUUID(requestId), input: input, sourceTitle: title,
          sourceKind: metadata.sourceKind, sourceUrl: metadata.sourceURL,
          clientStartedAt: metadata.clientStartedAt.map(Self.iso8601))),
      installation: true)
  }
  func renewUpload(id: String) async throws -> UploadGrant {
    try await send(
      "POST", route(id, "upload-url"), body: encoder.encode(Empty()), installation: true)
  }
  func confirmUpload(id: String) async throws -> JobMutation {
    try await send(
      "POST", route(id, "upload-complete"), body: encoder.encode(Empty()), installation: true)
  }
  func list(cursor: String? = nil, status: String? = nil) async throws -> JobPage {
    guard cursor == nil || cursor!.count <= 512 else { throw JobsFailure.invalidInput }
    var components = URLComponents()
    components.queryItems = []
    if let cursor { components.queryItems?.append(URLQueryItem(name: "cursor", value: cursor)) }
    if let status { components.queryItems?.append(URLQueryItem(name: "status", value: status)) }
    // A literal plus must not become a space in query decoders.
    let query = (components.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
    return try await send("GET", "/jobs" + (query.isEmpty ? "" : "?" + query))
  }
  func detail(id: String) async throws -> Job { try await send("GET", route(id)) }
  func cancel(id: String) async throws -> JobMutation {
    try await send("POST", route(id, "cancel"), body: encoder.encode(Empty()))
  }
  func retry(id: String, requestId: UUID) async throws -> JobMutation {
    struct Body: Encodable { let requestId: String }
    return try await send(
      "POST", route(id, "retry"), body: encoder.encode(Body(requestId: try requestUUID(requestId))),
      installation: true)
  }
  func download(id: String, artifact: String) async throws -> DownloadGrant {
    guard artifact == "input" || artifact == "output" else { throw JobsFailure.invalidInput }
    struct Body: Encodable { let artifact: String }
    return try await send(
      "POST", route(id, "download-url"), body: encoder.encode(Body(artifact: artifact)))
  }
  func rename(id: String, displayName: String) async throws -> Job {
    struct Body: Encodable { let displayName: String }
    return try await send(
      "PATCH", route(id),
      body: encoder.encode(Body(displayName: try normalizedName(displayName, optional: false)!)))
  }
  func delete(id: String) async throws { try await sendNoContent("DELETE", route(id)) }
  func report(_ event: ClientErrorEvent) async throws -> ClientErrorReceipt {
    try await send("POST", "/client-errors", body: encoder.encode(event))
  }
  func report(_ event: ClientErrorEvent, ownerUid: String) async throws -> ClientErrorReceipt {
    guard tokenSource?.tokenSession?.uid == ownerUid else { throw AuthFailure.sessionExpired }
    return try await report(event)
  }
  private func route(_ id: String, _ suffix: String? = nil) throws -> String {
    guard id.range(of: "^[0-9a-fA-F]{24}$", options: .regularExpression) != nil else {
      throw JobsFailure.invalidInput
    }
    return "/jobs/" + id.lowercased() + (suffix.map { "/" + $0 } ?? "")
  }
  private func requestUUID(_ id: UUID) throws -> String {
    let value = id.uuidString.lowercased()
    guard
      value.range(
        of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        options: .regularExpression) != nil
    else { throw JobsFailure.invalidInput }
    return value
  }
  private func normalizedName(_ value: String?, optional: Bool) throws -> String? {
    guard let value else {
      if optional { return nil }
      throw JobsFailure.invalidInput
    }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed.unicodeScalars.count <= 200,
      trimmed.unicodeScalars.allSatisfy({ $0.properties.generalCategory != .control })
    else { throw JobsFailure.invalidInput }
    return trimmed
  }
  nonisolated private static func iso8601(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }
  private func send<Response: Decodable>(
    _ method: String, _ path: String, body: Data? = nil,
    installation: Bool = false
  ) async throws -> Response {
    try Task.checkCancellation()
    guard let tokenSource else { throw AuthFailure.sessionExpired }
    let capturedSession = tokenSource.tokenSession
    var headers: [String: String] = [:]
    if installation {
      guard let id = installationId(), let uuid = UUID(uuidString: id) else {
        throw JobsFailure.installationRequired
      }
      headers["X-Installation-Id"] = try requestUUID(uuid)
    }
    for attempt in 0...1 {
      try Task.checkCancellation()
      guard tokenSource.tokenSession == capturedSession else { throw AuthFailure.sessionExpired }
      let token = try await tokenSource.idToken(forceRefresh: attempt == 1)
      try Task.checkCancellation()
      guard tokenSource.tokenSession == capturedSession else { throw AuthFailure.sessionExpired }
      let (data, response) = try await transport.perform(
        method: method, path: path, body: body, bearer: token, headers: headers)
      try Task.checkCancellation()
      guard tokenSource.tokenSession == capturedSession else { throw AuthFailure.sessionExpired }
      if response.statusCode == 401 && attempt == 0 { continue }
      if (200...299).contains(response.statusCode) {
        do { return try decoder.decode(Response.self, from: data) } catch {
          throw JobsFailure.malformedResponse
        }
      }
      let rawCode = (try? decoder.decode(ServerError.self, from: data))?.code
      let safeCodes: Set<String> = [
        "ACCOUNT_DISABLED", "EMAIL_VERIFICATION_REQUIRED", "APP_UPDATE_REQUIRED",
        "PROCESSING_NOT_ALLOWED", "INSTALLATION_REQUIRED", "DEVICE_NOT_FOUND",
        "PROFILE_SYNC_REQUIRED", "DEVICE_SYNC_REQUIRED", "DEVICE_REPORT_CONFLICT",
        "JOB_STATE_CONFLICT", "IDEMPOTENCY_CONFLICT", "UPLOAD_NOT_READY",
        "NEW_INPUT_REQUIRED", "JOB_ACTIVE", "JOB_NOT_FOUND",
      ]
      let code = rawCode.flatMap { safeCodes.contains($0) ? $0 : nil }
      switch response.statusCode {
      case 300...399: throw JobsFailure.redirectRejected
      case 400: throw JobsFailure.invalidInput
      case 401: throw AuthFailure.sessionExpired
      case 403: throw JobsFailure.forbidden(code: code)
      case 404: throw JobsFailure.notFound
      case 409: throw JobsFailure.conflict(code: code)
      case 429: throw JobsFailure.rateLimited(retryAfter: retryAfter(response))
      default: throw JobsFailure.serviceUnavailable
      }
    }
    throw AuthFailure.sessionExpired
  }
  private func sendNoContent(_ method: String, _ path: String) async throws {
    try Task.checkCancellation()
    guard let tokenSource else { throw AuthFailure.sessionExpired }
    let capturedSession = tokenSource.tokenSession
    for attempt in 0...1 {
      guard tokenSource.tokenSession == capturedSession else { throw AuthFailure.sessionExpired }
      let token = try await tokenSource.idToken(forceRefresh: attempt == 1)
      guard tokenSource.tokenSession == capturedSession else { throw AuthFailure.sessionExpired }
      let (data, response) = try await transport.perform(
        method: method, path: path, body: nil, bearer: token, headers: [:])
      guard tokenSource.tokenSession == capturedSession else { throw AuthFailure.sessionExpired }
      if response.statusCode == 401 && attempt == 0 { continue }
      if response.statusCode == 204 { return }
      let rawCode = (try? decoder.decode(ServerError.self, from: data))?.code
      switch response.statusCode {
      case 400: throw JobsFailure.invalidInput
      case 401: throw AuthFailure.sessionExpired
      case 404: throw JobsFailure.notFound
      case 409: throw JobsFailure.conflict(code: rawCode == "JOB_ACTIVE" ? rawCode : nil)
      case 429: throw JobsFailure.rateLimited(retryAfter: retryAfter(response))
      default: throw JobsFailure.serviceUnavailable
      }
    }
    throw AuthFailure.sessionExpired
  }
  private func retryAfter(_ response: HTTPURLResponse) -> TimeInterval {
    guard let raw = response.value(forHTTPHeaderField: "Retry-After") else { return 60 }
    if let seconds = Double(raw), seconds.isFinite, seconds >= 0 { return min(seconds, 86_400) }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "EEE',' dd MMM yyyy HH':'mm':'ss z"
    guard let date = formatter.date(from: raw) else { return 60 }
    return min(max(date.timeIntervalSinceNow, 0), 86_400)
  }
}
