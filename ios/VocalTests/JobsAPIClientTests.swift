import Foundation
import XCTest

@testable import Vocal

@MainActor final class JobsAPIClientTests: XCTestCase {
  private let id = "68c000000000000000000001"
  private let requestId = UUID(uuidString: "C21A2EAA-7E73-4F08-89DA-6AC35BAA83E1")!
  private let installation = "D7EA7DE6-52E9-4B96-8834-3B517941BDB0"
  private let grant =
    #"{"method":"PUT","url":"https://storage.example/","headers":{"Content-Type":"audio/mpeg","x-amz-checksum-sha256":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","If-None-Match":"*"},"expiresAt":"2026-09-09T12:15:00.123Z"}"#
  private var input: InputDeclaration {
    InputDeclaration(
      extension: "mp3", contentType: "audio/mpeg", bytes: 123,
      durationSeconds: 2.5, sha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
  }
  private func client(_ token: JobsTokenFixture) -> JobsAPIClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [JobsURLProtocol.self]
    return JobsAPIClient(
      configuration: AuthConfiguration(apiOrigin: URL(string: "https://api.example")!),
      tokenSource: token, installationId: { self.installation }, sessionConfiguration: config)
  }
  func testAllRouteMethodsBodiesAndInstallationHeaders() async throws {
    let token = JobsTokenFixture()
    let api = client(token)
    var received: [URLRequest] = []
    JobsURLProtocol.handler = { request in
      received.append(request)
      let path = request.url!.path
      let json: String
      if path.hasSuffix("upload-url") {
        json = self.grant
      } else if path.hasSuffix("download-url") {
        json = #"{"url":"https://storage.example/output","expiresAt":"2026-09-09T12:15:00Z"}"#
      } else if path == "/api/v1/jobs" && request.httpMethod == "GET" {
        json = #"{"items":[],"nextCursor":null}"#
      } else if path == "/api/v1/jobs" {
        json = "{\"id\":\"\(self.id)\",\"status\":\"awaiting_upload\",\"upload\":\(self.grant)}"
      } else if request.httpMethod == "GET" {
        json = self.jobJSON(status: "ready")
      } else {
        json = "{\"id\":\"\(self.id)\",\"status\":\"queued\"}"
      }
      return (200, [:], Data(json.utf8))
    }
    let reservation = try await api.create(requestId: requestId, input: input)
    XCTAssertEqual(reservation.upload?.headers["If-None-Match"], "*")
    _ = try await api.renewUpload(id: id)
    _ = try await api.confirmUpload(id: id)
    _ = try await api.list(cursor: "a+/=&?", status: "ready")
    _ = try await api.detail(id: id)
    _ = try await api.cancel(id: id)
    _ = try await api.retry(id: id, requestId: requestId)
    _ = try await api.download(id: id, artifact: "output")
    XCTAssertEqual(
      received.map { $0.httpMethod! },
      ["POST", "POST", "POST", "GET", "GET", "POST", "POST", "POST"])
    XCTAssertEqual(
      received.map { $0.url!.path },
      [
        "/api/v1/jobs", "/api/v1/jobs/\(id)/upload-url", "/api/v1/jobs/\(id)/upload-complete",
        "/api/v1/jobs", "/api/v1/jobs/\(id)", "/api/v1/jobs/\(id)/cancel",
        "/api/v1/jobs/\(id)/retry", "/api/v1/jobs/\(id)/download-url",
      ])
    for (index, request) in received.enumerated() {
      XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer initial")
      XCTAssertEqual(
        request.value(forHTTPHeaderField: "X-Installation-Id"),
        [0, 1, 2, 6].contains(index) ? installation.lowercased() : nil)
      if [1, 2, 5].contains(index) { XCTAssertEqual(try body(request).count, 0) }
    }
    XCTAssertEqual(try body(received[0])["requestId"] as? String, requestId.uuidString.lowercased())
    XCTAssertEqual(Set(try body(received[0]).keys), ["requestId", "input"])
    let declaration = try XCTUnwrap(try body(received[0])["input"] as? [String: Any])
    XCTAssertEqual(
      Set(declaration.keys), ["extension", "contentType", "bytes", "durationSeconds", "sha256"])
    XCTAssertEqual(declaration["bytes"] as? Int, 123)
    XCTAssertEqual(try body(received[6])["requestId"] as? String, requestId.uuidString.lowercased())
    XCTAssertEqual(try body(received[7])["artifact"] as? String, "output")
    XCTAssertEqual(
      URLComponents(url: received[3].url!, resolvingAgainstBaseURL: false)?.queryItems?.first(
        where: { $0.name == "cursor" })?.value, "a+/=&?")
    XCTAssertTrue(received[3].url!.absoluteString.contains("%2B"))
  }
  func testKnownAndUnknownStatusesAndOptionalDates() throws {
    for status in [
      "awaiting_upload", "queued", "validating", "processing", "uploading_result", "interrupted",
      "cancel_requested", "ready", "failed", "cancelled", "future_state",
    ] {
      let job = try JSONDecoder.authDecoder().decode(
        Job.self, from: Data(jobJSON(status: status).utf8))
      XCTAssertEqual(job.status, status)
      XCTAssertNil(job.queuedAt)
      XCTAssertNil(job.finishedAt)
      XCTAssertEqual(job.workerAvailable, false)
    }
  }

