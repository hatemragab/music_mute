import Combine
import Foundation

struct RealtimeTicket: Decodable {
  let ticket: String
  let path: String
  let `protocol`: String
}

enum RealtimeState { case connecting, live, reconnecting, paused, signedOut }

@MainActor protocol RealtimeSocket {
  func receive() async throws -> String
  func send(_ text: String) async throws
  func cancel()
}

@MainActor private final class FoundationRealtimeSocket: RealtimeSocket {
  let task: URLSessionWebSocketTask
  init(session: URLSession, request: URLRequest) {
    task = session.webSocketTask(with: request)
    task.maximumMessageSize = 256 * 1024
    task.resume()
  }
  func receive() async throws -> String {
    guard case .string(let text) = try await task.receive() else {
      throw JobsFailure.malformedResponse
    }
    return text
  }
  func send(_ text: String) async throws { try await task.send(.string(text)) }
  func cancel() { task.cancel(with: .goingAway, reason: nil) }
}

private final class SocketRedirectPolicy: NSObject, URLSessionTaskDelegate {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) { completionHandler(nil) }
}

/// Session-owned raw WebSocket; reconnect always establishes fresh authorized snapshots.
@MainActor final class ProcessingRealtime: ObservableObject {
  @Published private(set) var state: RealtimeState = .paused
  private struct Subscription {
    let resource: String
    let params: [String: String]
    let continuation: AsyncThrowingStream<Data, Error>.Continuation
    var sequence: Int64 = 0
  }
  private let configuration: AuthConfiguration
  private let ticket: () async throws -> RealtimeTicket
  private let session: URLSession
  private let makeSocket: (URLRequest) -> any RealtimeSocket
  private var subscriptions: [String: Subscription] = [:]
  private var owner: String?
  private var foreground = false
  private var generation: UInt64 = 0
  private var nextID: UInt64 = 0
  private var attempts = 0
  private var socket: (any RealtimeSocket)?
  private var connection: Task<Void, Never>?
  private var receiving: Task<Void, Never>?
  private var retry: Task<Void, Never>?
  private var watchdog: Task<Void, Never>?
  private var stream = ""
  private var snapshotDeadlines: [String: Task<Void, Never>] = [:]

  init(
    configuration: AuthConfiguration, makeSocket: ((URLRequest) -> any RealtimeSocket)? = nil,
    ticket: @escaping () async throws -> RealtimeTicket
  ) {
    self.configuration = configuration
    self.ticket = ticket
    let session = URLSession(
      configuration: .ephemeral, delegate: SocketRedirectPolicy(), delegateQueue: nil)
    self.session = session
    self.makeSocket = makeSocket ?? { FoundationRealtimeSocket(session: session, request: $0) }
  }

  func bindOwner(_ uid: String?) {
    guard owner != uid else { return }
    disconnect()
    for subscription in subscriptions.values {
      subscription.continuation.finish(throwing: CancellationError())
    }
    subscriptions.removeAll()
    owner = uid
    attempts = 0
    resume()
  }

  func setForeground(_ value: Bool) {
    foreground = value
    if value {
      resume()
    } else {
      disconnect()
      state = .paused
    }
  }

