import Foundation
import XCTest

@testable import Vocal

@MainActor final class ArtifactDownloadTransportTests: XCTestCase {
  func testFileDownloadStripsAmbientCredentialsAndReportsBytes() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let destination = root.appendingPathComponent("download.partial")
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [ArtifactHTTPFixture.self]
    config.httpAdditionalHeaders = [
      "Authorization": "Bearer synthetic", "Cookie": "session=synthetic",
    ]
    let progress = ArtifactProgressRecorder()
    let downloader = URLSessionArtifactDownloader(configuration: config)
    try await downloader.download(
      from: URL(string: "https://artifact.test/valid")!, to: destination,
      progress: { progress.record($0, $1) })
    XCTAssertEqual(try Data(contentsOf: destination), ArtifactHTTPFixture.payload)
    XCTAssertEqual(progress.last?.0, Int64(ArtifactHTTPFixture.payload.count))
  }

  func testHTTPFailureDoesNotPromoteResponseBody() async throws {
    let destination = FileManager.default.temporaryDirectory.appendingPathComponent(
      UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: destination) }
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [ArtifactHTTPFixture.self]
    let downloader = URLSessionArtifactDownloader(configuration: config)
    do {
      try await downloader.download(
        from: URL(string: "https://artifact.test/forbidden")!, to: destination,
        progress: { _, _ in })
      XCTFail("Expected forbidden response")
    } catch {
      XCTAssertEqual(error as? ArtifactDownloadFailure, .httpStatus(403))
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
  }

  func testInsecureOrCredentialedGrantsFailBeforeNetwork() async throws {
    let downloader = URLSessionArtifactDownloader()
    for url in [
      "http://artifact.test/output", "https://user:password@artifact.test/output",
      "https://artifact.test/output#fragment",
    ] {
      do {
        try await downloader.download(
          from: URL(string: url)!, to: URL(fileURLWithPath: "/unused"), progress: { _, _ in })
        XCTFail("Expected invalid grant")
      } catch {
        XCTAssertEqual(error as? ArtifactDownloadFailure, .invalidGrant)
      }
    }
  }
}

private final class ArtifactProgressRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var value: (Int64, Int64?)?
  var last: (Int64, Int64?)? {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
  func record(_ bytes: Int64, _ total: Int64?) {
    lock.lock()
    value = (bytes, total)
    lock.unlock()
  }
}

private final class ArtifactHTTPFixture: URLProtocol, @unchecked Sendable {
  static let payload = Data(repeating: 42, count: 16_384)
  override class func canInit(with request: URLRequest) -> Bool {
    request.url?.host == "artifact.test"
  }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    if request.value(forHTTPHeaderField: "Authorization") != nil
      || request.value(forHTTPHeaderField: "Cookie") != nil
    {
      client?.urlProtocol(self, didFailWithError: URLError(.userAuthenticationRequired))
      return
    }
    let forbidden = request.url?.path == "/forbidden"
    let response = HTTPURLResponse(
      url: request.url!, statusCode: forbidden ? 403 : 200, httpVersion: "HTTP/1.1",
      headerFields: ["Content-Length": "\(Self.payload.count)"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Self.payload)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
