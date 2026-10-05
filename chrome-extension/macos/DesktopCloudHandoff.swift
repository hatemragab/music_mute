import Foundation

/// A browser handoff is only a prefilled form. It never authorizes cloud work.
struct DesktopCloudHandoff: Equatable, Sendable {
  let requestID = UUID()
  let videoID: String
  let estimatedDurationSeconds: Int?

  var sourceURL: String { "https://www.youtube.com/watch?v=\(videoID)" }

  init?(url: URL) {
    guard url.absoluteString.utf8.count <= 512,
      let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
      parts.scheme == "musicmute-local", parts.host == "cloud",
      parts.path.isEmpty || parts.path == "/", parts.user == nil, parts.password == nil,
      parts.port == nil, parts.fragment == nil,
      let items = parts.queryItems, (1...2).contains(items.count),
      items.allSatisfy({ ["video_id", "duration_seconds"].contains($0.name) }),
      Set(items.map(\.name)).count == items.count,
      let id = items.first(where: { $0.name == "video_id" })?.value,
      id.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil
    else { return nil }
    let seconds: Int?
    if let duration = items.first(where: { $0.name == "duration_seconds" }) {
      guard let text = duration.value,
        text.range(of: "^[1-9][0-9]{0,3}$", options: .regularExpression) != nil,
        let value = Int(text), (1...DesktopMediaLimits.maxDurationSeconds).contains(value)
      else { return nil }
      seconds = value
    } else {
      seconds = nil
    }
    videoID = id
    estimatedDurationSeconds = seconds
  }
}

/// Freeze the chosen source and account while the confirmation is visible.
struct DesktopCloudConfirmation: Equatable, Sendable {
  let sourceURL: String?
  let sourceFile: URL?
  let accountScope: DesktopSessionScope
  let estimatedDurationSeconds: Int?

  func matches(url: String?, file: URL?, scope: DesktopSessionScope?, hasRights: Bool) -> Bool {
    hasRights && sourceURL == url && sourceFile == file && accountScope == scope
  }
}
