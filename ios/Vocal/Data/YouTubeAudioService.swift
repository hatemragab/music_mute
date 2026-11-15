import Foundation
import YouTubeKit

protocol AudioDownloading: Sendable {
  func discardAttempt(_ id: UUID) async
  func download(
    videoID: String, id: UUID,
    stage: @escaping @Sendable (DownloadStatus) -> Void,
    progress: @escaping @Sendable (DownloadProgress) -> Void
  ) async throws -> SavedAudio
}

extension AudioDownloading {
  func discardAttempt(_ id: UUID) async {}
}

struct YouTubeAudioService: AudioDownloading {
  let files: AudioFiles
  let sourceTransfers: any BackgroundSourceTransferring

  @MainActor init(
    files: AudioFiles, sourceTransfers: any BackgroundSourceTransferring
  ) {
    self.files = files
    self.sourceTransfers = sourceTransfers
  }

  func discardAttempt(_ id: UUID) async { await files.discardAttempt(id) }

  func download(
    videoID: String, id: UUID,
    stage: @escaping @Sendable (DownloadStatus) -> Void,
    progress: @escaping @Sendable (DownloadProgress) -> Void
  ) async throws -> SavedAudio {
    stage(.resolving)
    let resolved = try await resolve(videoID)
    try Task.checkCancellation()
    stage(.downloading)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 30
    configuration.timeoutIntervalForResource = 600
    let delegate = TransferProgress(report: progress)
    let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    var request = URLRequest(url: resolved.stream.url)
    request.setValue("Mozilla/5.0", forHTTPHeaderField: "User-Agent")
    let (temporary, response) = try await ResumableTransfer.download { resumeData in
      return try await delegate.download(session: session, request: request, resumeData: resumeData)
    }
    defer { try? FileManager.default.removeItem(at: temporary) }
    guard let http = response as? HTTPURLResponse,
      http.statusCode == 200 || http.statusCode == 206
    else {
      throw AudioFailure.unavailable
    }
    try Task.checkCancellation()
    stage(.checking)
    return try await files.saveDownloaded(temporary, id: id, resolved: resolved)
  }

  /// The processing flow uses a file-backed background session after local URL extraction
  /// resolves a supported direct audio URL. A persisted receipt is claimed first on relaunch.
  @MainActor func downloadForProcessing(
    videoID: String, id: UUID, ownerUid: String,
    policy: ProcessingMediaPolicy = .standard,
    stage: @escaping @Sendable (DownloadStatus) -> Void,
    progress: @escaping @Sendable (DownloadProgress) -> Void
  ) async throws -> SavedAudio {
    let restoredProgress: @Sendable (DownloadProgress) -> Void = { value in
      stage(.downloading)
      progress(value)
    }
    if let restored = try await sourceTransfers.restoredDownload(
      ownerUid: ownerUid, operationId: id, progress: restoredProgress)
    {
      return try await finishProcessingDownload(restored, id: id, stage: stage)
    }

    stage(.resolving)
    if policy.maxSourceDownloadBytes == nil || policy.maxSourceDownloadSeconds == nil {
      throw AudioInputPreparationError.policyUnavailable
    }
    let resolved = try await resolve(videoID, policy: policy)
    try Task.checkCancellation()
    stage(.downloading)
    var request = URLRequest(url: resolved.stream.url)
    request.setValue("Mozilla/5.0", forHTTPHeaderField: "User-Agent")
    let context = SourceTransferContext(
      ownerUid: ownerUid, operationId: id, transferId: UUID(), title: resolved.title,
      codec: resolved.stream.codec, fileExtension: resolved.stream.fileExtension,
      bitrate: resolved.stream.bitrate,
      maxDownloadBytes: policy.maxSourceDownloadBytes,
      maxDownloadSeconds: policy.maxSourceDownloadSeconds)
    let result = try await sourceTransfers.startDownload(
      request: request, context: context, progress: progress)
    return try await finishProcessingDownload(result, id: id, stage: stage)
  }

  @MainActor private func finishProcessingDownload(
    _ result: SourceTransferResult, id: UUID,
    stage: @escaping @Sendable (DownloadStatus) -> Void
  ) async throws -> SavedAudio {
    guard result.statusCode == 200 || result.statusCode == 206 else {
      sourceTransfers.consume(result)
      throw AudioFailure.unavailable
    }
    try Task.checkCancellation()
    stage(.checking)
    let stream = AudioCandidate(
      url: result.fileURL, hasVideo: false, codec: result.context.codec,
      fileExtension: result.context.fileExtension, bitrate: result.context.bitrate,
      isPlayable: true)
    do {
      let saved = try await files.saveDownloaded(
        result.fileURL, id: id,
        resolved: ResolvedAudio(title: result.context.title, stream: stream))
      sourceTransfers.consume(result)
      return saved
    } catch AudioFailure.invalidAudio {
      sourceTransfers.consume(result)
      throw AudioFailure.invalidAudio
    }
  }

