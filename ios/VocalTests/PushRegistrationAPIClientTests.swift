import Foundation
import XCTest

@testable import Vocal

@MainActor final class PushRegistrationAPIClientTests: XCTestCase {
  private let installation = "d7ea7de6-52e9-4b96-8834-3b517941bdb0"
  private func client(
    _ source: PushTokenFixture, uid: @escaping @MainActor () -> String? = { "owner" }
  ) -> PushRegistrationAPIClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [PushURLProtocol.self]
    return PushRegistrationAPIClient(
      configuration: AuthConfiguration(apiOrigin: URL(string: "https://api.example")!),
      tokenSource: source, identityUID: uid, sessionConfiguration: configuration)
  }

  func testRegistersAndConditionallyDeactivatesWithExactBody() async throws {
    let source = PushTokenFixture()
    let api = client(source)
    var requests: [URLRequest] = []
    PushURLProtocol.handler = { request in
      requests.append(request)
      if request.httpMethod == "PUT" {
        return (
          200,
          Data(
            "{\"installationId\":\"\(self.installation)\",\"active\":true,\"bindingRevision\":7}"
              .utf8)
        )
      }
      return (204, Data())
    }
    let result = try await api.register(installationID: installation, token: "private-token")
    try await api.deactivate(
      installationID: installation, expectedBindingRevision: result.bindingRevision)
    XCTAssertEqual(requests.map(\.httpMethod), ["PUT", "POST"])
    XCTAssertEqual(requests.last?.url?.path, "/api/v1/devices/\(installation)/push/deactivate")
    XCTAssertEqual(requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer fixed-token")
    let body =
      try JSONSerialization.jsonObject(with: requestData(requests.last!)) as! [String: Int64]
    XCTAssertEqual(body, ["expectedBindingRevision": 7])
  }

  func testUnauthorizedDeactivationNeverRefreshesOrReplays() async {
    let source = PushTokenFixture()
    var requests = 0
    PushURLProtocol.handler = { _ in
      requests += 1
      return (401, Data())
    }
    do {
      try await client(source).deactivate(installationID: installation, expectedBindingRevision: 7)
      XCTFail()
    } catch { XCTAssertEqual(error as? AuthFailure, .sessionExpired) }
    XCTAssertEqual(requests, 1)
    XCTAssertEqual(source.forces, [false])
  }

  func testIdentityChangeDuringTokenReadPreventsRequest() async {
    let source = PushTokenFixture()
    var uid: String? = "owner"
    source.onRead = { uid = "other" }
    var requests = 0
    PushURLProtocol.handler = { _ in
      requests += 1
      return (204, Data())
    }
    do {
      try await client(source, uid: { uid }).deactivate(
        installationID: installation, expectedBindingRevision: 7)
      XCTFail()
    } catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertEqual(requests, 0)
  }

  func testSameUIDNewSessionDuringTokenReadPreventsCleanupRequest() async {
    let source = PushTokenFixture()
    source.tokenSession = IDTokenSession(uid: "owner", epoch: 1)
    source.onRead = { source.tokenSession = IDTokenSession(uid: "owner", epoch: 2) }
    var requests = 0
    PushURLProtocol.handler = { _ in
      requests += 1
      return (204, Data())
    }
    do {
      try await client(source).deactivate(installationID: installation, expectedBindingRevision: 7)
      XCTFail()
    } catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertEqual(requests, 0)
  }
}

@MainActor private final class PushTokenFixture: IDTokenSource {
  var tokenSession: IDTokenSession?
  var forces: [Bool] = []
  var onRead: (() -> Void)?
  func idToken(forceRefresh: Bool) async throws -> String {
    forces.append(forceRefresh)
    onRead?()
    return "fixed-token"
  }
}

private final class PushURLProtocol: URLProtocol, @unchecked Sendable {
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

private func requestData(_ request: URLRequest) -> Data {
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