  func watch(_ resource: String, params: [String: String] = [:]) -> AsyncThrowingStream<Data, Error>
  {
    nextID &+= 1
    let id = "s\(nextID)"
    return AsyncThrowingStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
      guard subscriptions.count < 16 else {
        continuation.finish(throwing: JobsFailure.serviceUnavailable)
        return
      }
      subscriptions[id] = Subscription(
        resource: resource, params: params, continuation: continuation)
      continuation.onTermination = { [weak self] _ in
        Task { @MainActor in
          guard let self else { return }
          self.subscriptions.removeValue(forKey: id)
          self.snapshotDeadlines.removeValue(forKey: id)?.cancel()
          self.send(["type": "unsubscribe", "subscription_id": id])
          if self.subscriptions.isEmpty { self.disconnect() }
        }
      }
      if !stream.isEmpty { subscribe(id) }
      resume()
    }
  }

  func resync() {
    if stream.isEmpty {
      resume()
      return
    }
    for id in subscriptions.keys { send(["type": "resync", "subscription_id": id]) }
  }

  private func resume() {
    guard foreground, owner != nil, !subscriptions.isEmpty, socket == nil, connection == nil,
      retry == nil
    else { return }
    generation &+= 1
    let epoch = generation
    state = attempts == 0 ? .connecting : .reconnecting
    connection = Task { [weak self] in
      guard let self else { return }
      do {
        let grant = try await ticket()
        guard !Task.isCancelled, epoch == generation else { return }
        guard grant.path == "/realtime/socket", grant.protocol == "musicmute.realtime.v1",
          grant.ticket.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
        else { throw JobsFailure.malformedResponse }
        var components = URLComponents(
          url: try configuration.endpoint(grant.path), resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        guard let url = components.url else { throw AuthFailure.configuration }
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        request.setValue(
          "\(grant.protocol), ticket.\(grant.ticket)", forHTTPHeaderField: "Sec-WebSocket-Protocol")
        let task = makeSocket(request)
        socket = task
        armWatchdog(10)
        receiving = Task { [weak self] in
          do {
            while !Task.isCancelled {
              let text = try await task.receive()
              guard let self, epoch == self.generation else { return }
              try self.message(text)
            }
          } catch {
            guard let self, epoch == self.generation, !Task.isCancelled else { return }
            self.reconnect()
          }
        }
        connection = nil
      } catch {
        guard epoch == generation, !Task.isCancelled else { return }
        connection = nil
        if accessRejected(error) {
          state = .signedOut
          for subscription in subscriptions.values {
            subscription.continuation.finish(throwing: AuthFailure.sessionExpired)
          }
        } else {
          reconnect()
        }
      }
    }
  }

  private func accessRejected(_ error: Error) -> Bool {
    if let failure = error as? JobsFailure, case .forbidden = failure { return true }
    return (error as? AuthFailure) == .sessionExpired || (error as? AuthFailure) == .accountDisabled
  }

  private func message(_ text: String) throws {
    guard text.utf8.count <= 256 * 1024, let data = text.data(using: .utf8),
      let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let type = frame["type"] as? String
    else { throw JobsFailure.malformedResponse }
    if type == "ready" {
      guard frame["protocol_version"] as? Int == 1, let id = frame["stream_id"] as? String else {
        throw JobsFailure.malformedResponse
      }
      stream = id
      attempts = 0
      armWatchdog(65)
      for id in subscriptions.keys { subscribe(id) }
      return
    }
    if type == "ping" {
      send(["type": "pong"])
      armWatchdog(65)
      return
    }
    guard frame["stream_id"] as? String == stream, let id = frame["subscription_id"] as? String,
      var subscription = subscriptions[id]
    else { return }
    if type == "subscription_error" {
      let status = frame["status"] as? Int ?? 503
      if status >= 500 {
        reconnect()
        return
      }
      subscription.continuation.finish(
        throwing: status == 404 ? JobsFailure.notFound : JobsFailure.forbidden(code: nil))
      return
    }
    guard type == "snapshot", frame["protocol_version"] as? Int == 1,
      let sequence = frame["sequence"] as? Int64, sequence > 0, let payload = frame["data"]
    else { throw JobsFailure.malformedResponse }
    if sequence <= subscription.sequence { return }
    if subscription.sequence > 0 && sequence != subscription.sequence + 1 {
      subscriptions[id]?.sequence = 0
      send(["type": "resync", "subscription_id": id])
      return
    }
    snapshotDeadlines.removeValue(forKey: id)?.cancel()
    subscription.sequence = sequence
    subscriptions[id] = subscription
    subscription.continuation.yield(
      try ApiWireJSON.response(JSONSerialization.data(withJSONObject: payload)))
    if subscriptions.values.allSatisfy({ $0.sequence > 0 }) { state = .live }
  }

  private func subscribe(_ id: String) {
    guard var subscription = subscriptions[id] else { return }
    subscription.sequence = 0
    snapshotDeadlines.removeValue(forKey: id)?.cancel()
    snapshotDeadlines[id] = Task { [weak self] in
      do { try await Task.sleep(for: .seconds(15)) } catch { return }
      self?.reconnect()
    }
    subscriptions[id] = subscription
    send([
      "type": "subscribe", "subscription_id": id, "resource": subscription.resource,
      "params": subscription.params,
    ])
  }
  private func send(_ frame: [String: Any]) {
    guard let socket, let data = try? JSONSerialization.data(withJSONObject: frame),
      let text = String(data: data, encoding: .utf8)
    else { return }
    let epoch = generation
    Task { [weak self] in
      guard self?.generation == epoch else { return }
      do { try await socket.send(text) } catch {
        if self?.generation == epoch { self?.reconnect() }
      }
    }
  }
  private func armWatchdog(_ seconds: TimeInterval) {
    watchdog?.cancel()
    watchdog = Task { [weak self] in
      do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
      self?.reconnect()
    }
  }
  private func reconnect() {
    disconnect()
    state = .reconnecting
    let delay = min(30, pow(2, Double(min(attempts, 5)))) + Double.random(in: 0...0.25)
    attempts += 1
    retry = Task { [weak self] in
      do { try await Task.sleep(for: .seconds(delay)) } catch { return }
      self?.retry = nil
      self?.resume()
    }
  }
  private func disconnect() {
    generation &+= 1
    connection?.cancel()
    connection = nil
    receiving?.cancel()
    receiving = nil
    watchdog?.cancel()
    watchdog = nil
    retry?.cancel()
    retry = nil
    socket?.cancel()
    socket = nil
    stream = ""
    for deadline in snapshotDeadlines.values { deadline.cancel() }
    snapshotDeadlines.removeAll()
    for id in subscriptions.keys { subscriptions[id]?.sequence = 0 }
  }
  deinit { session.invalidateAndCancel() }
}