  func testAudioExperienceMetadataActionsAndDiagnosticContract() async throws {
    let token = JobsTokenFixture()
    let api = client(token)
    var received: [URLRequest] = []
    JobsURLProtocol.handler = { request in
      received.append(request)
      switch (request.httpMethod, request.url!.path) {
      case ("POST", "/api/v1/jobs"):
        return (
          200, [:],
          Data(
            "{\"id\":\"\(self.id)\",\"status\":\"awaiting_upload\",\"requestId\":\"\(self.requestId.uuidString.lowercased())\",\"upload\":\(self.grant)}"
              .utf8)
        )
      case ("PATCH", "/api/v1/jobs/\(self.id)"):
        return (200, [:], Data(self.jobJSON(status: "ready", metadata: true).utf8))
      case ("DELETE", "/api/v1/jobs/\(self.id)"):
        return (204, [:], Data())
      case ("POST", "/api/v1/client-errors"):
        return (
          201, [:],
          Data("{\"eventId\":\"bba62714-ab09-4c79-9453-ccae688c092c\"}".utf8)
        )
      default:
        return (500, [:], Data())
      }
    }
    let started = Date(timeIntervalSince1970: 1_789_041_600)
    let reservation: CreateReservation
    do {
      reservation = try await api.create(
        requestId: requestId, input: input,
        metadata: JobSourceMetadata(
          sourceTitle: "Interview", sourceKind: .url, clientStartedAt: started,
          sourceURL: "https://www.youtube.com/watch?v=jNQXAC9IVRw"))
    } catch {
      XCTFail("create metadata failed: \(error)")
      return
    }
    XCTAssertEqual(reservation.requestId, requestId.uuidString.lowercased())
    let renamed: Job
    do { renamed = try await api.rename(id: id, displayName: "My interview") } catch {
      XCTFail("rename failed: \(error)")
      return
    }
    XCTAssertEqual(renamed.displayName, "My interview")
    XCTAssertEqual(renamed.sourceTitle, "Interview")
    XCTAssertEqual(renamed.sourceKind, .url)
    XCTAssertEqual(renamed.timing?.processingElapsedMs, 20_000)
    XCTAssertEqual(renamed.stages?.processingStartedAt, Date(timeIntervalSince1970: 1_789_041_645))
    try await api.delete(id: id)
    let event = ClientErrorEvent(
      eventId: UUID(uuidString: "BBA62714-AB09-4C79-9453-CCAE688C092C")!,
      operationId: requestId, jobId: id, stage: .downloadingSource, code: .network,
      retryable: true, platform: .ios, appVersion: "0.1.0", osVersion: "26.0",
      occurredAt: started, httpStatus: 503)
    let accepted: ClientErrorReceipt
    do { accepted = try await api.report(event) } catch {
      XCTFail("report failed: \(error)")
      return
    }
    XCTAssertEqual(accepted.eventId, event.eventId.uuidString.lowercased())

    let createBody = try body(received[0])
    XCTAssertEqual(createBody["sourceTitle"] as? String, "Interview")
    XCTAssertEqual(createBody["sourceKind"] as? String, "url")
    XCTAssertEqual(
      createBody["sourceUrl"] as? String,
      "https://www.youtube.com/watch?v=jNQXAC9IVRw")
    XCTAssertEqual(createBody["clientStartedAt"] as? String, "2026-09-10T12:00:00.000Z")
    XCTAssertEqual(try body(received[1])["displayName"] as? String, "My interview")
    let report = try body(received[3])
    XCTAssertEqual(report["stage"] as? String, "DOWNLOADING_SOURCE")
    XCTAssertEqual(report["code"] as? String, "NETWORK")
    XCTAssertEqual(report["platform"] as? String, "ios")
    XCTAssertEqual(report["occurredAt"] as? String, "2026-09-10T12:00:00.000Z")
    XCTAssertNil(report["message"])
    XCTAssertNil(report["ownerUid"])
  }
  func testRefreshNeverReplaysUnderChangedUserOrSameUidSession() async throws {
    for changed in [
      IDTokenSession(uid: "owner-b", epoch: 1), IDTokenSession(uid: "owner-a", epoch: 2),
    ] {
      let token = JobsTokenFixture()
      token.tokenSession = IDTokenSession(uid: "owner-a", epoch: 1)
      token.refreshSession = changed
      let api = client(token)
      var requests = 0
      JobsURLProtocol.handler = { _ in
        requests += 1
        return (401, [:], Data("{}".utf8))
      }
      do {
        _ = try await api.create(requestId: requestId, input: input)
        XCTFail("Expected identity fence")
      } catch { XCTAssertEqual(error as? AuthFailure, .sessionExpired) }
      XCTAssertEqual(requests, 1)
      XCTAssertEqual(token.refreshes, [false, true])
    }
  }

