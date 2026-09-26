import XCTest

@testable import Vocal

@MainActor final class ProcessingRealtimeTests: XCTestCase {
  private final class Socket: RealtimeSocket {
    var sent: [String] = []
    var queued: [String] = []
    var waiting: CheckedContinuation<String, Error>?
    var cancelled = false
    func receive() async throws -> String {
      if !queued.isEmpty { return queued.removeFirst() }
      return try await withCheckedThrowingContinuation { waiting = $0 }
    }
    func send(_ text: String) async throws { sent.append(text) }
    func frame(_ text: String) {
      if let pending = waiting {
        waiting = nil
        pending.resume(returning: text)
      } else {
        queued.append(text)
      }
    }
    func cancel() {
      cancelled = true
      waiting?.resume(throwing: CancellationError())
      waiting = nil
    }
  }
  private let ticket = RealtimeTicket(
    ticket: String(repeating: "a", count: 43), path: "/realtime/socket",
    protocol: "musicmute.realtime.v1")

  func testPushDeliveryDuplicateSuppressionAndBackgroundPause() async throws {
    let opened = expectation(description: "socket opened")
    var requests: [URLRequest] = []
    var sockets: [Socket] = []
    var tickets = 0
    let client = ProcessingRealtime(
      configuration: AuthConfiguration(apiOrigin: URL(string: "https://api.example.invalid")!),
      makeSocket: { request in
        requests.append(request)
        let socket = Socket()
        sockets.append(socket)
        opened.fulfill()
        return socket
      },
      ticket: {
        tickets += 1
        return self.ticket
      })
    client.bindOwner("owner")
    client.setForeground(true)
    let stream = client.watch("job", params: ["id": "fixture"])
    var iterator = stream.makeAsyncIterator()
    await fulfillment(of: [opened], timeout: 1)
    XCTAssertNil(requests[0].value(forHTTPHeaderField: "Authorization"))
    XCTAssertNil(requests[0].url?.query)
    XCTAssertEqual(requests[0].url?.scheme, "wss")
    let first = sockets[0]
    first.frame(#"{"type":"ready","protocol_version":1,"stream_id":"one"}"#)
    first.frame(snapshot(1, "queued"))
    let initialValue = try await iterator.next()
    let initial = try XCTUnwrap(initialValue)
    XCTAssertTrue(String(decoding: initial, as: UTF8.self).contains("displayName"))
    first.frame(snapshot(1, "wrong-duplicate"))
    first.frame(snapshot(2, "ready"))
    let nextValue = try await iterator.next()
    let next = try XCTUnwrap(nextValue)
    XCTAssertTrue(String(decoding: next, as: UTF8.self).contains("ready"))
    XCTAssertEqual(tickets, 1)
    client.setForeground(false)
    XCTAssertTrue(first.cancelled)
    XCTAssertEqual(client.state, .paused)
    client.bindOwner(nil)
  }

  func testLogoutDuringTicketIssuanceCannotOpenAnotherOwnersSocket() async {
    var pending: CheckedContinuation<RealtimeTicket, Error>?
    var sockets = 0
    let client = ProcessingRealtime(
      configuration: AuthConfiguration(apiOrigin: URL(string: "https://api.example.invalid")!),
      makeSocket: { _ in
        sockets += 1
        return Socket()
      },
      ticket: {
        try await withCheckedThrowingContinuation { pending = $0 }
      })
    client.bindOwner("owner")
    client.setForeground(true)
    let stream = client.watch("jobs")
    for _ in 0..<100 where pending == nil { await Task.yield() }
    XCTAssertNotNil(pending)
    client.bindOwner(nil)
    pending?.resume(returning: ticket)
    for _ in 0..<20 { await Task.yield() }
    XCTAssertEqual(sockets, 0)
    withExtendedLifetime(stream) {}
  }
  func testForbiddenTicketStopsReconnectAndClearsLiveAccess() async {
    var tickets = 0
    let client = ProcessingRealtime(
      configuration: AuthConfiguration(apiOrigin: URL(string: "https://api.example.invalid")!),
      makeSocket: { _ in
        XCTFail("Forbidden session cannot open a socket")
        return Socket()
      },
      ticket: {
        tickets += 1
        throw JobsFailure.forbidden(code: "ACCOUNT_DISABLED")
      })
    client.bindOwner("owner")
    client.setForeground(true)
    let stream = client.watch("jobs")
    for _ in 0..<100 where client.state != .signedOut { await Task.yield() }
    XCTAssertEqual(client.state, .signedOut)
    XCTAssertEqual(tickets, 1)
    client.bindOwner(nil)
    withExtendedLifetime(stream) {}
  }

  private func snapshot(_ sequence: Int, _ status: String) -> String {
    """
    {"type":"snapshot","protocol_version":1,"stream_id":"one","subscription_id":"s1","sequence":\(sequence),"data":{"status":"\(status)","display_name":"Test"}}
    """
  }
}
