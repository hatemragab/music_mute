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

}