  func testUnauthorizedRefreshesExactlyOnce() async throws {
    let token = JobsTokenFixture()
    let api = client(token)
    var attempts = 0
    JobsURLProtocol.handler = { _ in
      attempts += 1
      return (401, [:], Data("{}".utf8))
    }
    do {
      _ = try await api.detail(id: id)
      XCTFail("Expected expired session")
    } catch { XCTAssertEqual(error as? AuthFailure, .sessionExpired) }
    XCTAssertEqual(attempts, 2)
    XCTAssertEqual(token.refreshes, [false, true])
  }
  func testSafeErrorsAndRetryAfter() async throws {
    let token = JobsTokenFixture()
    let api = client(token)
    for (status, expected) in [
      (403, JobsFailure.forbidden(code: "EMAIL_VERIFICATION_REQUIRED")), (404, .notFound),
      (409, .conflict(code: "NEW_INPUT_REQUIRED")), (429, .rateLimited(retryAfter: 12)),
      (503, .serviceUnavailable), (302, .redirectRejected),
    ] {
      JobsURLProtocol.handler = { _ in
        let code = status == 403 ? "EMAIL_VERIFICATION_REQUIRED" : "NEW_INPUT_REQUIRED"
        return (
          status, ["Retry-After": "12"],
          Data("{\"code\":\"\(code)\",\"message\":\"SECRET DIAGNOSTICS\"}".utf8)
        )
      }
      do {
        _ = try await api.detail(id: id)
        XCTFail("Expected safe error")
      } catch {
        XCTAssertEqual(error as? JobsFailure, expected)
        XCTAssertFalse(String(describing: error).contains("SECRET"))
      }
    }
  }
  func testRefreshReplaysIdenticalMutationWithFreshBearer() async throws {
    let token = JobsTokenFixture()
    let api = client(token)
    var requests: [(String?, [String: Any])] = []
    JobsURLProtocol.handler = { request in
      requests.append((request.value(forHTTPHeaderField: "Authorization"), try! self.body(request)))
      return requests.count == 1
        ? (401, [:], Data("{}".utf8))
        : (200, [:], Data("{\"id\":\"\(self.id)\",\"status\":\"queued\"}".utf8))
    }
    let mutation = try await api.retry(id: id, requestId: requestId)
    XCTAssertEqual(mutation.status, "queued")
    XCTAssertEqual(requests.map { $0.0 }, ["Bearer initial", "Bearer refreshed"])
    XCTAssertEqual(requests[0].1["requestId"] as? String, requests[1].1["requestId"] as? String)
  }

  func testUnknownErrorCodeIsDiscardedAndDeviceSyncCodeRetained() async throws {
    let token = JobsTokenFixture()
    let api = client(token)
    for code in ["SECRET_TOKEN", "DEVICE_SYNC_REQUIRED"] {
      JobsURLProtocol.handler = { _ in (409, [:], Data("{\"code\":\"\(code)\"}".utf8)) }
      do {
        _ = try await api.detail(id: id)
        XCTFail("Expected conflict")
      } catch {
        XCTAssertEqual(
          error as? JobsFailure, .conflict(code: code == "DEVICE_SYNC_REQUIRED" ? code : nil))
      }
    }
  }

