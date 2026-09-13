import Foundation

enum PreparedMediaCleanup {
  static var photoRoot: URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("MusicMutePhotoImport")
  }
  static func discardPhotoCopy(_ url: URL) {
    let directory = url.deletingLastPathComponent()
    guard url.isFileURL, UUID(uuidString: directory.lastPathComponent) != nil,
      directory.deletingLastPathComponent().standardizedFileURL == photoRoot.standardizedFileURL,
      directory.resolvingSymlinksInPath().deletingLastPathComponent()
        == photoRoot.resolvingSymlinksInPath()
    else { return }
    try? FileManager.default.removeItem(at: directory)
  }
}
