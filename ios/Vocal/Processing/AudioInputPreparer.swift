import AVFoundation
import AudioToolbox
import CryptoKit
import Foundation

struct AudioInputInspection: Sendable {
  enum Container: Sendable { case mp4, mp3, aac, ogg, webm }
  let duration: Double
  let hasAudio: Bool
  let hasVideo: Bool
  let isPlayable: Bool
  let container: Container
}

actor AudioInputPreparer {
  private var purgedOwners = Set<String>()
  private let root: URL
  private let inspect: @Sendable (URL) async throws -> AudioInputInspection
  private let startAccess: @Sendable (URL) -> Bool
  private let stopAccess: @Sendable (URL) -> Void
  private let availableCapacity: @Sendable (URL) throws -> Int64?

  init(
    root: URL,
    inspect: @escaping @Sendable (URL) async throws -> AudioInputInspection = {
      try await AudioInputPreparer.inspectAudio($0)
    },
    startAccess: @escaping @Sendable (URL) -> Bool = { $0.startAccessingSecurityScopedResource() },
    stopAccess: @escaping @Sendable (URL) -> Void = { $0.stopAccessingSecurityScopedResource() },
    availableCapacity: @escaping @Sendable (URL) throws -> Int64? = {
      try $0.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        .volumeAvailableCapacityForImportantUsage
    }
  ) {
    self.root = root
    self.inspect = inspect
    self.startAccess = startAccess
    self.stopAccess = stopAccess
    self.availableCapacity = availableCapacity
  }

  /// Imported document URLs require security scope. Completed app-owned originals do not.
  func prepare(
    sourceURL: URL?, ownerUid: String, securityScoped: Bool = true,
    operationId: UUID = UUID(), sourceTitle: String? = nil, sourceKind: JobSourceKind? = nil,
    clientStartedAt: Date? = nil, displayName: String? = nil,
    canonicalSourceURL: String? = nil
  ) async throws -> PreparedInput {
    guard let source = sourceURL else { throw AudioInputPreparationError.cancelled }
    guard !purgedOwners.contains(ownerUid), source.isFileURL, !ownerUid.isEmpty else {
      throw AudioInputPreparationError.unreadable
    }
    let ext = source.pathExtension.lowercased()
    let pair = try Self.declarationPair(ext)
    if securityScoped && !startAccess(source) { throw AudioInputPreparationError.accessDenied }
    defer { if securityScoped { stopAccess(source) } }
    let owner = SHA256.hash(data: Data(ownerUid.utf8)).map { String(format: "%02x", $0) }.joined()
    let directory = root.appendingPathComponent(owner, isDirectory: true)
      .appendingPathComponent(operationId.uuidString.lowercased(), isDirectory: true)
    let destination = directory.appendingPathComponent("input.\(ext)")
    do {
      try Task.checkCancellation()
      do {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for var excluded in [root, directory.deletingLastPathComponent(), directory] {
          var values = URLResourceValues()
          values.isExcludedFromBackup = true
          try excluded.setResourceValues(values)
        }
      } catch { throw AudioInputPreparationError.storage }
      let copied = try coordinatedCopy(source: source, destination: destination)
      let media: AudioInputInspection
      do { media = try await inspect(destination) } catch is CancellationError {
        throw CancellationError()
      } catch { throw AudioInputPreparationError.invalidAudio }
      guard !purgedOwners.contains(ownerUid),
        validProcessingInput(bytes: copied.bytes, duration: media.duration),
        media.hasAudio, !media.hasVideo, media.isPlayable, media.container == pair.container
      else { throw AudioInputPreparationError.invalidAudio }
      try Task.checkCancellation()
      do {
        try FileManager.default.setAttributes(
          [.posixPermissions: 0o400], ofItemAtPath: destination.path)
      } catch { throw AudioInputPreparationError.storage }
      return PreparedInput(
        operationId: operationId, ownerUid: ownerUid, fileURL: destination,
        declaration: InputDeclaration(
          extension: ext, contentType: pair.contentType,
          bytes: copied.bytes, durationSeconds: media.duration, sha256: copied.digest),
        sourceTitle: sourceTitle, sourceKind: sourceKind, clientStartedAt: clientStartedAt,
        displayName: displayName, sourceURL: canonicalSourceURL)
    } catch {
      // Remove only this new, unpublished attempt; retained inputs are never swept.
      try? FileManager.default.removeItem(at: directory)
      if error is CancellationError { throw AudioInputPreparationError.cancelled }
      throw error
    }
  }

  func purge(ownerUid: String) throws {
    purgedOwners.insert(ownerUid)
    let directory = root.appendingPathComponent(ProcessingStore.ownerDirectoryName(ownerUid))
    if FileManager.default.fileExists(atPath: directory.path) {
      try FileManager.default.removeItem(at: directory)
    }
  }

  func discard(_ input: PreparedInput) throws {
    let owner = ProcessingStore.ownerDirectoryName(input.ownerUid)
    let expected = root.appendingPathComponent(owner).appendingPathComponent(
      input.operationId.uuidString.lowercased())
    guard
      input.fileURL.deletingLastPathComponent().standardizedFileURL == expected.standardizedFileURL
    else {
      throw ProcessingStoreFailure.invalidPath
    }
    if FileManager.default.fileExists(atPath: expected.path) {
      try FileManager.default.removeItem(at: expected)
    }
  }

  private func coordinatedCopy(source: URL, destination: URL) throws -> (
    bytes: Int64, digest: String
  ) {
    var coordinationError: NSError?
    var result: Result<(bytes: Int64, digest: String), Error>?
    NSFileCoordinator().coordinate(
      readingItemAt: source, options: .withoutChanges, error: &coordinationError
    ) { url in
      result = Result { try copyBytes(source: url, destination: destination) }
    }
    if let result { return try result.get() }
    throw AudioInputPreparationError.unreadable
  }

  private func copyBytes(source: URL, destination: URL) throws -> (bytes: Int64, digest: String) {
    let values: URLResourceValues
    let input: FileHandle
    do {
      values = try source.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
      guard values.isRegularFile == true else { throw AudioInputPreparationError.unreadable }
      input = try FileHandle(forReadingFrom: source)
    } catch { throw AudioInputPreparationError.unreadable }
    defer { try? input.close() }
    let size = Int64(values.fileSize ?? 0)
    guard (1...29_999_999).contains(size) else { throw AudioInputPreparationError.invalidSize }
    do {
      if let available = try availableCapacity(destination.deletingLastPathComponent()),
        available < size
      {
        throw AudioInputPreparationError.storage
      }
    } catch { throw AudioInputPreparationError.storage }
    guard
      FileManager.default.createFile(
        atPath: destination.path, contents: nil,
        attributes: [.posixPermissions: 0o600])
    else { throw AudioInputPreparationError.storage }
    let output: FileHandle
    do { output = try FileHandle(forWritingTo: destination) } catch {
      throw AudioInputPreparationError.storage
    }
    defer { try? output.close() }
    var count: Int64 = 0
    var hash = SHA256()
    while true {
      try Task.checkCancellation()
      let chunk: Data
      do { chunk = try input.read(upToCount: 65_536) ?? Data() } catch {
        throw AudioInputPreparationError.unreadable
      }
      if chunk.isEmpty { break }
      count += Int64(chunk.count)
      guard count < 30_000_000 else { throw AudioInputPreparationError.invalidSize }
      do { try output.write(contentsOf: chunk) } catch { throw AudioInputPreparationError.storage }
      hash.update(data: chunk)
    }
    guard count == size else { throw AudioInputPreparationError.unreadable }
    do { try output.synchronize() } catch { throw AudioInputPreparationError.storage }
    return (count, Data(hash.finalize()).base64EncodedString())
  }

  private static func declarationPair(_ ext: String) throws -> (
    contentType: String, container: AudioInputInspection.Container
  ) {
    switch ext {
    case "m4a", "mp4": return ("audio/mp4", .mp4)
    case "mp3": return ("audio/mpeg", .mp3)
    case "aac": return ("audio/aac", .aac)
    case "ogg", "opus": return ("audio/ogg", .ogg)
    case "webm": return ("audio/webm", .webm)
    default: throw AudioInputPreparationError.unsupportedFormat
    }
  }

  static func inspectAudio(_ url: URL) async throws -> AudioInputInspection {
    let asset = AVURLAsset(url: url)
    let audio = try await asset.loadTracks(withMediaType: .audio)
    let video = try await asset.loadTracks(withMediaType: .video)
    let playable = try await asset.load(.isPlayable)
    let file = try AVAudioFile(forReading: url)
    // Match AudioFiles: fragmented M4A asset duration can be doubled; decoded
    // audio frame count gives the playable duration without rewriting the bytes.
    let duration = Double(file.length) / file.fileFormat.sampleRate
    var audioFile: AudioFileID?
    guard AudioFileOpenURL(url as CFURL, .readPermission, 0, &audioFile) == noErr,
      let audioFile
    else { throw AudioInputPreparationError.invalidAudio }
    defer { AudioFileClose(audioFile) }
    var format: AudioFileTypeID = 0
    var size = UInt32(MemoryLayout<AudioFileTypeID>.size)
    guard AudioFileGetProperty(audioFile, kAudioFilePropertyFileFormat, &size, &format) == noErr
    else {
      throw AudioInputPreparationError.invalidAudio
    }
    let container: AudioInputInspection.Container
    switch format {
    case kAudioFileM4AType, kAudioFileMPEG4Type: container = .mp4
    case kAudioFileMP3Type: container = .mp3
    case kAudioFileAAC_ADTSType: container = .aac
    default: throw AudioInputPreparationError.unsupportedFormat
    }
    return AudioInputInspection(
      duration: duration, hasAudio: !audio.isEmpty,
      hasVideo: !video.isEmpty, isPlayable: playable, container: container)
  }
}