  func testJobRedirectDelegateRejectsSameAndCrossOriginRedirects() {
    let origin = URL(string: "https://api.example")!
    let delegate = AuthRedirectDelegate(origin: origin, rejectAll: true)
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }
    let task = session.dataTask(with: origin)
    let response = HTTPURLResponse(
      url: origin, statusCode: 307, httpVersion: nil, headerFields: nil)!
    for url in ["https://api.example/api/v1/jobs", "https://storage.example/steal"] {
      var invoked = false
      delegate.urlSession(
        session, task: task, willPerformHTTPRedirection: response,
        newRequest: URLRequest(url: URL(string: url)!)
      ) { request in
        invoked = true
        XCTAssertNil(request)
      }
      XCTAssertTrue(invoked)
    }
  }

  func testInvalidRoutesArtifactsAndMissingInstallationNeverRequestNetwork() async throws {
    let token = JobsTokenFixture()
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [JobsURLProtocol.self]
    let api = JobsAPIClient(
      configuration: AuthConfiguration(apiOrigin: URL(string: "https://api.example")!),
      tokenSource: token, installationId: { nil }, sessionConfiguration: config)
    JobsURLProtocol.handler = { _ in
      XCTFail("Invalid input reached network")
      return (500, [:], Data())
    }
    do {
      _ = try await api.detail(id: "../users/me")
      XCTFail("Expected invalid ID")
    } catch { XCTAssertEqual(error as? JobsFailure, .invalidInput) }
    do {
      _ = try await api.download(id: id, artifact: "secret")
      XCTFail("Expected invalid artifact")
    } catch { XCTAssertEqual(error as? JobsFailure, .invalidInput) }
    do {
      _ = try await api.create(requestId: requestId, input: input)
      XCTFail("Expected missing installation")
    } catch { XCTAssertEqual(error as? JobsFailure, .installationRequired) }
    do {
      _ = try await api.list(cursor: String(repeating: "x", count: 513), status: nil)
      XCTFail("Expected oversized cursor")
    } catch { XCTAssertEqual(error as? JobsFailure, .invalidInput) }
    XCTAssertTrue(token.refreshes.isEmpty)
  }

  private func jobJSON(status: String, metadata: Bool = false) -> String {
    let extra =
      metadata
      ? "\"requestId\":\"c21a2eaa-7e73-4f08-89da-6ac35baa83e1\",\"sourceTitle\":\"Interview\",\"displayName\":\"My interview\",\"sourceKind\":\"url\",\"serverTime\":\"2026-09-10T12:01:10.000Z\",\"timing\":{\"processingElapsedMs\":20000,\"processingElapsedApproximate\":false,\"totalElapsedMs\":70000,\"totalElapsedApproximate\":true},\"stages\":{\"validatingAt\":\"2026-09-10T12:00:40.000Z\",\"processingStartedAt\":\"2026-09-10T12:00:45.000Z\",\"processingFinishedAt\":\"2026-09-10T12:01:05.000Z\",\"uploadingResultAt\":\"2026-09-10T12:01:05.000Z\"},"
      : ""
    return
      "{\(extra)\"id\":\"\(id)\",\"status\":\"\(status)\",\"createdAt\":\"2026-09-09T12:00:00Z\",\"updatedAt\":\"2026-09-09T12:00:00.123Z\",\"input\":{\"extension\":\"mp3\",\"bytes\":123,\"durationSeconds\":2.5},\"canDownloadInput\":true,\"canDownloadOutput\":false,\"workerAvailable\":false}"
  }
  private func body(_ request: URLRequest) throws -> [String: Any] {
    var data = request.httpBody ?? Data()
    if let stream = request.httpBodyStream {
      stream.open()
      defer { stream.close() }
      var buffer = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count <= 0 { break }
        data.append(contentsOf: buffer.prefix(count))
      }
    }
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }
}

private final class JobsTokenFixture: IDTokenSource {
  var refreshes: [Bool] = []
  var tokenSession: IDTokenSession?
  var refreshSession: IDTokenSession?
  func idToken(forceRefresh: Bool) async throws -> String {
    refreshes.append(forceRefresh)
    if forceRefresh, let refreshSession { tokenSession = refreshSession }
    return forceRefresh ? "refreshed" : "initial"
  }
}
private final class JobsURLProtocol: URLProtocol, @unchecked Sendable {
  static var handler: ((URLRequest) -> (Int, [String: String], Data))?
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let (status, headers, data) = Self.handler!(request)
    client?.urlProtocol(
      self,
      didReceive: HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!,
      cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
