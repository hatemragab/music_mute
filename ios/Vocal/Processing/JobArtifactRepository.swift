import AVFoundation
import AudioToolbox
import Combine
import Foundation

enum JobArtifactFailure: Error, Equatable, Sendable {
  case unavailable, invalidOutput, storage
}

struct JobArtifactProgress: Equatable, Sendable {
  let receivedBytes: Int64
  let totalBytes: Int64?
}

/// Explicit result actions share one transfer per owner/job. A valid private cache is retained.
@MainActor final class JobArtifactRepository: ObservableObject {
  @Published private(set) var progress: [String: JobArtifactProgress] = [:]
  private let api: JobsAPI
  private let root: URL
  private let sessionProvider: @MainActor () -> SessionFence?
  private let transport: ArtifactDownloading
  private let validate: @Sendable (URL) async throws -> Void
  private var boundSession: SessionFence?
  private var deletedJobIDs = Set<String>()
  private struct Flight {
    let token: UUID
    let fence: SessionFence
    let task: Task<URL, Error>
  }
  private var inFlight: [String: Flight] = [:]
  private var grantRequestIDs: [String: UUID] = [:]

  init(
    api: JobsAPI, root: URL, sessionProvider: @escaping @MainActor () -> SessionFence?,
    transport: ArtifactDownloading? = nil,
    validate: @escaping @Sendable (URL) async throws -> Void = { try await validateMP3Artifact($0) }
  ) {
    self.api = api
    self.root = root.standardizedFileURL.resolvingSymlinksInPath()
    self.sessionProvider = sessionProvider
    self.transport = transport ?? URLSessionArtifactDownloader()
    self.validate = validate
    boundSession = sessionProvider()
  }

  func purge(ownerUid: String) async throws {
    let stopping = inFlight.values.filter { $0.fence.uid == ownerUid }
    for flight in stopping { flight.task.cancel() }
    grantRequestIDs.removeAll()
    onSessionChanged()
    for flight in stopping { _ = try? await flight.task.value }
    let directory = root.appendingPathComponent(ProcessingStore.ownerDirectoryName(ownerUid))
    if FileManager.default.fileExists(atPath: directory.path) {
      try FileManager.default.removeItem(at: directory)
    }
  }

  func onSessionChanged() {
    let current = sessionProvider()
    guard current != boundSession else { return }
    boundSession = current
    for flight in inFlight.values { flight.task.cancel() }
    inFlight.removeAll()
    progress.removeAll()
    deletedJobIDs.removeAll()
    grantRequestIDs.removeAll()
  }

  func ensureOutput(jobId: String) async throws -> URL {
    try Task.checkCancellation()
    guard jobId.range(of: "^[0-9a-fA-F]{24}$", options: .regularExpression) != nil else {
      throw JobsFailure.invalidInput
    }
    onSessionChanged()
    guard let fence = sessionProvider() else { throw AuthFailure.sessionExpired }
    let id = jobId.lowercased()
    guard !deletedJobIDs.contains(id) else { throw JobsFailure.notFound }
    if let existing = inFlight[id], existing.fence == fence {
      let result = try await existing.task.value
      try check(fence, jobId: id)
      return result
    }
    let token = UUID()
    let task = Task { [weak self] in
      guard let self else { throw CancellationError() }
      return try await self.fetch(jobId: id, fence: fence, token: token)
    }
    inFlight[id] = Flight(token: token, fence: fence, task: task)
    do {
      let result = try await task.value
      finish(jobId: id, token: token)
      try check(fence, jobId: id)
      return result
    } catch {
      finish(jobId: id, token: token)
      throw error
    }
  }

