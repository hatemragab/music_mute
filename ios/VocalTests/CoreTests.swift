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
  func testByteProgressHandlesUnknownTotalAndResumedOffset() {
    XCTAssertNil(DownloadProgress(downloadedBytes: 1234, totalBytes: nil).fraction)
    XCTAssertNil(DownloadProgress(downloadedBytes: 1234, totalBytes: 0).fraction)
    XCTAssertEqual(
      DownloadProgress(downloadedBytes: 560, totalBytes: 600).fraction!, 560.0 / 600.0,
      accuracy: 0.001)
    XCTAssertEqual(DownloadProgress(downloadedBytes: 600, totalBytes: 600).fraction, 0.99)
  }
  func testInterruptedTransferUsesResumeData() async throws {
    var calls = 0
    let resume = Data("resume-state".utf8)
    let expected = URL(fileURLWithPath: "/tmp/audio.m4a")
    let result = try await ResumableTransfer.download(
      operation: { data in
        calls += 1
        if calls == 1 {
          XCTAssertNil(data)
          throw NSError(
            domain: NSURLErrorDomain, code: URLError.networkConnectionLost.rawValue,
            userInfo: [NSURLSessionDownloadTaskResumeData: resume])
        }
        XCTAssertEqual(data, resume)
        return (expected, URLResponse())
      }, wait: { _ in })
    XCTAssertEqual(result.0, expected)
    XCTAssertEqual(calls, 2)
  }

  func testTransferRetriesAreBounded() async {
    var calls = 0
    do {
      _ = try await ResumableTransfer.download(
        operation: { _ in
          calls += 1
          throw URLError(.networkConnectionLost)
        }, wait: { _ in })
      XCTFail("Persistent network failure must be surfaced")
    } catch { XCTAssertEqual((error as? URLError)?.code, .networkConnectionLost) }
    XCTAssertEqual(calls, 4)
  }

  func testTransferDoesNotRetryCancellationOrPermanentErrors() async {
    for code in [URLError.cancelled, .badServerResponse, .notConnectedToInternet] {
      var calls = 0
      do {
        _ = try await ResumableTransfer.download(
          operation: { _ in
            calls += 1
            throw URLError(code)
          }, wait: { _ in XCTFail("Must not wait for a permanent failure") })
        XCTFail("Expected failure")
      } catch { XCTAssertEqual((error as? URLError)?.code, code) }
      XCTAssertEqual(calls, 1)
    }
  }

  func testSupportedYouTubeURLsCanonicalizeToOneID() {
    for url in [
      "https://youtu.be/jNQXAC9IVRw", " https://www.youtube.com/watch?v=jNQXAC9IVRw&t=10 ",
      "https://m.youtube.com/shorts/jNQXAC9IVRw", "https://youtube.com/embed/jNQXAC9IVRw",
      "https://music.youtube.com/watch?v=jNQXAC9IVRw&list=example",
    ] {
      XCTAssertEqual(YouTubeURL.videoID(from: url), "jNQXAC9IVRw", url)
      XCTAssertEqual(
        YouTubeURL.canonicalURL(from: url),
        "https://www.youtube.com/watch?v=jNQXAC9IVRw",
        url)
    }
  }
  func testUntrustedAndInvalidURLsAreRejected() {
    for url in [
      "", "jNQXAC9IVRw", "javascript:alert(1)", "https://youtube.com.evil.test/watch?v=jNQXAC9IVRw",
      "https://user@youtube.com/watch?v=jNQXAC9IVRw", "https://youtube.com:444/watch?v=jNQXAC9IVRw",
      "https://youtube.com/watch?v=short", "https://youtube.com/playlist?list=123",
      "https://youtu.be/jNQXAC9IVRw/extra", "https://youtube.com/watch?v=jNQXAC9IVRw&v=abcdefghijk",
    ] {
      XCTAssertNil(YouTubeURL.videoID(from: url), url)
    }
  }
  func testSelectionPreservesHighestCompatibleOriginalAudio() throws {
    let high = candidate(bitrate: 160_000)
    let low = candidate(bitrate: 128_000)
    let video = candidate(bitrate: 2_000_000, hasVideo: true)
    let opus = candidate(bitrate: 200_000, codec: "Opus", ext: "webm")
    let selected = try AudioPolicy.bestCompatibleAudio([low, video, opus, high])
    XCTAssertEqual(selected.bitrate, 160_000)
    XCTAssertEqual(selected.fileExtension, "m4a")
    XCTAssertEqual(selected.url, high.url)
  }
  func testSelectionNeverFallsBackToVideoInsecureOrRemoteStreams() {
    for stream in [
      candidate(hasVideo: true), candidate(codec: "Opus", ext: "webm"),
      candidate(url: "http://r1.googlevideo.com/audio"),
      candidate(url: "https://example.com/audio"),
      candidate(playable: false),
    ] {
      XCTAssertThrowsError(try AudioPolicy.bestCompatibleAudio([stream]))
    }
  }
  func testExportFilenamePreservesArabicAndContainer() {
    XCTAssertEqual(
      AudioPolicy.exportName(title: "صوت / مثال: 1", fileExtension: "m4a"), "صوت _ مثال_ 1.m4a")
    XCTAssertEqual(AudioPolicy.exportName(title: "...", fileExtension: "m4a"), "MusicMute.m4a")
  }
  func testPlaybackTimeHandlesHoursAndInvalidValues() {
    XCTAssertEqual(audioTime(3661), "1:01:01")
    XCTAssertEqual(audioTime(61), "1:01")
    XCTAssertEqual(audioTime(-1), "0:00")
    XCTAssertEqual(audioTime(.infinity), "0:00")
  }

  func testExportFilenameFitsFilesystemByteLimitWithEmoji() {
    let name = AudioPolicy.exportName(
      title: String(repeating: "🎧音", count: 200), fileExtension: "m4a")
    XCTAssertLessThan(name.utf8.count, 255)
    XCTAssertTrue(name.hasSuffix(".m4a"))
  }
  private func candidate(
    bitrate: Int = 128_000, hasVideo: Bool = false, codec: String = "AAC", ext: String = "m4a",
    url: String = "https://r1.googlevideo.com/audio", playable: Bool = true
  ) -> AudioCandidate {
    AudioCandidate(
      url: URL(string: url)!, hasVideo: hasVideo, codec: codec, fileExtension: ext,
      bitrate: bitrate, isPlayable: playable)
  }
}