  private func resolve(_ id: String, policy: ProcessingMediaPolicy? = nil) async throws
    -> ResolvedAudio
  {
    try await withThrowingTaskGroup(of: ResolvedAudio.self) { group in
      group.addTask {
        // Explicitly disallow the library's optional remote extractor.
        let duration = try await YouTubePreflight.inspectRecording(videoID: id)
        if let policy, !policy.accepts(bytes: 1, duration: duration) {
          throw AudioInputPreparationError.tooLong
        }
        let video = YouTube(videoID: id, methods: [.local])
        let streams = try await video.streams
        let candidates = streams.map { stream in
          let codec: String
          if case .mp4a = stream.audioCodec { codec = "AAC" } else { codec = "unsupported" }
          return AudioCandidate(
            url: stream.url, hasVideo: stream.includesVideoTrack,
            codec: codec, fileExtension: stream.fileExtension == .m4a ? "m4a" : "unsupported",
            bitrate: stream.averageBitrate ?? stream.bitrate ?? 0,
            isPlayable: stream.isNativelyPlayable && stream.includesAudioTrack)
        }
        let selected = try AudioPolicy.bestCompatibleAudio(candidates)
        let metadata = try await video.metadata
        return ResolvedAudio(title: String((metadata?.title ?? id).prefix(500)), stream: selected)
      }
      group.addTask {
        try await Task.sleep(for: .seconds(60))
        throw AudioFailure.network
      }
      defer { group.cancelAll() }
      guard let result = try await group.next() else { throw AudioFailure.unavailable }
      return result
    }
  }
}

enum ResumableTransfer {
  /// Resume only transient transport failures. URLSession owns assembly of the original bytes.
  static func download(
    operation: (Data?) async throws -> (URL, URLResponse),
    wait: (Int) async throws -> Void = { attempt in
      try await Task.sleep(for: .seconds(attempt))
    }
  ) async throws -> (URL, URLResponse) {
    var resumeData: Data?
    for attempt in 0...3 {
      try Task.checkCancellation()
      do {
        return try await operation(resumeData)
      } catch {
        try Task.checkCancellation()
        let failure = error as NSError
        guard attempt < 3, failure.domain == NSURLErrorDomain,
          [URLError.networkConnectionLost.rawValue, URLError.timedOut.rawValue].contains(
            failure.code)
        else { throw error }
        resumeData = failure.userInfo[NSURLSessionDownloadTaskResumeData] as? Data
        try await wait(attempt + 1)
      }
    }
    throw AudioFailure.network
  }
}

private final class TransferProgress: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
  private let report: @Sendable (DownloadProgress) -> Void
  private let lock = NSLock()
  private let startedAt = Date()
  private var lastReport = Date.distantPast
  private var continuation: CheckedContinuation<(URL, URLResponse), Error>?
  private var task: URLSessionDownloadTask?
  private var cancelled = false
  private var saved: URL?
  private var saveError: Error?
  init(report: @escaping @Sendable (DownloadProgress) -> Void) { self.report = report }
  func download(session: URLSession, request: URLRequest, resumeData: Data?) async throws -> (
    URL, URLResponse
  ) {
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        let task =
          resumeData.map { session.downloadTask(withResumeData: $0) }
          ?? session.downloadTask(with: request)
        lock.lock()
        if cancelled {
          lock.unlock()
          task.cancel()
          continuation.resume(throwing: CancellationError())
          return
        }
        self.continuation = continuation
        self.task = task
        saved = nil
        saveError = nil
        lastReport = .distantPast
        lock.unlock()
        task.resume()
      }
    } onCancel: {
      self.lock.lock()
      self.cancelled = true
      let task = self.task
      self.lock.unlock()
      task?.cancel()
    }
  }
  func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask,
    didFinishDownloadingTo location: URL
  ) {
    guard let bytes = try? location.resourceValues(forKeys: [.fileSizeKey]).fileSize,
      bytes > 0, bytes <= YouTubePreflight.maximumDownloadBytes,
      Date().timeIntervalSince(startedAt) <= YouTubePreflight.maximumDownloadSeconds
    else {
      saveError = AudioInputPreparationError.invalidSize
      return
    }
    // Delegate download files disappear after this callback returns.
    let destination = FileManager.default.temporaryDirectory.appendingPathComponent(
      UUID().uuidString)
    do {
      try FileManager.default.moveItem(at: location, to: destination)
      saved = destination
    } catch { saveError = error }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    lock.lock()
    let continuation = self.continuation
    self.continuation = nil
    self.task = nil
    lock.unlock()
    if let error = error ?? saveError {
      if let saved { try? FileManager.default.removeItem(at: saved) }
      continuation?.resume(throwing: error)
    } else if let saved, let response = task.response {
      continuation?.resume(returning: (saved, response))
    } else {
      continuation?.resume(throwing: AudioFailure.network)
    }
  }
  func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64
  ) {
    guard totalBytesWritten <= YouTubePreflight.maximumDownloadBytes,
      totalBytesExpectedToWrite <= YouTubePreflight.maximumDownloadBytes,
      Date().timeIntervalSince(startedAt) <= YouTubePreflight.maximumDownloadSeconds
    else {
      downloadTask.cancel()
      return
    }
    let value = DownloadProgress(
      downloadedBytes: max(0, totalBytesWritten),
      totalBytes: totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : nil)
    lock.lock()
    let changed = Date().timeIntervalSince(lastReport) >= 0.25
    if changed { lastReport = Date() }
    lock.unlock()
    if changed { report(value) }
  }
}