  /// Returns a private, correctly named MP3 for user-initiated play/export/share actions.
  func preparedOutput(jobId: String, displayName: String) async throws -> URL {
    let output = try await ensureOutput(jobId: jobId)
    guard let fence = sessionProvider() else { throw AuthFailure.sessionExpired }
    let id = jobId.lowercased()
    try check(fence, jobId: id)
    let directory = output.deletingLastPathComponent().appendingPathComponent(
      "Named", isDirectory: true)
    try await prepare(directory: directory)
    try check(fence, jobId: id)
    let filename = Self.safeFilename(displayName) + ".mp3"
    let destination = directory.appendingPathComponent(filename)
    do {
      for file in try FileManager.default.contentsOfDirectory(
        at: directory, includingPropertiesForKeys: nil)
      where file != destination {
        try? FileManager.default.removeItem(at: file)
      }
      if !FileManager.default.fileExists(atPath: destination.path) {
        try FileManager.default.copyItem(at: output, to: destination)
      }
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
        ofItemAtPath: destination.path)
      try check(fence, jobId: id)
      return destination
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw JobArtifactFailure.storage
    }
  }

  /// Deletes only this account/job's app-private cache. Exports made by other apps are untouched.
  func removeCached(jobId: String) async {
    guard jobId.range(of: "^[0-9a-fA-F]{24}$", options: .regularExpression) != nil,
      let fence = sessionProvider()
    else { return }
    let id = jobId.lowercased()
    deletedJobIDs.insert(id)
    grantRequestIDs[id] = nil
    let flight = inFlight.removeValue(forKey: id)
    flight?.task.cancel()
    _ = try? await flight?.task.value
    guard sessionProvider() == fence else { return }
    progress[id] = nil
    let directory = root.appendingPathComponent(ProcessingStore.ownerDirectoryName(fence.uid))
      .appendingPathComponent(id, isDirectory: true)
    try? FileManager.default.removeItem(at: directory)
  }

  private func fetch(jobId: String, fence: SessionFence, token: UUID) async throws -> URL {
    let directory = root.appendingPathComponent(ProcessingStore.ownerDirectoryName(fence.uid))
      .appendingPathComponent(jobId, isDirectory: true)
    let destination = directory.appendingPathComponent("output.mp3")
    try await prepare(directory: directory)
    try check(fence, jobId: jobId)
    if let existing = try await validCache(destination) {
      try check(fence, jobId: jobId)
      grantRequestIDs[jobId] = nil
      return existing
    }
    var grantRequestID = grantRequestIDs[jobId] ?? UUID()
    grantRequestIDs[jobId] = grantRequestID
    for attempt in 0...1 {
      try check(fence, jobId: jobId)
      let job = try await api.detail(id: jobId)
      try check(fence, jobId: jobId)
      guard job.status == "ready", job.canDownloadOutput else {
        throw JobArtifactFailure.unavailable
      }
      let grant = try await api.download(
        id: jobId, artifact: "output", requestId: grantRequestID)
      try check(fence, jobId: jobId)
      let partial = directory.appendingPathComponent(".download-\(UUID().uuidString).partial")
      progress[jobId] = JobArtifactProgress(receivedBytes: 0, totalBytes: nil)
      do {
        try await transport.download(from: grant.url, to: partial) { [weak self] received, total in
          Task { @MainActor [weak self] in
            guard let self, self.sessionProvider() == fence,
              self.inFlight[jobId]?.token == token
            else { return }
            self.progress[jobId] = JobArtifactProgress(
              receivedBytes: max(0, received), totalBytes: total.flatMap { $0 > 0 ? $0 : nil })
          }
        }
        try check(fence, jobId: jobId)
        try await validate(partial)
        try check(fence, jobId: jobId)
        // Another completed cache must never be overwritten by a late partial callback.
        if let existing = try await validCache(destination) {
          try check(fence, jobId: jobId)
          try? FileManager.default.removeItem(at: partial)
          grantRequestIDs[jobId] = nil
          return existing
        }
        try check(fence, jobId: jobId)
        // Both files are siblings: rename/replace is atomic and contains no suspending boundary.
        try promote(partial: partial, destination: destination)
        grantRequestIDs[jobId] = nil
        return destination
      } catch {
        // Only this call's incomplete file is disposable; retained caches remain untouched.
        try? FileManager.default.removeItem(at: partial)
        try check(fence, jobId: jobId)
        if attempt == 0, error as? ArtifactDownloadFailure == .httpStatus(403),
          grant.expiresAt <= Date()
        {
          // A known-expired entitlement is a new grant. Unknown transfer failures keep the same
          // request identity for the next user retry so they cannot be charged twice.
          grantRequestID = UUID()
          grantRequestIDs[jobId] = grantRequestID
          continue
        }
        throw error
      }
    }
    throw ArtifactDownloadFailure.interrupted
  }

  private func validCache(_ file: URL) async throws -> URL? {
    guard FileManager.default.fileExists(atPath: file.path) else { return nil }
    do {
      try await validate(file)
      return file
    } catch is CancellationError {
      throw CancellationError()
    } catch JobArtifactFailure.storage {
      throw JobArtifactFailure.storage
    } catch {
      return nil
    }
  }

  private func prepare(directory: URL) async throws {
    let root = root
    do {
      try await Task.detached(priority: .utility) {
        try Task.checkCancellation()
        try FileManager.default.createDirectory(
          at: directory, withIntermediateDirectories: true,
          attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        guard directory.resolvingSymlinksInPath().path.hasPrefix(root.path + "/") else {
          throw JobArtifactFailure.storage
        }
        var excluded = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try excluded.setResourceValues(values)
      }.value
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw JobArtifactFailure.storage
    }
  }

  private func promote(partial: URL, destination: URL) throws {
    do {
      var excluded = partial
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try excluded.setResourceValues(values)
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
        ofItemAtPath: partial.path)
      if FileManager.default.fileExists(atPath: destination.path) {
        _ = try FileManager.default.replaceItemAt(
          destination, withItemAt: partial, options: .usingNewMetadataOnly)
      } else {
        try FileManager.default.moveItem(at: partial, to: destination)
      }
    } catch {
      throw JobArtifactFailure.storage
    }
  }

  private func finish(jobId: String, token: UUID) {
    guard inFlight[jobId]?.token == token else { return }
    inFlight[jobId] = nil
    progress[jobId] = nil
  }

  private func check(_ fence: SessionFence) throws {
    try Task.checkCancellation()
    guard sessionProvider() == fence else { throw CancellationError() }
  }

  private func check(_ fence: SessionFence, jobId: String) throws {
    try check(fence)
    guard !deletedJobIDs.contains(jobId) else { throw CancellationError() }
  }

  private static func safeFilename(_ raw: String) -> String {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    let cleaned = trimmed.unicodeScalars.map { scalar -> Character in
      if scalar == "/" || scalar == ":" || scalar.properties.generalCategory == .control {
        return "_"
      }
      return Character(String(scalar))
    }
    let value = String(cleaned.prefix(100)).trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? String(localized: "processing_untitled") : value
  }
}

