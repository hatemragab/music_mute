import FirebaseCore
import XCTest

@testable import Vocal

final class CoreTests: XCTestCase {
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
    XCTAssertEqual(preferences.favorites, ["job-1"])
    XCTAssertEqual(preferences.hidden, ["job-2"])

    preferences.bind("owner-b")
    XCTAssertTrue(preferences.favorites.isEmpty)
    XCTAssertTrue(preferences.hidden.isEmpty)

    preferences.bind("owner-a")
    XCTAssertEqual(preferences.favorites, ["job-1"])
    XCTAssertEqual(preferences.hidden, ["job-2"])
  }

}
