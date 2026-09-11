import Foundation

enum ArtifactDownloadFailure: Error, Equatable, Sendable {
  case httpStatus(Int)
  case redirectRejected, invalidGrant, interrupted
}

@MainActor protocol ArtifactDownloading: AnyObject {
  func download(
    from source: URL, to destination: URL,
    progress: @escaping @Sendable (Int64, Int64?) -> Void
  ) async throws
}

/// Dedicated file-based downloads use no API credentials or cookies. Process loss requires a
/// fresh explicit action; neither signed URLs nor URLSession resume data are persisted.
@MainActor final class URLSessionArtifactDownloader: ArtifactDownloading {
  private let configuration: URLSessionConfiguration

  init(configuration: URLSessionConfiguration = .ephemeral) {
    let configuration = configuration.copy() as! URLSessionConfiguration
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCredentialStorage = nil
    configuration.urlCache = nil
    configuration.httpAdditionalHeaders = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForRequest = 30
    configuration.timeoutIntervalForResource = 600
    self.configuration = configuration
  }

  func download(
    from source: URL, to destination: URL,
    progress: @escaping @Sendable (Int64, Int64?) -> Void
  ) async throws {
    guard source.scheme?.lowercased() == "https", source.host?.isEmpty == false,
      source.user == nil, source.password == nil, source.fragment == nil
    else { throw ArtifactDownloadFailure.invalidGrant }
    var request = URLRequest(url: source, cachePolicy: .reloadIgnoringLocalCacheData)
    request.httpMethod = "GET"
    request.httpShouldHandleCookies = false
    let operation = ArtifactDownloadOperation(destination: destination, progress: progress)
    try await operation.start(configuration: configuration, request: request)
  }
}

/// URLSession delegate state is synchronized because cancellation can arrive on another executor.
private final class ArtifactDownloadOperation: NSObject, URLSessionDownloadDelegate,
  @unchecked Sendable
{
  private let destination: URL
  private let progress: @Sendable (Int64, Int64?) -> Void
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Void, Error>?
  private var session: URLSession?
  private var task: URLSessionDownloadTask?
  private var cancelled = false
  private var finished = false
  private var fileReady = false

  init(destination: URL, progress: @escaping @Sendable (Int64, Int64?) -> Void) {
    self.destination = destination
    self.progress = progress
  }

  func start(configuration: URLSessionConfiguration, request: URLRequest) async throws {
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation {
        (continuation: CheckedContinuation<Void, Error>) in
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        let task = session.downloadTask(with: request)
        lock.lock()
        if cancelled {
          lock.unlock()
          session.invalidateAndCancel()
          continuation.resume(throwing: CancellationError())
          return
        }
        self.continuation = continuation
        self.session = session
        self.task = task
        lock.unlock()
        task.resume()
      }
    } onCancel: {
      self.cancel()
    }
  }

  private func cancel() {
    lock.lock()
    cancelled = true
    lock.unlock()
    finish(.failure(CancellationError()))
  }

  func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask,
    didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64
  ) {
    lock.lock()
    let active = !finished && !cancelled
    lock.unlock()
    guard active else { return }
    progress(
      max(0, totalBytesWritten), totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : nil)
  }

  func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask,
    didFinishDownloadingTo location: URL
  ) {
    guard let response = downloadTask.response as? HTTPURLResponse else {
      finish(.failure(ArtifactDownloadFailure.interrupted))
      return
    }
    guard (200...299).contains(response.statusCode) else {
      finish(.failure(ArtifactDownloadFailure.httpStatus(response.statusCode)))
      return
    }
    do {
      let bytes = Int64(try location.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0)
      if response.expectedContentLength >= 0, bytes != response.expectedContentLength {
        finish(.failure(ArtifactDownloadFailure.interrupted))
        return
      }
      lock.lock()
      guard !finished && !cancelled else {
        lock.unlock()
        return
      }
      do {
        // URLSession owns location only for this delegate invocation; move before returning.
        try FileManager.default.moveItem(at: location, to: destination)
        fileReady = true
        lock.unlock()
      } catch {
        lock.unlock()
        throw JobArtifactFailure.storage
      }
      progress(bytes, response.expectedContentLength > 0 ? response.expectedContentLength : nil)
    } catch {
      finish(.failure(JobArtifactFailure.storage))
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    lock.lock()
    let wasCancelled = cancelled
    let ready = fileReady
    lock.unlock()
    if wasCancelled {
      finish(.failure(CancellationError()))
      return
    }
    if let error = error as? URLError,
      [.cannotWriteToFile, .cannotCreateFile, .cannotMoveFile, .noPermissionsToReadFile].contains(
        error.code)
    {
      finish(.failure(JobArtifactFailure.storage))
    } else if error != nil || !ready {
      finish(.failure(ArtifactDownloadFailure.interrupted))
    } else {
      finish(.success(()))
    }
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
    finish(.failure(ArtifactDownloadFailure.redirectRejected))
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    completionHandler(
      challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust
        ? .performDefaultHandling : .cancelAuthenticationChallenge, nil)
  }

  private func finish(_ result: Result<Void, Error>) {
    lock.lock()
    guard !finished else {
      lock.unlock()
      return
    }
    finished = true
    let continuation = self.continuation
    let session = self.session
    self.continuation = nil
    self.session = nil
    task = nil
    lock.unlock()
    switch result {
    case .success: session?.finishTasksAndInvalidate()
    case .failure: session?.invalidateAndCancel()
    }
    continuation?.resume(with: result)
  }
}
