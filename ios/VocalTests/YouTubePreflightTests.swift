import XCTest

@testable import Vocal

final class YouTubePreflightTests: XCTestCase {
  func testRecordedVideoRequiresMatchingIdentityAndFiniteVerifiedDuration() throws {
    let html =
      #"<script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"OK"},"videoDetails":{"videoId":"jNQXAC9IVRw","lengthSeconds":"1200","isLiveContent":false,"title":"A } in a title"}};</script>"#
    XCTAssertEqual(
      try YouTubePreflight.parseWatchPage(Data(html.utf8), videoID: "jNQXAC9IVRw"), 1200)
    XCTAssertThrowsError(
      try YouTubePreflight.parseWatchPage(Data(html.utf8), videoID: "abcdefghijk"))
    XCTAssertThrowsError(
      try YouTubePreflight.parseWatchPage(
        Data(html.replacingOccurrences(of: "1200", with: "1201").utf8), videoID: "jNQXAC9IVRw"))
  }
  func testLiveUpcomingUnknownDurationAndConsentPagesFailClosed() {
    let template =
      #"ytInitialPlayerResponse = {"playabilityStatus":{"status":"OK"},"videoDetails":{"videoId":"jNQXAC9IVRw","lengthSeconds":"60","isLiveContent":false}};"#
    for html in [
      template.replacingOccurrences(of: #""isLiveContent":false"#, with: #""isLiveContent":true"#),
      template.replacingOccurrences(
        of: #""isLiveContent":false"#, with: #""isLiveContent":false,"isUpcoming":true"#),
      template.replacingOccurrences(of: #""lengthSeconds":"60","#, with: ""),
      template.replacingOccurrences(of: #""isLiveContent":false"#, with: #""other":false"#),
      template.replacingOccurrences(of: "OK", with: "LOGIN_REQUIRED"),
      "<html>Consent required</html>",
    ] {
      XCTAssertThrowsError(
        try YouTubePreflight.parseWatchPage(Data(html.utf8), videoID: "jNQXAC9IVRw"))
    }
  }
}
