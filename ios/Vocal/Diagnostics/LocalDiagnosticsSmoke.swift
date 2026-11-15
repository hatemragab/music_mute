#if DEBUG
  import Foundation

  /// Isolated verification through the production transport, without any external API request.
  /// The URLProtocol belongs only to this dedicated session and is never registered globally.
  @MainActor enum LocalDiagnosticsSmoke {
    static func run() async {
      guard LocalDiagnostics.enabled,
        ProcessInfo.processInfo.arguments.contains("--processing-ui-fixture")
      else { return }
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [LocalDiagnosticsSmokeProtocol.self]
      let transport = AuthHTTPTransport(
        configuration: AuthConfiguration(
          apiOrigin: URL(string: "https://musicmute-diagnostics.invalid")!),
        sessionConfiguration: configuration)
      let context = LocalDiagnostics.Context(userID: nil, traceID: UUID().uuidString.lowercased())
      await LocalDiagnostics.$context.withValue(context) {
        let body = Data(
          #"{"password":"MUSICMUTE_NATIVE_SECRET_CANARY","nested":{"apiKey":"MUSICMUTE_NATIVE_SECRET_CANARY"},"result":"synthetic"}"#
            .utf8)
        for path in ["/synthetic-success", "/synthetic-error"] {
          _ = try? await transport.perform(
            method: "POST", path: path, body: body, bearer: "MUSICMUTE_NATIVE_SECRET_CANARY",
            headers: ["X-MusicMute-Diagnostics-Fixture": "isolated-urlprotocol"])
        }
        let cancelled = Task {
          _ = try? await transport.perform(
            method: "GET", path: "/synthetic-abort", body: nil, bearer: nil,
            headers: ["X-MusicMute-Diagnostics-Fixture": "isolated-urlprotocol"])
        }
        try? await Task.sleep(for: .milliseconds(100))
        cancelled.cancel()
        await cancelled.value
        try? await Task.sleep(for: .seconds(3))
        LocalDiagnostics.emit(
          "diagnostics.smoke_after_idle", category: "diagnostics",
          data: ["result": "synthetic", "phase": "after_native_idle", "idleSeconds": 3])
      }
    }
  }

  private final class LocalDiagnosticsSmokeProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
      request.url?.host == "musicmute-diagnostics.invalid"
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
      guard let url = request.url else { return }
      if url.path == "/synthetic-abort" { return }
      let status = url.path == "/synthetic-error" ? 503 : 200
      var headers = ["Content-Type": "application/json"]
      if let id = request.value(forHTTPHeaderField: "X-Request-Id") { headers["X-Request-Id"] = id }
      let response = HTTPURLResponse(
        url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(
        self,
        didLoad: Data(
          #"{"result":"synthetic","access_token":"MUSICMUTE_NATIVE_SECRET_CANARY"}"#.utf8))
      client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
  }
#endif
