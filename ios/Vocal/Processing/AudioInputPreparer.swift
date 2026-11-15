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

typealias AudioMediaPreparation =
  @Sendable (
    _ source: URL, _ directory: URL, _ policy: ProcessingMediaPolicy,
    _ availableCapacity: @Sendable (URL) throws -> Int64?,
    _ onPreparation: @escaping @Sendable () async throws -> Void
  ) async throws -> URL

actor AudioInputPreparer {
  private var policy = ProcessingMediaPolicy.standard
  func configure(policy: ProcessingMediaPolicy) { self.policy = policy }
  func currentPolicy() -> ProcessingMediaPolicy { policy }

  private var purgedOwners = Set<String>()
  private let root: URL
  private let inspect: @Sendable (URL) async throws -> AudioInputInspection
  private let startAccess: @Sendable (URL) -> Bool
  private let stopAccess: @Sendable (URL) -> Void
  private let availableCapacity: @Sendable (URL) throws -> Int64?
  private let prepareMedia: AudioMediaPreparation

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
    },
    prepareMedia: @escaping AudioMediaPreparation = {
      source, directory, policy, availableCapacity, onPreparation in
      try await AudioPreparationEngine.prepare(
        source: source, directory: directory, policy: policy,
        availableCapacity: availableCapacity, onPreparation: onPreparation)
    }
  ) {
    self.root = root
    self.inspect = inspect
    self.startAccess = startAccess
    self.stopAccess = stopAccess
    self.availableCapacity = availableCapacity
    self.prepareMedia = prepareMedia
  }

  /// Imported document URLs require security scope. Completed app-owned originals do not.
  func prepare(
    sourceURL: URL?, ownerUid: String, securityScoped: Bool = true,
    operationId: UUID = UUID(), sourceTitle: String? = nil, sourceKind: JobSourceKind? = nil,
    clientStartedAt: Date? = nil, displayName: String? = nil,
    canonicalSourceURL: String? = nil,
    onPreparation: @escaping @Sendable () async throws -> Void = {}
  ) async throws -> PreparedInput {
    guard let source = sourceURL else { throw AudioInputPreparationError.cancelled }
    guard !purgedOwners.contains(ownerUid), source.isFileURL, !ownerUid.isEmpty else {
      throw AudioInputPreparationError.unreadable
    }
    guard FileManager.default.isReadableFile(atPath: source.path) else {
      throw AudioInputPreparationError.unreadable
    }
    let policy = self.policy
    var ext = source.pathExtension.lowercased()
    var pair = (contentType: "audio/mp4", container: AudioInputInspection.Container.mp4)
    if let declared = try? Self.declarationPair(ext) {
      if let sniffed = try Self.sniffContainer(source), sniffed != declared.container {
        throw AudioInputPreparationError.invalidAudio
      }
      if let sourceInspection = try? await Self.inspectAudio(source),
        sourceInspection.container != declared.container
      {
        throw AudioInputPreparationError.invalidAudio
      }
    }
    if securityScoped && !startAccess(source) { throw AudioInputPreparationError.accessDenied }
    defer { if securityScoped { stopAccess(source) } }
    let owner = SHA256.hash(data: Data(ownerUid.utf8)).map { String(format: "%02x", $0) }.joined()
    let directory = root.appendingPathComponent(owner, isDirectory: true)
      .appendingPathComponent(operationId.uuidString.lowercased(), isDirectory: true)
    var destination = directory.appendingPathComponent("input.\(ext)")
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
      let copied: (bytes: Int64, digest: String)
      destination = try await prepareMedia(
        source, directory, policy, availableCapacity, onPreparation)
      ext = destination.pathExtension.lowercased()
      pair = try Self.declarationPair(ext)
      let handle = try FileHandle(forReadingFrom: destination)
      defer { try? handle.close() }
      var hash = SHA256()
      var count: Int64 = 0
      while let chunk = try handle.read(upToCount: 65_536), !chunk.isEmpty {
        try Task.checkCancellation()
        count += Int64(chunk.count)
        guard count <= policy.maxBytes else { throw AudioInputPreparationError.invalidSize }
        hash.update(data: chunk)
      }
      copied = (count, Data(hash.finalize()).base64EncodedString())
      guard copied.bytes > 0, copied.bytes <= policy.maxBytes else {
        throw AudioInputPreparationError.invalidSize
      }
      let media: AudioInputInspection
      do { media = try await inspect(destination) } catch is CancellationError {
        throw CancellationError()
      } catch { throw AudioInputPreparationError.invalidAudio }
      guard !purgedOwners.contains(ownerUid),
        policy.accepts(bytes: copied.bytes, duration: media.duration),
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
        displayName: displayName, sourceURL: canonicalSourceURL,
        policyVersion: 2, preparationProfileId: policy.profileID,
        mediaSource: sourceKind == .url
          ? "youtube"
          : ["mp4", "mov", "m4v"].contains(source.pathExtension.lowercased())
            ? "video_file" : "audio_file")
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

  private static func sniffContainer(_ url: URL) throws -> AudioInputInspection.Container? {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    let bytes = [UInt8](try handle.read(upToCount: 12) ?? Data())
    if bytes.count >= 8, String(bytes: bytes[4..<8], encoding: .ascii) == "ftyp" { return .mp4 }
    if bytes.count >= 4, String(bytes: bytes[0..<4], encoding: .ascii) == "OggS" { return .ogg }
    if bytes.count >= 4, bytes[0..<4].elementsEqual([0x1A, 0x45, 0xDF, 0xA3]) { return .webm }
    if bytes.count >= 3, String(bytes: bytes[0..<3], encoding: .ascii) == "ID3" { return .mp3 }
    if bytes.count >= 2, bytes[0] == 0xFF, bytes[1] & 0xF0 == 0xF0 {
      return bytes[1] & 0x06 == 0 ? .aac : .mp3
    }
    return nil
  }

  static func inspectAudio(_ url: URL) async throws -> AudioInputInspection {
    let asset = AVURLAsset(url: url)
    let audio = try await asset.loadTracks(withMediaType: .audio)
    let video = try await asset.loadTracks(withMediaType: .video)
    let playable = try await asset.load(.isPlayable)
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
    let file = try AVAudioFile(forReading: url)
    // Match AudioFiles: fragmented M4A asset duration can be doubled; decoded
    // audio frame count gives the playable duration without rewriting the bytes.
    let duration = Double(file.length) / file.fileFormat.sampleRate
    return AudioInputInspection(
      duration: duration, hasAudio: !audio.isEmpty,
      hasVideo: !video.isEmpty, isPlayable: playable, container: container)
  }
}
