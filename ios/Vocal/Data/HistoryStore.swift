import Foundation

actor HistoryStore {
  private let file: URL
  private var savedRevision = -1

  init(file: URL) { self.file = file }

  func load() throws -> [AudioRecord] {
    guard FileManager.default.fileExists(atPath: file.path) else { return [] }
    // Report corruption; never silently replace the user's history with an empty list.
    return try JSONDecoder().decode([AudioRecord].self, from: Data(contentsOf: file))
  }

  func save(_ records: [AudioRecord], revision: Int) throws {
    guard revision >= savedRevision else { return }
    try FileManager.default.createDirectory(
      at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try JSONEncoder().encode(records).write(to: file, options: .atomic)
    savedRevision = revision
  }
}
