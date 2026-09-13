import AVFoundation
import XCTest

@testable import Vocal

final class MediaPreparationEngineTests: XCTestCase {
  private var root: URL!
  private let policy = ProcessingMediaPolicy(
    version: 2, maxDuration: 1800,
    maxBytes: 100_000_000, inclusive: true, maxSourceBytes: 200_000_000,
    maxPreparationSeconds: 60, profileID: "preserve-or-aac-lc-256-v1")
  override func setUpWithError() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  }
  override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }

  func testExtractsDefaultSecondSoundtrackAndDoesNotUploadVideo() async throws {
    let source = try XCTUnwrap(
      Bundle(for: Self.self).url(forResource: "video-default-second", withExtension: "mp4"))
    let inspected = try await MediaSourceInspector.inspect(source, policy: policy)
    let tracks = try await inspected.asset.loadTracks(withMediaType: .audio)
    XCTAssertEqual(tracks.count, 2)
    XCTAssertEqual(inspected.track.trackID, tracks[1].trackID)
    let preparer = AudioInputPreparer(root: root, availableCapacity: { _ in 1_000_000_000 })
    await preparer.configure(policy: policy)
    let prepared = try await preparer.prepare(
      sourceURL: source, ownerUid: "owner", securityScoped: false)
    let output = try await AudioInputPreparer.inspectAudio(prepared.fileURL)
    XCTAssertTrue(output.hasAudio)
    XCTAssertFalse(output.hasVideo)
    XCTAssertEqual(prepared.policyVersion, 2)
    XCTAssertEqual(prepared.mediaSource, "video_file")
    XCTAssertLessThan(abs(output.duration - inspected.duration), 0.05)
    // The nondefault soundtrack is 440 Hz; the default second soundtrack is 880 Hz.
    let audio = try AVAudioFile(forReading: prepared.fileURL)
    let buffer = AVAudioPCMBuffer(
      pcmFormat: audio.processingFormat, frameCapacity: AVAudioFrameCount(audio.length))!
    try audio.read(into: buffer)
    let data = try XCTUnwrap(buffer.floatChannelData?[0])
    let start = Int(audio.processingFormat.sampleRate * 0.2)
    let end = min(Int(buffer.frameLength), start + Int(audio.processingFormat.sampleRate))
    let crossings = (start + 1..<end).filter { data[$0 - 1] <= 0 && data[$0] > 0 }.count
    let frequency = Double(crossings) * audio.processingFormat.sampleRate / Double(end - start)
    XCTAssertEqual(frequency, 880, accuracy: 10)
  }

  func testThirtyMinutePreparedAudioUsesInclusiveVersionTwoLimit() async throws {
    let project = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    let source = project.appendingPathComponent("artifacts/media-input/long/audio-1800s.m4a")
    guard FileManager.default.isReadableFile(atPath: source.path) else {
      throw XCTSkip(
        "Optional generated 30-minute source is unavailable; run shared fixture generator first")
    }
    let preparer = AudioInputPreparer(root: root, availableCapacity: { _ in 1_000_000_000 })
    await preparer.configure(policy: policy)
    let prepared = try await preparer.prepare(
      sourceURL: source, ownerUid: "owner", securityScoped: false)
    XCTAssertEqual(prepared.declaration.durationSeconds, 1800, accuracy: 0.0001)
    XCTAssertGreaterThan(prepared.declaration.bytes, 30_000_000)
    XCTAssertEqual(prepared.policyVersion, 2)
  }

  func testNoAudioRejectedAndUnknownReadinessDoesNotExpand() async throws {
    let source = try XCTUnwrap(
      Bundle(for: Self.self).url(forResource: "video-no-audio", withExtension: "mp4"))
    do {
      _ = try await MediaSourceInspector.inspect(source, policy: policy)
      XCTFail("silent video accepted")
    } catch { XCTAssertEqual(error as? AudioInputPreparationError, .noAudio) }
    do {
      _ = try await AudioPreparationEngine.prepare(
        source: source, directory: root, policy: .expanded,
        availableCapacity: { _ in 1_000_000_000 })
      XCTFail("null bounds expanded preparation")
    } catch { XCTAssertEqual(error as? AudioInputPreparationError, .policyUnavailable) }
  }

  func testMultichannelSourceIsRejectedBeforeSilentStereoDownmix() async throws {
    let source = root.appendingPathComponent("surround.wav")
    let layout = try XCTUnwrap(AVAudioChannelLayout(layoutTag: kAudioChannelLayoutTag_MPEG_5_1_A))
    let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channelLayout: layout)
    let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4800))
    buffer.frameLength = 4800
    let channels = try XCTUnwrap(buffer.floatChannelData)
    for channel in 0..<6 { channels[channel].initialize(repeating: 0, count: 4800) }
    do {
      let file = try AVAudioFile(forWriting: source, settings: format.settings)
      try file.write(from: buffer)
    }
    do {
      _ = try await MediaSourceInspector.inspect(source, policy: policy)
      XCTFail("Multichannel input was silently accepted for stereo conversion")
    } catch {
      XCTAssertEqual(error as? AudioInputPreparationError, .unsupportedFormat)
    }
  }

  func testWAVConvertsToAudioOnlyAACAndPreservesSource() async throws {
    let source = root.appendingPathComponent("original.wav")
    let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 48_000)!
    buffer.frameLength = 48_000
    for index in 0..<48_000 {
      buffer.floatChannelData![0][index] = Float(sin(Double(index) * 2 * .pi * 440 / 48_000)) * 0.1
    }
    do {
      let writer = try AVAudioFile(forWriting: source, settings: format.settings)
      try writer.write(from: buffer)
    }
    let original = try Data(contentsOf: source)
    let preparer = AudioInputPreparer(
      root: root.appendingPathComponent("staging"), availableCapacity: { _ in 1_000_000_000 })
    await preparer.configure(policy: policy)
    let prepared = try await preparer.prepare(
      sourceURL: source, ownerUid: "owner", securityScoped: false)
    XCTAssertEqual(prepared.declaration.extension, "m4a")
    XCTAssertEqual(prepared.declaration.contentType, "audio/mp4")
    XCTAssertEqual(try Data(contentsOf: source), original)
    let inspection = try await AudioInputPreparer.inspectAudio(prepared.fileURL)
    XCTAssertFalse(inspection.hasVideo)
    XCTAssertEqual(inspection.duration, 1, accuracy: 0.05)
  }
}
