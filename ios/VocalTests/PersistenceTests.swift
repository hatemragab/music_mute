import XCTest

@testable import Vocal

final class PersistenceTests: XCTestCase {
  func testUnknownPipelinePhaseStopsRecovery() throws {
    let phase = try JSONDecoder().decode(
      AudioPipelinePhase.self, from: Data("\"unsupportedPhase\"".utf8))
    XCTAssertEqual(phase, .failed)
  }

  var root: URL!
  override func setUpWithError() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  }
  override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }

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
