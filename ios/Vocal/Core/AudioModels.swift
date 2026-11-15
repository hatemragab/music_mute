import Foundation

enum DownloadStatus: String, Codable, Sendable {
  case queued, resolving, downloading, checking, complete, failed, cancelled
  var isActive: Bool { [.queued, .resolving, .downloading, .checking].contains(self) }
  var label: String { "status_\(rawValue)" }
}

enum AudioFailure: String, Error, Codable, Sendable {
  case unavailable, network, storage, interrupted, invalidAudio
  var label: String { "error_\(rawValue)" }
}

struct AudioRecord: Identifiable, Codable, Equatable, Sendable {
  let id: UUID
  let videoID: String
  let createdAt: Date
  var status: DownloadStatus = .queued
  var title = ""
  var relativePath = ""
  var codec = ""
  var fileExtension = ""
  var bitrate = 0
  var byteCount: Int64 = 0
  var duration: Double = 0
  var progress: Double = 0
  var failure: AudioFailure?
  var downloadedBytes: Int64?
  var totalBytes: Int64?
}

struct DownloadProgress: Sendable {
  let downloadedBytes: Int64
  let totalBytes: Int64?
  var fraction: Double? {
    guard let totalBytes, totalBytes > 0 else { return nil }
    return min(0.99, max(0, Double(downloadedBytes) / Double(totalBytes)))
  }
}

struct AudioCandidate: Sendable {
  let url: URL
  let hasVideo: Bool
  let codec: String
  let fileExtension: String
  let bitrate: Int
  let isPlayable: Bool
}

struct ResolvedAudio: Sendable {
  let title: String
  let stream: AudioCandidate
}

struct SavedAudio: Sendable {
  let title: String
  let relativePath: String
  let codec: String
  let fileExtension: String
  let bitrate: Int
  let byteCount: Int64
  let duration: Double
}

enum AudioPolicy {
  // Keep the best eligible AAC audio stream; a higher stream needs mobile preparation.
  static func bestCompatibleAudio(_ candidates: [AudioCandidate]) throws -> AudioCandidate {
    let compatible = candidates.filter { candidate in
      !candidate.hasVideo && candidate.isPlayable && candidate.codec == "AAC"
        && candidate.fileExtension == "m4a" && candidate.url.scheme == "https"
        && candidate.url.user == nil && candidate.url.password == nil
        && candidate.url.host?.lowercased().hasSuffix(".googlevideo.com") == true
    }
    let withinCap = compatible.filter { $0.bitrate > 0 && $0.bitrate <= 160_000 }
    let selected =
      withinCap.max(by: { $0.bitrate < $1.bitrate })
      ?? compatible.filter { $0.bitrate > 160_000 }.min(by: { $0.bitrate < $1.bitrate })
      ?? compatible.first
    guard let selected else { throw AudioFailure.unavailable }
    return selected
  }

  static func exportName(title: String, fileExtension: String) -> String {
    let invalid = CharacterSet(charactersIn: "/\\:*?\"<>|").union(.controlCharacters)
    let clean = title.components(separatedBy: invalid).joined(separator: "_")
      .trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: ".")))
    var stem = ""
    for character in clean {
      guard stem.utf8.count + String(character).utf8.count <= 180 else { break }
      stem.append(character)
    }
    if stem.isEmpty { stem = "MusicMute" }
    return "\(stem).\(fileExtension == "m4a" ? "m4a" : "aac")"
  }
}

enum YouTubeURL {
  static func canonicalURL(from value: String) -> String? {
    guard let videoID = videoID(from: value) else { return nil }
    return canonicalURL(videoID: videoID)
  }

  static func canonicalURL(videoID: String) -> String? {
    guard videoID.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil else {
      return nil
    }
    return "https://www.youtube.com/watch?v=\(videoID)"
  }

  static func videoID(from value: String) -> String? {
    guard let parts = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
      ["https", "http"].contains(parts.scheme?.lowercased() ?? ""),
      parts.user == nil, parts.password == nil,
      parts.port == nil, let host = parts.host?.lowercased()
    else { return nil }
    let segments = parts.path.split(separator: "/").map(String.init)
    var id: String?
    if host == "youtu.be", segments.count == 1 {
      id = segments.first
    } else if ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].contains(
      host)
    {
      if parts.path == "/watch" {
        let ids = parts.queryItems?.filter { $0.name == "v" } ?? []
        if ids.count == 1 { id = ids[0].value }
      } else if segments.count == 2, ["shorts", "embed", "live"].contains(segments[0]) {
        id = segments[1]
      }
    }
    guard let id, id.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil else {
      return nil
    }
    return id
  }
}
