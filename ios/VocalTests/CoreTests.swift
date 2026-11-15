import AVFoundation
import FirebaseCore
import SwiftUI
import UIKit
import XCTest

@testable import Vocal

final class CoreTests: XCTestCase {
  @MainActor func testArtworkKeepsExistingFallbackForMissingUnsafeLoadingAndFailure() throws {
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: 160, height: 90))
    let fixture = renderer.image { context in
      UIColor.systemBlue.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 160, height: 90))
    }
    func snapshot(_ url: String?, phase: AsyncImagePhase) throws -> Data {
      let view = JobArtwork(url: url.flatMap(URL.init(string:)), cornerRadius: 14) {
        Color.orange.overlay { Image(systemName: "waveform").foregroundStyle(.black) }
      }
      .frame(width: 96, height: 96)
      .environment(\.artworkFixturePhase, phase)
      let image = try XCTUnwrap(ImageRenderer(content: view).uiImage)
      XCTAssertEqual(image.size, CGSize(width: 96, height: 96))
      return try XCTUnwrap(image.pngData())
    }
    let original = "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg"
    let placeholder = try snapshot(nil, phase: .empty)
    XCTAssertEqual(try snapshot(original, phase: .empty), placeholder)
    XCTAssertEqual(
      try snapshot(original, phase: .failure(URLError(.cannotDecodeContentData))), placeholder)
    XCTAssertEqual(
      try snapshot("https://unsafe.invalid/image.jpg", phase: .success(Image(uiImage: fixture))),
      placeholder)
    XCTAssertNotEqual(try snapshot(original, phase: .success(Image(uiImage: fixture))), placeholder)
  }

  func testFirebaseConfigurationMatchesMusicMute() {
    let app = FirebaseApp.app()
    XCTAssertNotNil(app)
    XCTAssertEqual(app?.options.projectID, "music-mute")
    XCTAssertEqual(app?.options.bundleID, "com.hatem.musicmute")
    XCTAssertEqual(app?.options.googleAppID, "1:412717301830:ios:29c661efe91a5b76a9ca47")
  }
  func testPlaybackTimeHandlesHoursAndInvalidValues() {
    XCTAssertEqual(audioTime(3661), "1:01:01")
    XCTAssertEqual(audioTime(61), "1:01")
    XCTAssertEqual(audioTime(-1), "0:00")
    XCTAssertEqual(audioTime(.infinity), "0:00")
  }

  func testSupportedPlatformLinksMatchReviewedProductDestinations() {
    XCTAssertEqual(
      musicMutePlatformURL(.web)?.absoluteString,
      "https://app.music-mute.com")
    XCTAssertEqual(
      musicMutePlatformURL(.macOS)?.absoluteString,
      "https://music-mute.com/#downloads")
  }

  func testSupportedPlatformLinksRejectUnsafeOrSpeculativeDestinations() {
    XCTAssertNil(musicMutePlatformURL(.web, candidate: "http://app.music-mute.com"))
    XCTAssertNil(
      musicMutePlatformURL(.web, candidate: "https://app.music-mute.com.evil.example"))
    XCTAssertNil(musicMutePlatformURL(.web, candidate: "https://user@app.music-mute.com"))
    XCTAssertNil(
      musicMutePlatformURL(.web, candidate: "https://app.music-mute.com/?campaign=mobile"))
    XCTAssertNil(musicMutePlatformURL(.macOS, candidate: "https://music-mute.com/#other"))
    XCTAssertNil(
      musicMutePlatformURL(
        .macOS, candidate: "https://music-mute.com/MusicMute.dmg#downloads"))
  }

  @MainActor func testAccentValidationAndPersistence() {
    XCTAssertEqual(AppPreferences.normalizedAccent(" #ff814a "), "#FF814A")
    XCTAssertNil(AppPreferences.normalizedAccent("orange"))
    XCTAssertNil(AppPreferences.normalizedAccent("#12345"))
    let name = "AppPreferencesTests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    defer { defaults.removePersistentDomain(forName: name) }
    let preferences = AppPreferences(defaults: defaults)
    XCTAssertEqual(preferences.appearance, .system)
    preferences.setAccent("#62a8ff")
    XCTAssertEqual(AppPreferences(defaults: defaults).accentHex, "#62A8FF")
  }

  @MainActor func testPlaybackControlsClampUnsafeValues() {
    let player = AudioPlayer()
    player.setSpeed(-2)
    player.setVolume(4)
    XCTAssertEqual(player.speed, 0.5)
    XCTAssertEqual(player.volume, 1)
    player.setSpeed(1.25)
    player.setVolume(0.35)
    XCTAssertEqual(player.speed, 1.25)
    XCTAssertEqual(player.volume, 0.35, accuracy: 0.001)
  }

  @MainActor func testLibraryPreferencesStayOwnerScopedAndPersisted() {
    let name = "LibraryPreferencesTests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    defer { defaults.removePersistentDomain(forName: name) }
    let preferences = LibraryPreferencesStore(defaults: defaults)

    preferences.bind("owner-a")
    preferences.toggleFavorite("job-1")
    preferences.toggleHidden("job-2")
    preferences.recordPlayback("job-1", ownerUID: "owner-a")
    preferences.recordPlayback("job-1", ownerUID: "owner-a")
    XCTAssertEqual(preferences.favorites, ["job-1"])
    XCTAssertEqual(preferences.hidden, ["job-2"])
    XCTAssertEqual(preferences.playCounts, ["job-1": 2])

    preferences.bind("owner-b")
    XCTAssertTrue(preferences.favorites.isEmpty)
    XCTAssertTrue(preferences.hidden.isEmpty)
    XCTAssertTrue(preferences.playCounts.isEmpty)
    preferences.recordPlayback("job-1", ownerUID: "owner-a")
    XCTAssertTrue(preferences.playCounts.isEmpty)

    preferences.bind("owner-a")
    XCTAssertEqual(preferences.favorites, ["job-1"])
    XCTAssertEqual(preferences.hidden, ["job-2"])
    XCTAssertEqual(preferences.playCounts, ["job-1": 2])
    let reopened = LibraryPreferencesStore(defaults: defaults)
    reopened.bind("owner-a")
    XCTAssertEqual(reopened.playCounts, ["job-1": 2])
  }

  @MainActor func testLibraryPreferencesUpgradeRetainsStarsAndRemovedTracks() throws {
    let name = "LibraryUpgradeTests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    defer { defaults.removePersistentDomain(forName: name) }
    defaults.set(
      Data(#"{"favorites":["starred"],"hidden":["removed"]}"#.utf8),
      forKey: "musicmute.ios.library.owner")
    let preferences = LibraryPreferencesStore(defaults: defaults)
    preferences.bind("owner")
    XCTAssertEqual(preferences.favorites, ["starred"])
    XCTAssertEqual(preferences.hidden, ["removed"])
    XCTAssertTrue(preferences.playCounts.isEmpty)
    preferences.recordPlayback("starred", ownerUID: "owner")
    let reopened = LibraryPreferencesStore(defaults: defaults)
    reopened.bind("owner")
    XCTAssertEqual(reopened.favorites, ["starred"])
    XCTAssertEqual(reopened.hidden, ["removed"])
    XCTAssertEqual(reopened.playCounts, ["starred": 1])
  }

  @MainActor func testLibraryCountsValidateAndSaturate() {
    let name = "LibraryCountTests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    defer { defaults.removePersistentDomain(forName: name) }
    let json =
      "{\"favorites\":[],\"hidden\":[],\"playCounts\":{\"\":9,\"negative\":-1,\"full\":\(Int.max)}}"
    defaults.set(Data(json.utf8), forKey: "musicmute.ios.library.owner")
    let preferences = LibraryPreferencesStore(defaults: defaults)
    preferences.bind("owner")
    preferences.recordPlayback("full", ownerUID: "owner")
    XCTAssertEqual(preferences.playCounts, ["full": Int.max])
    preferences.bind("")
    preferences.recordPlayback("track", ownerUID: "owner")
    XCTAssertTrue(preferences.playCounts.isEmpty)
  }

  @MainActor func testMalformedPlayCountsKeepExistingStarsAndValidCounts() {
    let name = "LibraryMalformedCountsTests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    defer { defaults.removePersistentDomain(forName: name) }
    for (index, counts) in [
      #"{"valid":3,"text":"wrong","nested":{},"negative":-1}"#,
      #"[1,2]"#,
      #""wrong""#,
    ].enumerated() {
      let owner = "owner-\(index)"
      let json = "{\"favorites\":[\"starred\"],\"hidden\":[\"removed\"],\"playCounts\":\(counts)}"
      defaults.set(Data(json.utf8), forKey: "musicmute.ios.library.\(owner)")
      let preferences = LibraryPreferencesStore(defaults: defaults)
      preferences.bind(owner)
      XCTAssertEqual(preferences.favorites, ["starred"])
      XCTAssertEqual(preferences.hidden, ["removed"])
      XCTAssertEqual(preferences.playCounts, index == 0 ? ["valid": 3] : [:])
      preferences.recordPlayback("starred", ownerUID: owner)
      XCTAssertEqual(preferences.playCounts["starred"], 1)
    }
  }

  func testLibraryMostPlayedCombinesStarsSearchAndRemovedState() {
    let jobs = [
      libraryJob("unplayed", title: "Voice new", created: 5),
      libraryJob("removed", title: "Voice hidden", created: 4),
      libraryJob("frequent", title: "Voice favorite", created: 3),
      libraryJob("other", title: "Voice other", created: 2),
      libraryJob("once", title: "Voice once", created: 1),
    ]
    let counts = ["removed": 99, "frequent": 5, "other": 7, "once": 1]
    func shown(_ starredOnly: Bool, filter: LibraryFilter = .mostPlayed) -> [String] {
      LibrarySelection.jobs(
        jobs, search: " voice ", filter: filter, sort: .newest, starredOnly: starredOnly,
        favorites: ["frequent", "removed"], hidden: ["removed"], cachedIDs: ["frequent"],
        playCounts: counts
      ).map(\.id)
    }
    XCTAssertEqual(shown(false), ["other", "frequent", "once"])
    XCTAssertEqual(shown(true), ["frequent"])
    XCTAssertEqual(shown(true, filter: .downloaded), ["frequent"])
    XCTAssertEqual(shown(true, filter: .removed), ["removed"])
    let sortedAll = LibrarySelection.jobs(
      jobs, search: "", filter: .all, sort: .mostPlayed, starredOnly: false,
      favorites: [], hidden: ["removed"], cachedIDs: [], playCounts: counts)
    XCTAssertEqual(sortedAll.map(\.id), ["other", "frequent", "once", "unplayed"])
  }

  func testLibrarySortTiesStayDeterministicAcrossSnapshots() {
    let jobs = [
      libraryJob("b", title: "Same", created: 2),
      libraryJob("a", title: "Same", created: 2),
      libraryJob("older", title: "Same", created: 1),
    ]
    for sort in LibrarySort.allCases {
      let result = LibrarySelection.jobs(
        jobs, search: "", filter: .all, sort: sort, starredOnly: false,
        favorites: [], hidden: [], cachedIDs: [], playCounts: ["a": 1, "b": 1, "older": 1])
      XCTAssertEqual(result.map(\.id), ["a", "b", "older"])
      let refreshed = LibrarySelection.jobs(
        jobs.reversed(), search: "", filter: .all, sort: sort, starredOnly: false,
        favorites: [], hidden: [], cachedIDs: [], playCounts: ["a": 1, "b": 1, "older": 1])
      XCTAssertEqual(refreshed.map(\.id), result.map(\.id))
    }
  }

  @MainActor func testPlaybackCountsStartsAndRestartsWithoutCountingResumeSeekOrSourceSwitch()
    throws
  {
    let file = try playbackFixture(duration: 5)
    defer { try? FileManager.default.removeItem(at: file) }
    let player = AudioPlayer()
    defer { player.stopAndClear() }
    let id = UUID()
    var started: [UUID] = []
    player.onPlaybackStarted = { started.append($0) }
    player.toggle(id: id, title: "Fixture", file: file)
    XCTAssertTrue(player.playing)
    XCTAssertEqual(started, [id])
    player.pause()
    player.seek(to: 1)
    player.resume()
    player.resume()
    try player.replaceSource(file: file, original: true, position: 1)
    XCTAssertEqual(started, [id])
    player.restart()
    XCTAssertEqual(started, [id, id])
    player.toggle(id: UUID(), title: "Missing", file: file.appendingPathExtension("missing"))
    XCTAssertTrue(player.failed)
    XCTAssertEqual(started, [id, id])
  }

  @MainActor func testSuccessfulNaturalRepeatCountsEachPass() async throws {
    let file = try playbackFixture(duration: 0.15)
    defer { try? FileManager.default.removeItem(at: file) }
    let player = AudioPlayer()
    defer { player.stopAndClear() }
    let completed = expectation(description: "two playback passes")
    var starts = 0
    var finishes = 0
    player.onPlaybackStarted = { _ in starts += 1 }
    player.onFinished = {
      finishes += 1
      if finishes == 1 { player.restart() } else { completed.fulfill() }
    }
    player.toggle(id: UUID(), title: "Repeat fixture", file: file)
    await fulfillment(of: [completed], timeout: 5)
    XCTAssertEqual(starts, 2)
    XCTAssertEqual(finishes, 2)
  }

  @MainActor func testNewerPlaybackSelectionFencesSlowPreparationAndCountsOnlyNewTrack()
    async throws
  {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let file = try playbackFixture(duration: 5)
    let suite = "PlaybackSelectionTests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer {
      try? FileManager.default.removeItem(at: root)
      try? FileManager.default.removeItem(at: file)
      defaults.removePersistentDomain(forName: suite)
    }
    let api = UnavailableJobsAPI()
    let staging = root.appendingPathComponent("Inputs")
    let store = ProcessingStore(root: root.appendingPathComponent("Store"), stagingRoot: staging)
    let repository = ProcessingRepository(api: api, store: store, transfers: PlaybackTransfers())
    let preparer = AudioInputPreparer(root: staging)
    let pipeline = AudioPipelineCoordinator(
      store: store, repository: repository, preparer: preparer)
    let player = AudioPlayer()
    defer { player.stopAndClear() }
    let preferences = LibraryPreferencesStore(defaults: defaults)
    var pendingA: CheckedContinuation<URL, Error>?
    var preparedA = false
    var pendingOriginal: CheckedContinuation<URL, Error>?
    var bOriginalRequests = 0
    let preparingA = expectation(description: "Older track preparation waits")
    let preparingOriginal = expectation(description: "Original source preparation waits")
    let model = ProcessingModel(
      api: api, repository: repository, preparer: preparer, pipeline: pipeline, player: player,
      outputFile: { id, _ in
        if id == "a", !preparedA {
          preparedA = true
          return try await withCheckedThrowingContinuation {
            pendingA = $0
            preparingA.fulfill()
          }
        }
        return file
      }, libraryPreferences: preferences,
      originalFile: { id, _ in
        if id == "b" {
          bOriginalRequests += 1
          if bOriginalRequests > 1 {
            return try await withCheckedThrowingContinuation {
              pendingOriginal = $0
              preparingOriginal.fulfill()
            }
          }
        }
        return file
      })
    await model.bindOwner("owner")
    model.autoPlayNext = false
    let a = libraryJob("a", title: "Older selection", created: 1)
    let b = libraryJob("b", title: "Newer selection", created: 2)
    model.play(a, queue: [a, b])
    await fulfillment(of: [preparingA], timeout: 2)
    let slowPreparation = try XCTUnwrap(pendingA)
    model.play(b, queue: [b, a])
    for _ in 0..<200 where model.currentPlaybackJobID != "b" {
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertEqual(model.currentPlaybackJobID, "b")
    XCTAssertEqual(preferences.playCounts, ["b": 1])
    slowPreparation.resume(returning: file)
    for _ in 0..<200 where model.busy { try await Task.sleep(for: .milliseconds(10)) }
    XCTAssertFalse(model.busy)
    XCTAssertEqual(model.currentPlaybackJobID, "b")
    XCTAssertEqual(preferences.playCounts, ["b": 1])
    XCTAssertEqual(model.playbackQueue.map(\.id), ["b", "a"])
    XCTAssertTrue(player.playing)

    model.selectOriginal(true)
    await fulfillment(of: [preparingOriginal], timeout: 2)
    let obsoleteSource = try XCTUnwrap(pendingOriginal)
    model.play(a, queue: [a, b])
    for _ in 0..<200 where model.currentPlaybackJobID != "a" {
      try await Task.sleep(for: .milliseconds(10))
    }
    obsoleteSource.resume(throwing: AuthFailure.offline)
    for _ in 0..<200 where model.busy { try await Task.sleep(for: .milliseconds(10)) }
    XCTAssertFalse(model.busy)
    XCTAssertEqual(model.currentPlaybackJobID, "a")
    XCTAssertEqual(preferences.playCounts, ["a": 1, "b": 1])
    XCTAssertFalse(player.original)
    XCTAssertNil(
      model.messageKey, "An obsolete source failure must not replace the new player's state")
  }

  private func libraryJob(_ id: String, title: String, created: TimeInterval) -> Job {
    let date = Date(timeIntervalSince1970: created)
    return Job(
      id: id, status: "ready", createdAt: date, updatedAt: date, queuedAt: nil,
      finishedAt: date, retryOfJobId: nil,
      input: Job.Input(extension: "mp3", bytes: 6, durationSeconds: 1), error: nil,
      canDownloadInput: true, canDownloadOutput: true, workerAvailable: nil, displayName: title)
  }

  private func playbackFixture(duration: Double) throws -> URL {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent(
      "library-playback-\(UUID().uuidString).wav")
    let format = AVAudioFormat(standardFormatWithSampleRate: 8_000, channels: 1)!
    let frames = AVAudioFrameCount(duration * 8_000)
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
    buffer.frameLength = frames
    let samples = buffer.floatChannelData![0]
    for index in 0..<Int(frames) { samples[index] = 0 }
    let output = try AVAudioFile(forWriting: file, settings: format.settings)
    try output.write(from: buffer)
    return file
  }
}

@MainActor private final class PlaybackTransfers: BackgroundTransferring {
  var onCompletion: ((TransferCompletion) async -> Void)?
  var onProgress: ((TransferContext, TransferProgressSnapshot) -> Void)?
  func startUpload(file: ObjectStorageUploadFile, grant: UploadGrant, context: TransferContext)
    async throws -> Int
  {
    throw JobArtifactFailure.unavailable
  }
  func activeTransfers() async -> [TransferContext] { [] }
  func cancel(ownerUid: String, operationId: UUID?) async {}
  func cancel(context: TransferContext) async {}
}
