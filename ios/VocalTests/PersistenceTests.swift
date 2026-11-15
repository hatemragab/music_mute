import XCTest

@testable import Vocal

final class PersistenceTests: XCTestCase {
  var root: URL!
  override func setUpWithError() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  }
  override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }

  func testHistorySurvivesReopeningAndRejectsStaleWrites() async throws {
    let file = root.appendingPathComponent("history.json")
    let store = HistoryStore(file: file)
    var record = AudioRecord(id: UUID(), videoID: "jNQXAC9IVRw", createdAt: Date())
    record.status = .complete
    record.title = "Saved audio"
    record.relativePath = "id/audio.m4a"
    try await store.save([record], revision: 2)
    try await store.save([], revision: 1)
    let reopened = try await HistoryStore(file: file).load()
    XCTAssertEqual(reopened, [record])
  }
  func testCorruptHistoryIsNotSilentlyOverwritten() async throws {
    let file = root.appendingPathComponent("history.json")
    let corrupt = Data("broken history".utf8)
    try corrupt.write(to: file)
    do {
      _ = try await HistoryStore(file: file).load()
      XCTFail("Expected corruption")
    } catch { XCTAssertEqual(try Data(contentsOf: file), corrupt) }
  }
  func testExportIsAnIndependentByteIdenticalCopy() async throws {
    let files = AudioFiles(root: root)
    let original = root.appendingPathComponent("audio.m4a")
    let bytes = Data((0..<32_789).map { UInt8($0 % 251) })
    try bytes.write(to: original)
    var record = AudioRecord(id: UUID(), videoID: "jNQXAC9IVRw", createdAt: Date())
    record.status = .complete
    record.title = "Original"
    record.fileExtension = "m4a"
    record.relativePath = "audio.m4a"
    let exported = try await files.exportCopy(of: record)
    XCTAssertEqual(try Data(contentsOf: exported), bytes)
    XCTAssertEqual(try Data(contentsOf: original), bytes)
    XCTAssertNotEqual(exported, original)
    await files.removeExport(exported)
    XCTAssertTrue(FileManager.default.fileExists(atPath: original.path))
  }
  func testFileResolutionConfinesPathsToAudioRoot() {
    let files = AudioFiles(root: root)
    XCTAssertNil(files.url(for: "../outside.m4a"))
    XCTAssertNil(files.url(for: ""))
  }
  @MainActor func testPreferencesDefaultAndPersistAcrossInstances() {
    let suite = "VocalTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let first = AppPreferences(defaults: defaults)
    XCTAssertEqual(first.language, .system)
    first.language = .ar
    first.appearance = .dark
    let second = AppPreferences(defaults: defaults)
    XCTAssertEqual(second.language, .ar)
    XCTAssertEqual(second.appearance, .dark)
    XCTAssertEqual(second.direction, .rightToLeft)
    defaults.set("invalid", forKey: "appearance")
    XCTAssertEqual(AppPreferences(defaults: defaults).appearance, .system)
  }
}
