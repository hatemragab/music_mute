import XCTest

@testable import Vocal

private actor ScriptedDownloader: AudioDownloading {
  var calls = 0
  let failFirst: Bool
  init(failFirst: Bool = false) { self.failFirst = failFirst }
  func download(
    videoID: String, id: UUID, stage: @escaping @Sendable (DownloadStatus) -> Void,
    progress: @escaping @Sendable (DownloadProgress) -> Void
  ) async throws -> SavedAudio {
    calls += 1
    let attempt = calls
    stage(.downloading)
    progress(DownloadProgress(downloadedBytes: 617, totalBytes: 1234))
    try await Task.sleep(for: .milliseconds(150))
    if failFirst && attempt == 1 { throw AudioFailure.network }
    return SavedAudio(
      title: "Test audio", relativePath: "\(id)/audio.m4a", codec: "AAC", fileExtension: "m4a",
      bitrate: 128000, byteCount: 1234, duration: 19)
  }
}

@MainActor final class DownloadModelTests: XCTestCase {
  var root: URL!
  var defaults: UserDefaults!
  var suite: String!
  override func setUpWithError() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    suite = "VocalTests.\(UUID().uuidString)"
    defaults = UserDefaults(suiteName: suite)!
  }
  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: root)
    defaults.removePersistentDomain(forName: suite)
  }
  func testUnchangedTextBindingDoesNotClearValidationOnKeyboardDismissal() {
    let model = make(ScriptedDownloader())
    model.urlText = "https://example.com/video"
    model.invalidURL = true
    model.urlText = "https://example.com/video"
    XCTAssertTrue(model.invalidURL)
    model.urlText = "https://example.com/other"
    XCTAssertFalse(model.invalidURL)
  }

  func testProgressCompletionAndDuplicateActiveStart() async throws {
    let service = ScriptedDownloader()
    let model = make(service)
    await model.load()
    model.urlText = "https://youtu.be/jNQXAC9IVRw"
    let started = await model.start()
    XCTAssertTrue(started)
    _ = await model.start()
    XCTAssertEqual(model.records.count, 1)
    try await waitUntil { model.records.first?.status == .complete }
    XCTAssertEqual(model.records.first?.codec, "AAC")
    XCTAssertEqual(model.records.first?.progress, 1)
    let calls = await service.calls
    XCTAssertEqual(calls, 1)
  }
  func testCancellationCannotBeOverwrittenByLateProgressAndRetryUsesFreshID() async throws {
    let model = make(ScriptedDownloader())
    await model.load()
    model.urlText = "https://youtu.be/jNQXAC9IVRw"
    _ = await model.start()
    let original = model.records[0]
    model.cancel(original.id)
    await model.retry(model.records[0])
    try await waitUntil { model.records.first?.status == .complete }
    XCTAssertEqual(model.records.last?.status, .cancelled)
    XCTAssertNotEqual(model.records.first?.id, original.id)
  }
  func testFailureCanBeRetriedSuccessfully() async throws {
    let model = make(ScriptedDownloader(failFirst: true))
    await model.load()
    model.urlText = "https://youtu.be/jNQXAC9IVRw"
    _ = await model.start()
    try await waitUntil { model.records.first?.status == .failed }
    XCTAssertEqual(model.records.first?.failure, .network)
    await model.retry(model.records[0])
    try await waitUntil { model.records.first?.status == .complete }
    XCTAssertEqual(model.records.last?.status, .failed)
  }
  func testInvalidInputDoesNotStartWork() async {
    let model = make(ScriptedDownloader())
    await model.load()
    model.urlText = "not a URL"
    let started = await model.start()
    XCTAssertFalse(started)
    XCTAssertTrue(model.invalidURL)
    XCTAssertTrue(model.records.isEmpty)
  }
  func testInterruptedWorkIsRestoredAsRetryableFailure() async throws {
    let store = HistoryStore(file: root.appendingPathComponent("history.json"))
    let pending = AudioRecord(id: UUID(), videoID: "jNQXAC9IVRw", createdAt: Date())
    try await store.save([pending], revision: 0)
    let model = DownloadModel(service: ScriptedDownloader(), history: store, defaults: defaults)
    await model.load()
    XCTAssertEqual(model.records.first?.status, .failed)
    XCTAssertEqual(model.records.first?.failure, .interrupted)
  }
  private func make(_ service: ScriptedDownloader) -> DownloadModel {
    DownloadModel(
      service: service, history: HistoryStore(file: root.appendingPathComponent("history.json")),
      defaults: defaults)
  }
  private func waitUntil(_ condition: () -> Bool) async throws {
    for _ in 0..<100 {
      if condition() { return }
      try await Task.sleep(for: .milliseconds(20))
    }
    XCTFail("State did not settle")
  }
}
