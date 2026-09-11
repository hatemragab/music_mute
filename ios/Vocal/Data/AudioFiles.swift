import AVFoundation
import Foundation

actor AudioFiles {
  private var purgedAttempts = Set<UUID>()
  nonisolated let root: URL
  init(root: URL) { self.root = root }

  nonisolated func url(for relativePath: String) -> URL? {
    guard !relativePath.isEmpty else { return nil }
    let base = root.resolvingSymlinksInPath().standardizedFileURL.path + "/"
    let url = root.appendingPathComponent(relativePath).resolvingSymlinksInPath()
      .standardizedFileURL
    guard url.path.hasPrefix(base),
      let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
      values.isRegularFile == true, (values.fileSize ?? 0) > 0
    else {
      return nil
    }
    return url
  }

  func saveDownloaded(_ temporary: URL, id: UUID, resolved: ResolvedAudio) async throws
    -> SavedAudio
  {
    guard !purgedAttempts.contains(id) else { throw CancellationError() }
    let directory = root.appendingPathComponent(id.uuidString, isDirectory: true)
    let file = directory.appendingPathComponent("audio.m4a")
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      var excluded = directory
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try excluded.setResourceValues(values)
      if FileManager.default.fileExists(atPath: file.path) {
        try FileManager.default.removeItem(at: file)
      }
      try FileManager.default.copyItem(at: temporary, to: file)
      let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
      guard size > 0 else { throw AudioFailure.storage }
    } catch is CancellationError {
      try? FileManager.default.removeItem(at: directory)
      throw CancellationError()
    } catch {
      try? FileManager.default.removeItem(at: directory)
      throw AudioFailure.storage
    }
    do {
      let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
      let asset = AVURLAsset(url: file)
      let audio = try await asset.loadTracks(withMediaType: .audio)
      let video = try await asset.loadTracks(withMediaType: .video)
      // Fragmented YouTube M4A files can report doubled AVAsset durations.
      // Reading the audio frame count gives the actual playable duration without changing bytes.
      let audioFile = try AVAudioFile(forReading: file)
      let duration = Double(audioFile.length) / audioFile.fileFormat.sampleRate
      let playable = try await asset.load(.isPlayable)
      guard !audio.isEmpty, video.isEmpty, playable, duration.isFinite, duration > 0 else {
        throw AudioFailure.invalidAudio
      }
      try Task.checkCancellation()
      return SavedAudio(
        title: resolved.title, relativePath: "\(id.uuidString)/audio.m4a",
        codec: resolved.stream.codec, fileExtension: "m4a", bitrate: resolved.stream.bitrate,
        byteCount: Int64(size), duration: duration)
    } catch is CancellationError {
      try? FileManager.default.removeItem(at: directory)
      throw CancellationError()
    } catch {
      // Only this new attempt's directory is owned by this operation.
      try? FileManager.default.removeItem(at: directory)
      throw AudioFailure.invalidAudio
    }
  }

  func exportCopy(of record: AudioRecord) throws -> URL {
    guard record.status == .complete, let source = url(for: record.relativePath) else {
      throw AudioFailure.storage
    }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "VocalExports/\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let target = directory.appendingPathComponent(
      AudioPolicy.exportName(title: record.title, fileExtension: record.fileExtension))
    try FileManager.default.copyItem(at: source, to: target)
    return target
  }

  func removeExport(_ file: URL) {
    let owned =
      FileManager.default.temporaryDirectory.appendingPathComponent("VocalExports")
      .standardizedFileURL.path + "/"
    guard file.standardizedFileURL.path.hasPrefix(owned) else { return }
    try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
  }

  func purgePrivateAttempt(_ id: UUID) throws {
    purgedAttempts.insert(id)
    let directory = root.appendingPathComponent(id.uuidString)
    if FileManager.default.fileExists(atPath: directory.path) {
      try FileManager.default.removeItem(at: directory)
    }
  }

  func discardAttempt(_ id: UUID) {
    try? FileManager.default.removeItem(at: root.appendingPathComponent(id.uuidString))
  }
}