/// Checks the actual container and decodes audio frames; a renamed M4A or HTML body is not an MP3.
func validateMP3Artifact(_ url: URL) async throws {
  try await Task.detached(priority: .utility) {
    try Task.checkCancellation()
    guard let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 0 else {
      throw JobArtifactFailure.invalidOutput
    }
    var fileID: AudioFileID?
    guard AudioFileOpenURL(url as CFURL, .readPermission, 0, &fileID) == noErr, let fileID else {
      throw JobArtifactFailure.invalidOutput
    }
    defer { AudioFileClose(fileID) }
    var type: AudioFileTypeID = 0
    var propertySize = UInt32(MemoryLayout<AudioFileTypeID>.size)
    guard AudioFileGetProperty(fileID, kAudioFilePropertyFileFormat, &propertySize, &type) == noErr,
      type == kAudioFileMP3Type
    else { throw JobArtifactFailure.invalidOutput }
    do {
      let audio = try AVAudioFile(forReading: url)
      let duration = Double(audio.length) / audio.fileFormat.sampleRate
      guard audio.length > 0, duration.isFinite, duration > 0,
        let buffer = AVAudioPCMBuffer(pcmFormat: audio.processingFormat, frameCapacity: 4096)
      else { throw JobArtifactFailure.invalidOutput }
      try audio.read(into: buffer)
      guard buffer.frameLength > 0 else { throw JobArtifactFailure.invalidOutput }
      try Task.checkCancellation()
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw JobArtifactFailure.invalidOutput
    }
  }.value
}
