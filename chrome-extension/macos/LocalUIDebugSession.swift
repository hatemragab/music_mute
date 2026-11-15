import CryptoKit
import Darwin
import Foundation

/// Only a source DEBUG bundle with a sealed, private workspace session can redirect GUI state.
/// Release binaries have no activation branch, regardless of Info.plist or environment values.
struct LocalUIDebugSession: Sendable {
  let support: URL
  let sessionID: String
  static let current: LocalUIDebugSession? = {
    #if DEBUG
      guard let fields = Bundle.main.infoDictionary,
        let workspace = fields["MusicMuteDebugWorkspace"] as? String,
        let session = fields["MusicMuteDebugSession"] as? String,
        let root = fields["MusicMuteDebugSupport"] as? String,
        let identifier = Bundle.main.bundleIdentifier
      else { return nil }
      return validated(workspace: workspace, session: session, root: root, bundleID: identifier)
    #else
      return nil
    #endif
  }()
  static var active: Bool { current != nil }

  /// Finder/CUA launch has no shell environment. Only a validated DEBUG session may read this
  /// fixed private collector capability; it is never copied into the app bundle or a UI event.
  func loggingKey() -> String? {
    #if DEBUG
      let file = support.deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("keys.json")
      guard
        let bytes = try? RuntimeFileSecurity.readRegularFile(
          file, maximumBytes: 16384, requireCurrentOwner: true, privatePermissions: true,
          code: "DEBUG_UI_LOG_KEY_INVALID"),
        let value = try? JSONDecoder().decode(DesktopJSON.self, from: bytes),
        let key = value["keys"]["macos"].string, (16...512).contains(key.utf8.count),
        !key.contains(where: { $0.isWhitespace || $0.isNewline })
      else { return nil }
      return key
    #else
      return nil
    #endif
  }

  static func validated(workspace: String, session: String, root: String, bundleID: String)
    -> LocalUIDebugSession?
  {
    #if DEBUG
      guard UUID(uuidString: session)?.uuidString.lowercased() == session,
        bundleID == "com.hatem.musicmute.local.debug.\(session)",
        workspace.hasPrefix("/"), !workspace.contains("\0"),
        root
          == URL(fileURLWithPath: workspace).appendingPathComponent(
            ".runtime/local-logging/macos-ui/\(session)/support"
          ).path
      else { return nil }
      let url = URL(fileURLWithPath: root, isDirectory: true)
      guard url.standardizedFileURL.path == root,
        url.resolvingSymlinksInPath().path == root
      else { return nil }
      for directory in [url.deletingLastPathComponent(), url] {
        var info = stat()
        guard lstat(directory.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
          info.st_uid == geteuid(), info.st_mode & 0o077 == 0
        else { return nil }
      }
      return Self(support: url, sessionID: session)
    #else
      return nil
    #endif
  }

  func fixtureTrack() -> DesktopTrack? {
    let file = support.appendingPathComponent("fixture-track.json")
    guard
      let bytes = try? RuntimeFileSecurity.readRegularFile(
        file, maximumBytes: 4096, requireCurrentOwner: true, privatePermissions: true,
        code: "DEBUG_UI_FIXTURE_INVALID"),
      let value = try? JSONDecoder().decode(DesktopJSON.self, from: bytes),
      let key = value["cache_key"].string, DiagnosticIdentity.validDigest(key),
      let size = value["bytes"].number, let count = Int64(exactly: size), count > 0,
      let duration = value["duration_seconds"].number, duration > 0, duration <= 60
    else { return nil }
    let audio = support.appendingPathComponent("cache/vocals/\(key)/vocals.mp3")
    guard LocalPaths.descendant(audio.path, of: support) != nil,
      FileManager.default.fileExists(atPath: audio.path)
    else { return nil }
    return DesktopTrack(
      id: key, title: "Owned synthetic tone", duration: duration, path: audio, jobId: nil,
      bytes: count, sourceVideoId: nil)
  }
}

#if DEBUG
  @MainActor final class LocalUIDebugVault: DesktopCredentialVault {
    func load() async throws -> DesktopCredential? { nil }
    func save(_ credential: DesktopCredential) throws { throw DesktopAuthFailure.configuration }
    func remove() throws {}
  }

  struct LocalUIDebugHTTPTransport: DesktopHTTPTransport {
    func send(_ request: URLRequest) async throws -> (Data, Int) {
      throw DesktopAuthFailure.configuration
    }
  }
#endif
