import AVFoundation
import CryptoKit
import Foundation

/// Exports only the chosen soundtrack; video decoding is never requested.
enum AudioPreparationEngine {
  static func prepare(
    source: URL, directory: URL, policy: ProcessingMediaPolicy,
    availableCapacity: @Sendable (URL) throws -> Int64?,
    onPreparation: @escaping @Sendable () async throws -> Void = {}
  ) async throws -> URL {
    guard let sourceLimit = policy.maxSourceBytes, let deadline = policy.maxPreparationSeconds
    else {
      throw AudioInputPreparationError.policyUnavailable
    }
    let values = try source.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
    guard values.isRegularFile == true, let size = values.fileSize, size > 0,
      Int64(size) <= sourceLimit
    else { throw AudioInputPreparationError.invalidSize }
    guard let free = try availableCapacity(directory), free >= policy.maxBytes * 2 + 16_000_000
    else {
      throw AudioInputPreparationError.storage
    }
    return try await withThrowingTaskGroup(of: URL.self) { group in
      group.addTask {
        let media = try await MediaSourceInspector.inspect(source, policy: policy)
        try await onPreparation()
        try Task.checkCancellation()
        // Preserve compatible audio without an extra lossy generation.
        if !media.hasVideo, Int64(size) <= policy.maxBytes,
          let inspected = try? await AudioInputPreparer.inspectAudio(source),
          policy.accepts(bytes: Int64(size), duration: inspected.duration),
          ["m4a", "mp4", "mp3", "aac"].contains(source.pathExtension.lowercased())
        {
          let target = directory.appendingPathComponent(
            "input." + source.pathExtension.lowercased())
          try copyBounded(source, to: target, limit: policy.maxBytes)
          return target
        }
        let composition = AVMutableComposition()
        guard
          let track = composition.addMutableTrack(
            withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
        else {
          throw AudioInputPreparationError.unsupportedFormat
        }
        let range = try await media.track.load(.timeRange)
        try track.insertTimeRange(range, of: media.track, at: .zero)
        let target = directory.appendingPathComponent("input.m4a")
        let temporary = directory.appendingPathComponent("export.m4a")
        // First try audio-only passthrough, then Apple's high-quality AAC encoder.
        for preset in [AVAssetExportPresetPassthrough, AVAssetExportPresetAppleM4A] {
          try Task.checkCancellation()
          do {
            if preset == AVAssetExportPresetAppleM4A {
              try await transcode(composition, to: temporary, maxBytes: policy.maxBytes)
            } else {
              guard let export = AVAssetExportSession(asset: composition, presetName: preset),
                export.supportedFileTypes.contains(.m4a)
              else { continue }
              export.outputURL = temporary
              export.outputFileType = .m4a
              export.fileLengthLimit = policy.maxBytes
              try await withTaskCancellationHandler {
                await export.export()
                try Task.checkCancellation()
                guard export.status == .completed else {
                  throw AudioInputPreparationError.unsupportedFormat
                }
              } onCancel: {
                export.cancelExport()
              }
            }
            let checked = try await AudioInputPreparer.inspectAudio(temporary)
            let bytes = Int64(try temporary.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0)
            guard !checked.hasVideo, checked.hasAudio,
              policy.accepts(bytes: bytes, duration: checked.duration),
              checked.duration >= media.duration - 0.05
            else { throw AudioInputPreparationError.invalidAudio }
            try FileManager.default.moveItem(at: temporary, to: target)
            return target
          } catch {
            try? FileManager.default.removeItem(at: temporary)
            try Task.checkCancellation()
            if preset == AVAssetExportPresetAppleM4A { throw error }
          }
        }
        throw AudioInputPreparationError.unsupportedFormat
      }
      group.addTask {
        try await Task.sleep(for: .seconds(deadline))
        throw AudioInputPreparationError.interrupted
      }
      defer { group.cancelAll() }
      guard let url = try await group.next() else { throw AudioInputPreparationError.invalidAudio }
      return url
    }
  }

  private static func transcode(_ composition: AVComposition, to target: URL, maxBytes: Int64)
    async throws
  {
    let reader = try AVAssetReader(asset: composition)
    let tracks = try await composition.loadTracks(withMediaType: .audio)
    let output = AVAssetReaderAudioMixOutput(
      audioTracks: tracks,
      audioSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48_000,
        AVNumberOfChannelsKey: 2, AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false, AVLinearPCMIsNonInterleaved: false,
      ])
    guard reader.canAdd(output) else { throw AudioInputPreparationError.unsupportedFormat }
    reader.add(output)
    let writer = try AVAssetWriter(outputURL: target, fileType: .m4a)
    let input = AVAssetWriterInput(
      mediaType: .audio,
      outputSettings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000,
        AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 256_000,
        AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
      ])
    input.expectsMediaDataInRealTime = false
    guard writer.canAdd(input) else { throw AudioInputPreparationError.unsupportedFormat }
    writer.add(input)
    defer {
      if reader.status == .reading { reader.cancelReading() }
      if writer.status == .writing { writer.cancelWriting() }
    }
    guard writer.startWriting(), reader.startReading() else {
      throw AudioInputPreparationError.unsupportedFormat
    }
    writer.startSession(atSourceTime: .zero)
    while true {
      try Task.checkCancellation()
      guard writer.status == .writing else { throw AudioInputPreparationError.unsupportedFormat }
      if !input.isReadyForMoreMediaData {
        try await Task.sleep(for: .milliseconds(10))
        continue
      }
      guard let buffer = output.copyNextSampleBuffer() else { break }
      guard input.append(buffer) else { throw AudioInputPreparationError.invalidAudio }
      let bytes = Int64((try? target.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
      guard bytes <= maxBytes else { throw AudioInputPreparationError.invalidSize }
    }
    guard reader.status == .completed else { throw AudioInputPreparationError.invalidAudio }
    input.markAsFinished()
    await writer.finishWriting()
    try Task.checkCancellation()
    guard writer.status == .completed else { throw AudioInputPreparationError.invalidAudio }
  }

  private static func copyBounded(_ source: URL, to destination: URL, limit: Int64) throws {
    let input = try FileHandle(forReadingFrom: source)
    defer { try? input.close() }
    guard FileManager.default.createFile(atPath: destination.path, contents: nil) else {
      throw AudioInputPreparationError.storage
    }
    let output = try FileHandle(forWritingTo: destination)
    defer { try? output.close() }
    var count: Int64 = 0
    while let data = try input.read(upToCount: 65_536), !data.isEmpty {
      try Task.checkCancellation()
      count += Int64(data.count)
      guard count <= limit else { throw AudioInputPreparationError.invalidSize }
      try output.write(contentsOf: data)
    }
    try output.synchronize()
  }
}
