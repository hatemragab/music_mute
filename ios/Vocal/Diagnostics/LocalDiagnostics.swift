import Foundation

/// Local diagnostics never persist credentials and have no release-build activation path.
/// Identity is captured at the operation boundary, never read later from mutable global auth.
enum LocalDiagnostics {
  struct Context: Sendable {
    let userID: String?
    let traceID: String
  }
  @TaskLocal static var context: Context?

  static var enabled: Bool {
    #if DEBUG
      return LocalLogDelivery.shared.configuration != nil
    #else
      return false
    #endif
  }

  private static func eventTimestamp() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date())
  }

  static func emit(
    _ name: String, category: String, level: String = "info", data: [String: Any] = [:],
    userID: String? = nil, requestID: String? = nil, traceID: String? = nil
  ) {
    #if DEBUG
      let delivery = LocalLogDelivery.shared
      guard let configuration = delivery.configuration else { return }
      var event: [String: Any] = [
        "timestamp": eventTimestamp(),
        "timestampSource": "original", "level": level, "source": "ios",
        "origin": "application", "service": "musicmute-ios", "instanceId": delivery.instanceID,
        "category": category, "name": name, "summary": name,
        "data": data, "collector": delivery.status(),
      ]
      for key in [
        "operation", "phase", "result", "status", "durationMs", "jobId", "operationId",
        "transferId", "streamId", "subscriptionId",
      ] {
        if let value = data[key] { event[key] = value }
      }
      if let uid = userID ?? context?.userID { event["userId"] = uid }
      if let id = requestID { event["requestId"] = id }
      if let id = traceID ?? context?.traceID { event["traceId"] = id }
      event = LocalLogRedaction.clean(event) as? [String: Any] ?? [:]
      guard var bytes = try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys])
      else { return }
      if bytes.count > 32_768 {
        event["data"] = ["omitted": "event_byte_limit"]
        bytes =
          (try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys])) ?? Data()
      }
      if configuration.console {
        // Console summaries contain only fixed names and delivery counters, never raw payloads.
        print(
          "[local-log] ios \(event["level"] as? String ?? "info") \(event["name"] as? String ?? "[omitted]") pending=\(delivery.status()["pending"] ?? 0)"
        )
      }
      delivery.enqueue(bytes, level: level)
    #endif
  }

  static func payload(_ bytes: Data?) -> Any {
    #if DEBUG
      guard LocalLogDelivery.shared.configuration?.payloads == true else {
        return ["omitted": "payload_capture_disabled"]
      }
      guard let bytes else { return NSNull() }
      guard bytes.count <= 16_384 else {
        return ["omitted": "payload_byte_limit", "bytes": bytes.count]
      }
      guard
        let object = try? JSONSerialization.jsonObject(with: bytes, options: [.fragmentsAllowed])
      else { return ["omitted": "non_json", "bytes": bytes.count] }
      return LocalLogRedaction.clean(object)
    #else
      return ["omitted": "release_build"]
    #endif
  }

  static func error(_ error: Error) -> [String: Any] {
    let value = error as NSError
    // Error descriptions, userInfo and arbitrary stacks may embed signed URLs or tokens.
    return [
      "type": String(describing: type(of: error)), "code": value.code,
      "omitted": "error_message_and_user_info",
    ]
  }

  #if DEBUG
    private static var previousExceptionHandler: NSUncaughtExceptionHandler?
  #endif

  static func installErrorObserver() {
    #if DEBUG
      guard enabled else { return }
      previousExceptionHandler = NSGetUncaughtExceptionHandler()
      NSSetUncaughtExceptionHandler { exception in
        LocalDiagnostics.emit(
          "runtime.uncaught_exception", category: "runtime", level: "fatal",
          data: ["type": "NSException", "omitted": "exception_reason_and_stack"])
        LocalDiagnostics.previousExceptionHandler?(exception)
      }
    #endif
  }

  static func status() -> [String: Int] {
    #if DEBUG
      return LocalLogDelivery.shared.status()
    #else
      return ["pending": 0, "sent": 0, "failed": 0, "dropped": 0]
    #endif
  }
}

/// Shared by tests and the collector. Explicit omissions make bounds visible in retained records.
enum LocalLogRedaction {
  static func clean(_ value: Any) -> Any {
    var remaining = 512
    return visit(value, depth: 0, remaining: &remaining)
  }

  private static func sensitive(_ key: String) -> Bool {
    let name = key.lowercased().filter { $0.isLetter || $0.isNumber }
    return [
      "password", "passwd", "pwd", "token", "authorization", "cookie", "secret",
      "apikey", "privatekey", "ticket", "credential", "connectionstring", "dsn",
      "databaseurl", "redisurl", "accesskey", "sessionid",
    ].contains { name.contains($0) }
  }

