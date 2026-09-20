import AVFoundation
import CryptoKit
import XCTest

@testable import Vocal

final class AudioInputPreparerTests: XCTestCase {
  private var root: URL!
  override func setUpWithError() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  }
  override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }

  func testStrictDeclarationBoundaries() {
    XCTAssertTrue(validProcessingInput(bytes: 1, duration: 0.001))
    XCTAssertTrue(validProcessingInput(bytes: 50_000_000, duration: 1_200))
    for bytes: Int64 in [0, -1, 50_000_001] {
      XCTAssertFalse(validProcessingInput(bytes: bytes, duration: 1))
    }
    for duration in [0, -1, 1_200.001, Double.infinity, Double.nan] {
      XCTAssertFalse(validProcessingInput(bytes: 1, duration: duration))
    }
  }

  func testImmutableCopyUsesHashedOwnerAndPaddedBase64Digest() async throws {
    let bytes = Data((0..<140_000).map { UInt8($0 % 251) })
    let source = try fixture(bytes)
    let prepared = try await preparer().prepare(
      sourceURL: source, ownerUid: "../private-owner", securityScoped: false)
    XCTAssertEqual(prepared.ownerUid, "../private-owner")
    XCTAssertFalse(prepared.fileURL.path.contains("private-owner"))
    XCTAssertEqual(
      prepared.declaration.sha256, Data(SHA256.hash(data: bytes)).base64EncodedString())
    XCTAssertTrue(prepared.declaration.sha256.hasSuffix("="))
    XCTAssertEqual(prepared.declaration.bytes, Int64(bytes.count))
    XCTAssertEqual(prepared.declaration.extension, "m4a")
    XCTAssertEqual(prepared.declaration.contentType, "audio/mp4")
    try Data("changed".utf8).write(to: source)
    XCTAssertEqual(try Data(contentsOf: prepared.fileURL), bytes)
    let attributes = try FileManager.default.attributesOfItem(atPath: prepared.fileURL.path)
    XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o400)
    XCTAssertEqual(
      try prepared.fileURL.deletingLastPathComponent().resourceValues(forKeys: [
        .isExcludedFromBackupKey
      ]).isExcludedFromBackup, true)
  }

  func testCancelledPickerAndDeniedSecurityScope() async throws {
    await expect(.cancelled) {
      try await self.preparer().prepare(sourceURL: nil, ownerUid: "owner")
    }
    let source = try fixture(Data([1]))
    let denied = AudioInputPreparer(
      root: root.appendingPathComponent("staging"), startAccess: { _ in false })
    await expect(.accessDenied) { try await denied.prepare(sourceURL: source, ownerUid: "owner") }
  }

  func testUnreadableCloudFileAndEmptyInput() async throws {
    await expect(.unreadable) {
      try await self.preparer().prepare(
        sourceURL: self.root.appendingPathComponent("missing.m4a"), ownerUid: "owner",
        securityScoped: false)
    }
    let source = try fixture(Data())
    await expect(.invalidSize) {
      try await self.preparer().prepare(sourceURL: source, ownerUid: "owner", securityScoped: false)
    }
  }

  func testLowStorageAndOversizedFileBeforeInspection() async throws {
    let source = try fixture(Data([1, 2]))
    let low = AudioInputPreparer(
      root: root.appendingPathComponent("staging"), availableCapacity: { _ in 0 })
    await expect(.storage) {
      try await low.prepare(sourceURL: source, ownerUid: "owner", securityScoped: false)
    }
    let handle = try FileHandle(forWritingTo: source)
    try handle.truncate(atOffset: 50_000_001)
    try handle.close()
    await expect(.invalidSize) {
      try await self.preparer().prepare(sourceURL: source, ownerUid: "owner", securityScoped: false)
    }
  }

  func testRejectsVideoMissingAudioUnknownDurationAndMisleadingExtension() async throws {
    let source = try fixture(Data([1]))
    for inspection in [
      AudioInputInspection(
        duration: 1, hasAudio: true, hasVideo: true, isPlayable: true, container: .mp4),
      AudioInputInspection(
        duration: 1, hasAudio: false, hasVideo: false, isPlayable: true, container: .mp4),
      AudioInputInspection(
        duration: .nan, hasAudio: true, hasVideo: false, isPlayable: true, container: .mp4),
      AudioInputInspection(
        duration: 1_200.001, hasAudio: true, hasVideo: false, isPlayable: true, container: .mp4),
      AudioInputInspection(
        duration: 1, hasAudio: true, hasVideo: false, isPlayable: false, container: .mp4),
      AudioInputInspection(
        duration: 1, hasAudio: true, hasVideo: false, isPlayable: true, container: .mp3),
    ] {
      await expect(.invalidAudio) {
        try await self.preparer(inspection).prepare(
          sourceURL: source, ownerUid: "owner", securityScoped: false)
      }
    }
    let unsupported = try fixture(Data([1]), ext: "wav")
    await expect(.unsupportedFormat) {
      try await self.preparer().prepare(
        sourceURL: unsupported, ownerUid: "owner", securityScoped: false)
    }
  }

  func testRealAACInspectionUsesAudioFramesAndRejectsRenamedContainer() async throws {
    let source = root.appendingPathComponent("real.m4a")
    let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 44_100)!
    buffer.frameLength = 44_100
    memset(buffer.floatChannelData![0], 0, 44_100 * MemoryLayout<Float>.size)
    do {
      let writer = try AVAudioFile(
        forWriting: source,
        settings: [
          AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44_100,
          AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000,
        ])
      try writer.write(from: buffer)
    }
    let prepared = try await AudioInputPreparer(root: root.appendingPathComponent("staging"))
      .prepare(sourceURL: source, ownerUid: "owner", securityScoped: false)
    let audio = try AVAudioFile(forReading: source)
    XCTAssertEqual(
      prepared.declaration.durationSeconds, Double(audio.length) / audio.fileFormat.sampleRate)
    let renamed = root.appendingPathComponent("wrong.mp3")
    try FileManager.default.copyItem(at: source, to: renamed)
    await expect(.invalidAudio) {
      try await AudioInputPreparer(root: self.root.appendingPathComponent("staging"))
        .prepare(sourceURL: renamed, ownerUid: "owner", securityScoped: false)
    }
  }

  func testFragmentedM4AUsesFrameDurationWithoutChangingBytes() async throws {
    // Synthetic 0.12-second silent AAC fragmented MP4 (ffmpeg lavfi anullsrc).
    let encoded = """
      AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAArxtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAA
      AAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAABv3Ry
      YWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAA
      AAAAAAAAAEAAAAAAAAAAAAAAAAAAAVttZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAKxEAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAA
      c291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAAEGbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAA
      AAEAAAAMdXJsIAAAAAEAAADKc3RibAAAAH5zdHNkAAAAAAAAAAEAAABubXA0YQAAAAAAAAABAAAAAAAAAAAAAQAQAAAAAKxEAAAA
      AAA2ZXNkcwAAAAADgICAJQABAASAgIAXQBUAAAAAAPoAAAD6AAWAgIAFEghW5QAGgICAAQIAAAAUYnRydAAAAAAAAPoAAAD6AAAA
      ABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgA
      AAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBs
      AAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjIuMy4xMDAAAACcbW9vZgAAABBtZmhkAAAAAAAA
      AAEAAACEdHJhZgAAABx0ZmhkAAIAOAAAAAEAAAQAAAAAFQIAAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAAEx0cnVuAAADAQAAAAcA
      AACkAAAEAAAAABUAAAQAAAAABAAABAAAAAAEAAAEAAAAAAQAAAQAAAAABAAABAAAAAAEAAAArAAAAAQAAAA1bWRhdN4CAExhdmM2
      Mi4xMS4xMDAAAjBADgEYIAcBGCAHARggBwEYIAcBGCAHARggBwAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAA
      AAAAAAAAAAAC2AEBAQAAABBtZnJvAAAAAAAAAEM=
      """
    let bytes = Data(base64Encoded: encoded, options: .ignoreUnknownCharacters)!
    XCTAssertNotNil(bytes.range(of: Data("moof".utf8)))
    let source = try fixture(bytes)
    let audioFile = try AVAudioFile(forReading: source)
    let expectedDuration = Double(audioFile.length) / audioFile.fileFormat.sampleRate
    let prepared = try await AudioInputPreparer(root: root.appendingPathComponent("staging"))
      .prepare(sourceURL: source, ownerUid: "owner", securityScoped: false)
    XCTAssertEqual(prepared.declaration.durationSeconds, expectedDuration)
    XCTAssertGreaterThan(expectedDuration, 0)
    XCTAssertLessThan(expectedDuration, 1)
    XCTAssertEqual(try Data(contentsOf: prepared.fileURL), bytes)
  }

  private func fixture(_ bytes: Data, ext: String = "m4a") throws -> URL {
    let source = root.appendingPathComponent("\(UUID().uuidString).\(ext)")
    try bytes.write(to: source)
    return source
  }
  private func preparer(
    _ inspection: AudioInputInspection = .init(
      duration: 1, hasAudio: true, hasVideo: false, isPlayable: true, container: .mp4)
  ) -> AudioInputPreparer {
    AudioInputPreparer(
      root: root.appendingPathComponent("staging"), inspect: { _ in inspection },
      prepareMedia: { source, directory, _, _, onPreparation in
        try await onPreparation()
        let target = directory.appendingPathComponent("input." + source.pathExtension.lowercased())
        try FileManager.default.copyItem(at: source, to: target)
        return target
      })
  }
  private func expect(
    _ expected: AudioInputPreparationError, operation: () async throws -> PreparedInput
  ) async {
    do {
      _ = try await operation()
      XCTFail("Expected \(expected)")
    } catch { XCTAssertEqual(error as? AudioInputPreparationError, expected) }
  }
}
