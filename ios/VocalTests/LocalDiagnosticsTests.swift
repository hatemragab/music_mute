import Foundation
import XCTest

@testable import Vocal

final class LocalDiagnosticsTests: XCTestCase {
  func testNestedCredentialsAndSignedURLsAreRedacted() throws {
    let value: [String: Any] = [
      "items": [["Authorization": "Bearer canary", "api_key": "canary", "password": "canary"]],
      "url": "https://user:canary@example.invalid/audio?signature=canary#canary",
      "connection": "mongodb+srv://user:canary@example.invalid/database",
      "safe": "ready",
    ]
    let data = try JSONSerialization.data(withJSONObject: LocalLogRedaction.clean(value))
    let text = String(decoding: data, as: UTF8.self)
    XCTAssertFalse(text.contains("canary"))
    XCTAssertTrue(text.contains("ready"))
    XCTAssertTrue(text.contains("REDACTED"))
  }

  func testEncodedJSONIsInspectedAndUnsupportedContentIsExplicit() throws {
    let encoded = Data(#"{"refresh_token":"canary","ok":true}"#.utf8).base64EncodedString()
    let value = LocalLogRedaction.clean([
      "encoded": encoded, "string": #"{"secret":"canary"}"#,
      "unsupported": URL(fileURLWithPath: "/private/canary"),
    ])
    let text = String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
    XCTAssertFalse(text.contains("canary"))
    XCTAssertTrue(text.contains("base64_json"))
    XCTAssertTrue(text.contains("unsupported_type"))
  }

  func testLimitsProduceOmissionMetadata() throws {
    let value = LocalLogRedaction.clean([
      "large": String(repeating: "x", count: 3_000), "array": Array(repeating: "ok", count: 100),
    ])
    let text = String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
    XCTAssertTrue(text.contains("string_limit"))
    XCTAssertTrue(text.contains("array_limit"))
    XCTAssertLessThan(text.utf8.count, 4_096)
  }

  func testTaskIdentitySurvivesAwaitAndChildTask() async {
    let captured = LocalDiagnostics.Context(userID: "account-before-await", traceID: "operation-1")
    await LocalDiagnostics.$context.withValue(captured) {
      await Task.yield()
      let inherited = await Task { LocalDiagnostics.context }.value
      XCTAssertEqual(inherited?.userID, "account-before-await")
      XCTAssertEqual(inherited?.traceID, "operation-1")
    }
    XCTAssertNil(LocalDiagnostics.context)
  }

  func testErrorOmitsArbitraryCredentialBearingDetails() throws {
    let error = NSError(
      domain: "private", code: 42, userInfo: [NSLocalizedDescriptionKey: "Bearer canary"])
    let text = String(
      decoding: try JSONSerialization.data(withJSONObject: LocalDiagnostics.error(error)),
      as: UTF8.self)
    XCTAssertFalse(text.contains("canary"))
    XCTAssertTrue(text.contains("42"))
  }

  #if DEBUG
    func testQueuePressurePreservesWarningsAndStaysBounded() {
      var queue = LocalLogQueue(capacity: 2)
      XCTAssertTrue(queue.offer(.init(bytes: Data("info".utf8), level: "info")))
      XCTAssertTrue(queue.offer(.init(bytes: Data("warn".utf8), level: "warn")))
      XCTAssertFalse(queue.offer(.init(bytes: Data("ignored".utf8), level: "info")))
      XCTAssertTrue(queue.offer(.init(bytes: Data("error".utf8), level: "error")))
      XCTAssertEqual(queue.count, 2)
      XCTAssertEqual(queue.dropped, 2)
      XCTAssertEqual(queue.take()?.level, "warn")
      XCTAssertEqual(queue.take()?.level, "error")
      XCTAssertNil(queue.take())
    }

    func testDebugConfigurationRequiresOptInKeyAndExactLoopbackEndpoint() {
      let key = String(repeating: "a", count: 32)
      let valid = ["MUSICMUTE_LOG_ENABLED": "1", "MUSICMUTE_LOG_KEY": key]
      XCTAssertNotNil(LocalLogConfiguration.load(valid))
      XCTAssertNil(LocalLogConfiguration.load(["MUSICMUTE_LOG_KEY": key]))
      XCTAssertNil(
        LocalLogConfiguration.load(["MUSICMUTE_LOG_ENABLED": "1", "MUSICMUTE_LOG_KEY": "short"]))
      XCTAssertNil(
        LocalLogConfiguration.load(
          valid.merging(["MUSICMUTE_LOG_ENDPOINT": "https://example.invalid/ingest/ios"]) {
            _, new in new
          }))
      XCTAssertFalse(LocalLogConfiguration.load(valid)!.payloads)
      XCTAssertFalse(LocalLogConfiguration.load(valid)!.console)
    }
  #endif
}
