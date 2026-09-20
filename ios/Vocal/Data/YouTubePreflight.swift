import Foundation

enum YouTubePreflight {
  static let maximumDownloadBytes = ProcessingMediaPolicy.standard.maxSourceDownloadBytes!
  static let maximumDownloadSeconds = ProcessingMediaPolicy.standard.maxSourceDownloadSeconds!

  static func isIndividualURL(_ value: String) -> Bool {
    guard YouTubeURL.videoID(from: value) != nil,
      let components = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines))
    else { return false }
    return !(components.queryItems ?? []).contains { $0.name.lowercased() == "list" }
  }

  static func validate(duration: Double?, isLive: Bool?, isUpcoming: Bool?) throws {
    guard isLive != true, isUpcoming != true else { throw AudioInputPreparationError.youtubeLive }
    guard isLive == false, isUpcoming == false, let duration, duration.isFinite, duration > 0 else {
      throw AudioInputPreparationError.youtubeMetadataUnavailable
    }
    guard duration <= ProcessingMediaPolicy.standard.maxDuration else {
      throw AudioInputPreparationError.tooLong
    }
  }
}

extension YouTubePreflight {
  static let maximumMetadataBytes = 5_000_000

  /// A public watch-page response is obtained locally, without accounts, cookies,
  /// proxies, remote extraction, or bypassing consent/availability restrictions.
  static func inspectRecording(videoID: String) async throws -> Double {
    guard let canonical = YouTubeURL.canonicalURL(videoID: videoID),
      let url = URL(string: canonical)
    else {
      throw AudioInputPreparationError.youtubeMetadataUnavailable
    }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 15
    configuration.timeoutIntervalForResource = 30
    configuration.httpShouldSetCookies = false
    configuration.httpCookieStorage = nil
    configuration.urlCredentialStorage = nil
    let session = URLSession(
      configuration: configuration, delegate: MetadataRedirectPolicy(), delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    var request = URLRequest(url: url)
    request.setValue("Mozilla/5.0", forHTTPHeaderField: "User-Agent")
    let started = Date()
    let (stream, response) = try await session.bytes(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode == 200,
      response.expectedContentLength <= Int64(maximumMetadataBytes),
      response.url?.scheme == "https", response.url?.host == "www.youtube.com"
    else {
      throw AudioInputPreparationError.youtubeMetadataUnavailable
    }
    var bytes = Data()
    for try await byte in stream {
      guard bytes.count < maximumMetadataBytes else {
        throw AudioInputPreparationError.youtubeMetadataUnavailable
      }
      bytes.append(byte)
      if bytes.count % 65_536 == 0 {
        try Task.checkCancellation()
        guard Date().timeIntervalSince(started) < 30 else { throw URLError(.timedOut) }
      }
    }
    return try parseWatchPage(bytes, videoID: videoID)
  }

  static func parseWatchPage(_ data: Data, videoID: String) throws -> Double {
    struct PlayerResponse: Decodable {
      struct Status: Decodable { let status: String }
      struct Details: Decodable {
        let videoId: String
        let lengthSeconds: String?
        let isLiveContent: Bool?
        let isLive: Bool?
        let isUpcoming: Bool?
      }
      let playabilityStatus: Status
      let videoDetails: Details
    }
    guard data.count <= maximumMetadataBytes, let html = String(data: data, encoding: .utf8) else {
      throw AudioInputPreparationError.youtubeMetadataUnavailable
    }
    let pattern =
      #"(?:var\s+)?(?:ytInitialPlayerResponse|window\["ytInitialPlayerResponse"\])\s*=\s*\{"#
    let expression = try NSRegularExpression(pattern: pattern)
    guard let match = expression.firstMatch(in: html, range: NSRange(html.startIndex..., in: html)),
      let range = Range(match.range, in: html),
      let start = html[range].lastIndex(of: "{")
    else {
      throw AudioInputPreparationError.youtubeMetadataUnavailable
    }
    var depth = 0
    var quoted = false
    var escaped = false
    var end: String.Index?
    for index in html.indices where index >= start {
      let character = html[index]
      if quoted {
        if escaped {
          escaped = false
        } else if character == "\\" {
          escaped = true
        } else if character == "\"" {
          quoted = false
        }
      } else if character == "\"" {
        quoted = true
      } else if character == "{" {
        depth += 1
      } else if character == "}" {
        depth -= 1
        if depth == 0 {
          end = html.index(after: index)
          break
        }
      }
    }
    guard let end,
      let response = try? JSONDecoder().decode(
        PlayerResponse.self, from: Data(html[start..<end].utf8)),
      response.playabilityStatus.status == "OK", response.videoDetails.videoId == videoID
    else {
      throw AudioInputPreparationError.youtubeMetadataUnavailable
    }
    let details = response.videoDetails
    guard details.isLive != true else { throw AudioInputPreparationError.youtubeLive }
    let duration = details.lengthSeconds.flatMap(Double.init)
    try validate(
      duration: duration, isLive: details.isLiveContent, isUpcoming: details.isUpcoming ?? false)
    return duration!
  }
}

private final class MetadataRedirectPolicy: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    // Consent/login/cross-origin pages are not extraction fallbacks.
    completionHandler(nil)
  }
}