  private static func visit(_ value: Any, depth: Int, remaining: inout Int) -> Any {
    guard depth <= 8, remaining > 0 else { return ["omitted": "structure_limit"] }
    remaining -= 1
    if let dictionary = value as? [String: Any] {
      var result: [String: Any] = [:]
      for key in dictionary.keys.sorted().prefix(64) {
        let safeKey = key.count <= 128 ? key : "[oversized_key]"
        result[safeKey] =
          sensitive(key)
          ? "[REDACTED]" : visit(dictionary[key]!, depth: depth + 1, remaining: &remaining)
      }
      if dictionary.count > 64 { result["_omitted"] = "object_key_limit" }
      return result
    }
    if let array = value as? [Any] {
      var result = array.prefix(32).map { visit($0, depth: depth + 1, remaining: &remaining) }
      if array.count > 32 { result.append(["omitted": "array_limit", "count": array.count]) }
      return result
    }
    if let text = value as? String {
      guard text.utf8.count <= 2_048 else {
        return ["omitted": "string_limit", "bytes": text.utf8.count]
      }
      if text.range(
        of:
          #"(?i)(bearer\s+|-----BEGIN|(?:mongodb(?:\+srv)?|redis|rediss|postgres(?:ql)?|mysql)://|(?:password|token|secret|api[_-]?key|authorization)\s*[:=]|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"#,
        options: .regularExpression) != nil
      {
        return "[REDACTED]"
      }
      if let bytes = text.data(using: .utf8), text.first == "{" || text.first == "[",
        let nested = try? JSONSerialization.jsonObject(with: bytes)
      {
        return visit(nested, depth: depth + 1, remaining: &remaining)
      }
      if text.count >= 16, let decoded = Data(base64Encoded: text),
        let nested = try? JSONSerialization.jsonObject(with: decoded)
      {
        return [
          "encoding": "base64_json",
          "value": visit(nested, depth: depth + 1, remaining: &remaining),
        ]
      }
      if var url = URLComponents(string: text),
        ["http", "https", "ws", "wss"].contains(url.scheme?.lowercased() ?? ""), url.host != nil
      {
        url.user = nil
        url.password = nil
        url.fragment = nil
        if url.query != nil { url.query = "[REDACTED]" }
        return url.string ?? "[REDACTED_URL]"
      }
      if text.range(of: #"(?i)https?://[^\s]*[?@]"#, options: .regularExpression) != nil {
        return "[REDACTED_URL]"
      }
      return text
    }
    if value is NSNull || value is NSNumber { return value }
    return ["omitted": "unsupported_type"]
  }
}

#if DEBUG
  struct LocalLogQueue {
    struct Record {
      let bytes: Data
      let level: String
    }
    private var records: [Record] = []
    let capacity: Int
    private(set) var dropped = 0
    var count: Int { records.count }
    init(capacity: Int = 128) { self.capacity = max(1, capacity) }
    mutating func offer(_ record: Record) -> Bool {
      if records.count >= capacity {
        if ["warn", "error", "fatal"].contains(record.level),
          let index = records.firstIndex(where: { !["warn", "error", "fatal"].contains($0.level) })
        {
          records.remove(at: index)
        } else {
          dropped += 1
          return false
        }
        dropped += 1
      }
      records.append(record)
      return true
    }
    mutating func take() -> Record? { records.isEmpty ? nil : records.removeFirst() }
  }

  struct LocalLogConfiguration {
    let endpoint: URL
    let key: String
    let payloads: Bool
    let console: Bool

    static func load(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> Self?
    {
      guard environment["MUSICMUTE_LOG_ENABLED"] == "1",
        let key = environment["MUSICMUTE_LOG_KEY"], (32...256).contains(key.count),
        key.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil,
        let endpoint = URL(
          string: environment["MUSICMUTE_LOG_ENDPOINT"] ?? "http://127.0.0.1:19740/ingest/ios"),
        endpoint.scheme == "http", endpoint.host == "127.0.0.1", endpoint.port == 19740,
        endpoint.path == "/ingest/ios", endpoint.user == nil, endpoint.password == nil,
        endpoint.query == nil, endpoint.fragment == nil
      else { return nil }
      return Self(
        endpoint: endpoint, key: key, payloads: environment["MUSICMUTE_LOG_PAYLOADS"] == "1",
        console: environment["MUSICMUTE_LOG_CONSOLE"] == "1")
    }
  }

  private final class LocalLogDelivery: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    static let shared = LocalLogDelivery()
    let instanceID = UUID().uuidString.lowercased()
    let configuration = LocalLogConfiguration.load()
    private let lock = NSLock()
    private var pending = LocalLogQueue()
    private var active = false
    private var sent = 0
    private var failed = 0
    private lazy var session: URLSession = {
      let config = URLSessionConfiguration.ephemeral
      config.httpShouldSetCookies = false
      config.httpCookieStorage = nil
      config.urlCache = nil
      config.timeoutIntervalForRequest = 2
      config.timeoutIntervalForResource = 3
      config.httpMaximumConnectionsPerHost = 1
      return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    func status() -> [String: Int] {
      lock.lock()
      defer { lock.unlock() }
      return [
        "pending": pending.count + (active ? 1 : 0), "sent": sent, "failed": failed,
        "dropped": pending.dropped,
      ]
    }

    func enqueue(_ bytes: Data, level: String) {
      guard bytes.count <= 32_768 else { return }
      lock.lock()
      guard pending.offer(.init(bytes: bytes, level: level)) else {
        lock.unlock()
        return
      }
      let start = !active
      if start { active = true }
      lock.unlock()
      if start { pump() }
    }

    private func pump() {
      lock.lock()
      guard let config = configuration, let record = pending.take() else {
        active = false
        lock.unlock()
        return
      }
      let bytes = record.bytes
      lock.unlock()
      var request = URLRequest(url: config.endpoint)
      request.httpMethod = "POST"
      request.httpBody = bytes
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.setValue(config.key, forHTTPHeaderField: "x-musicmute-log-key")
      session.dataTask(with: request) { [self] _, response, error in
        lock.lock()
        if error == nil, let http = response as? HTTPURLResponse,
          (200...299).contains(http.statusCode)
        {
          sent += 1
        } else {
          failed += 1
        }
        lock.unlock()
        pump()
      }.resume()
    }

    func urlSession(
      _ session: URLSession, task: URLSessionTask,
      willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
      completionHandler: @escaping (URLRequest?) -> Void
    ) {
      completionHandler(nil)
    }
  }
#endif
