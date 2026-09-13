import CryptoKit
import Foundation

struct SourceTransferContext: Codable, Equatable, Sendable {
  let ownerUid: String
  let operationId: UUID
  let transferId: UUID
  let title: String
  let codec: String
  let fileExtension: String
  let bitrate: Int
  var startedAt: Date? = Date()
  var maxDownloadBytes: Int64? = nil
  var maxDownloadSeconds: Double? = nil

  var downloadByteLimit: Int64 {
    min(
      maxDownloadBytes ?? YouTubePreflight.maximumDownloadBytes,
      YouTubePreflight.maximumDownloadBytes)
  }
  var downloadTimeLimit: Double {
    min(
      maxDownloadSeconds ?? YouTubePreflight.maximumDownloadSeconds,
      YouTubePreflight.maximumDownloadSeconds)
  }
}

struct SourceTransferResult: Equatable, Sendable {
  let context: SourceTransferContext
  let fileURL: URL
  let statusCode: Int?
}

@MainActor protocol BackgroundSourceTransferring: AnyObject, Sendable {
  func bind(ownerUid: String?) async
  func restoredDownload(
    ownerUid: String, operationId: UUID,
    progress: @escaping @Sendable (DownloadProgress) -> Void
  ) async throws -> SourceTransferResult?
  func startDownload(
    request: URLRequest, context: SourceTransferContext,
    progress: @escaping @Sendable (DownloadProgress) -> Void
  ) async throws -> SourceTransferResult
  func consume(_ result: SourceTransferResult)
  func cancel(ownerUid: String, operationId: UUID) async
  func cancel(context: SourceTransferContext) async
}

/// Owns direct source-file downloads that iOS can continue in a background URLSession.
/// Extraction and local media preparation remain app-execution work.
@MainActor
final class BackgroundSourceTransferCoordinator: NSObject,
  BackgroundSourceTransferring
{
  nonisolated static let backgroundSessionIdentifier =
    "com.hatem.musicmute.processing.source-downloads"
  static let shared = BackgroundSourceTransferCoordinator()

  private struct Receipt: Codable, Equatable {
    let context: SourceTransferContext
    let relativePath: String
    let statusCode: Int?
  }

  private struct Waiting {
    let continuation: CheckedContinuation<SourceTransferResult, Error>
    let progress: @Sendable (DownloadProgress) -> Void
  }

  private let identifier: String
  private let root: URL
  private let configurationFactory: @Sendable () -> URLSessionConfiguration
  private var ownerUid: String?
  private var captures: [Int: Result<URL, Error>] = [:]
  private var waiters: [UUID: Waiting] = [:]
  private var backgroundHandlers: [() -> Void] = []
  private var finishedEvents = false

  private lazy var session: URLSession = {
    URLSession(configuration: configurationFactory(), delegate: self, delegateQueue: .main)
  }()

  init(
    identifier: String = BackgroundSourceTransferCoordinator.backgroundSessionIdentifier,
    root: URL? = nil,
    configurationFactory: (@Sendable () -> URLSessionConfiguration)? = nil
  ) {
    self.identifier = identifier
    self.root =
      root
      ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Vocal/ProcessingSourceDownloads", isDirectory: true)
    self.configurationFactory =
      configurationFactory ?? {
        let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
        configuration.isDiscretionary = false
        configuration.sessionSendsLaunchEvents = true
        configuration.allowsCellularAccess = true
        configuration.allowsExpensiveNetworkAccess = true
        configuration.allowsConstrainedNetworkAccess = true
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = YouTubePreflight.maximumDownloadSeconds
        return configuration
      }
    super.init()
  }

  private var purgedOwners = Set<String>()

  func purge(ownerUid: String) async throws {
    purgedOwners.insert(ownerUid)
    for task in await session.allTasks {
      if let context = Self.context(task), context.ownerUid == ownerUid { task.cancel() }
    }
    let directory = root.appendingPathComponent(ProcessingStore.ownerDirectoryName(ownerUid))
    if FileManager.default.fileExists(atPath: directory.path) {
      try FileManager.default.removeItem(at: directory)
    }
  }

  func bind(ownerUid: String?) async {
    guard ownerUid != self.ownerUid else { return }
    self.ownerUid = ownerUid
    for task in await session.allTasks {
      guard let context = Self.context(task), context.ownerUid != ownerUid else { continue }
      task.cancel()
      resumeWaiter(context.transferId, with: .failure(CancellationError()))
    }
  }

  func restoredDownload(
    ownerUid: String, operationId: UUID,
    progress: @escaping @Sendable (DownloadProgress) -> Void
  ) async throws -> SourceTransferResult? {
    try Task.checkCancellation()
    guard self.ownerUid == ownerUid else { throw AudioPipelineFailure.sessionChanged }
    if let receipt = try receipt(ownerUid: ownerUid, operationId: operationId) {
      return try result(from: receipt)
    }
    let tasks = await session.allTasks
    if let receipt = try receipt(ownerUid: ownerUid, operationId: operationId) {
      return try result(from: receipt)
    }
    guard
      let task = tasks.compactMap({ $0 as? URLSessionDownloadTask }).first(where: { task in
        guard let context = Self.context(task) else { return false }
        return context.ownerUid == ownerUid && context.operationId == operationId
          && task.state != .canceling && task.state != .completed
      }), let context = Self.context(task)
    else { return nil }
    return try await wait(for: task, context: context, progress: progress)
  }

  func startDownload(
    request: URLRequest, context: SourceTransferContext,
    progress: @escaping @Sendable (DownloadProgress) -> Void
  ) async throws -> SourceTransferResult {
    try Task.checkCancellation()
    guard ownerUid == context.ownerUid else { throw AudioPipelineFailure.sessionChanged }
    guard request.url?.scheme == "https", request.url?.host != nil,
      request.url?.user == nil, request.url?.password == nil
    else { throw AudioFailure.unavailable }
    if let restored = try await restoredDownload(
      ownerUid: context.ownerUid, operationId: context.operationId, progress: progress)
    {
      return restored
    }
    var boundedContext = context
    if let directory = try? directory(for: context),
      let previous = try? activeContext(in: directory), let startedAt = previous.startedAt
    {
      boundedContext.startedAt = startedAt
    }
    guard let started = boundedContext.startedAt,
      boundedContext.downloadByteLimit > 0, boundedContext.downloadTimeLimit > 0,
      Date().timeIntervalSince(started) <= boundedContext.downloadTimeLimit
    else {
      throw AudioInputPreparationError.interrupted
    }
    try claim(boundedContext)
    let task = session.downloadTask(with: request)
    task.taskDescription = String(data: try JSONEncoder().encode(boundedContext), encoding: .utf8)
    return try await wait(for: task, context: boundedContext, progress: progress)
  }

  func consume(_ result: SourceTransferResult) {
    guard let directory = try? directory(for: result.context),
      (try? activeContext(in: directory))?.transferId == result.context.transferId
    else { return }
    try? FileManager.default.removeItem(at: directory)
  }

  func cancel(ownerUid: String, operationId: UUID) async {
    for task in await session.allTasks {
      guard let context = Self.context(task), context.ownerUid == ownerUid,
        context.operationId == operationId
      else { continue }
      task.cancel()
      resumeWaiter(context.transferId, with: .failure(CancellationError()))
    }
  }

  func cancel(context expected: SourceTransferContext) async {
    for task in await session.allTasks {
      guard let context = Self.context(task), context.ownerUid == expected.ownerUid,
        context.operationId == expected.operationId, context.transferId == expected.transferId
      else { continue }
      task.cancel()
    }
    resumeWaiter(expected.transferId, with: .failure(CancellationError()))
  }

  @discardableResult
  func handleBackgroundEvents(identifier: String, completionHandler: @escaping () -> Void) -> Bool {
    guard identifier == self.identifier else { return false }
    backgroundHandlers.append(completionHandler)
    _ = session
    drainBackgroundHandlers()
    return true
  }

  private func wait(
    for task: URLSessionDownloadTask, context: SourceTransferContext,
    progress: @escaping @Sendable (DownloadProgress) -> Void
  ) async throws -> SourceTransferResult {
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        guard waiters[context.transferId] == nil else {
          continuation.resume(throwing: ProcessingStoreFailure.conflictingIntent)
          return
        }
        waiters[context.transferId] = Waiting(continuation: continuation, progress: progress)
        task.resume()
      }
    } onCancel: {
      Task { @MainActor [weak self] in
        await self?.cancel(context: context)
      }
    }
  }

  private func receiveCompletion(task: URLSessionTask, error: Error?) {
    guard let context = Self.context(task) else { return }
    let result: Result<SourceTransferResult, Error>
    if let error {
      if let captured = captures.removeValue(forKey: task.taskIdentifier),
        case .success(let file) = captured,
        let directory = try? directory(for: context),
        (try? activeContext(in: directory))?.transferId == context.transferId
      {
        try? FileManager.default.removeItem(at: file)
      }
      result = .failure(error)
    } else {
      switch captures.removeValue(forKey: task.taskIdentifier) {
      case .success:
        do {
          guard
            let receipt = try receipt(
              ownerUid: context.ownerUid, operationId: context.operationId),
            receipt.context.transferId == context.transferId
          else { throw AudioFailure.storage }
          result = .success(try self.result(from: receipt))
        } catch { result = .failure(error) }
      case .failure(let error): result = .failure(error)
      case nil: result = .failure(AudioFailure.network)
      }
    }
    resumeWaiter(context.transferId, with: result)
  }

  private func resumeWaiter(_ transferId: UUID, with result: Result<SourceTransferResult, Error>) {
    guard let waiting = waiters.removeValue(forKey: transferId) else { return }
    waiting.continuation.resume(with: result)
  }

  func capture(_ location: URL, task: URLSessionDownloadTask) {
    guard captures[task.taskIdentifier] == nil, let context = Self.context(task) else { return }
    do {
      let bytes = try location.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
      guard bytes > 0, bytes <= context.downloadByteLimit,
        context.startedAt.map({ Date().timeIntervalSince($0) <= context.downloadTimeLimit })
          ?? false
      else {
        throw AudioInputPreparationError.invalidSize
      }
      try prepareDirectory(for: context)
      let directory = try directory(for: context)
      guard try activeContext(in: directory)?.transferId == context.transferId else {
        throw CancellationError()
      }
      let file = directory.appendingPathComponent("source.\(context.fileExtension)")
      if FileManager.default.fileExists(atPath: file.path) {
        try FileManager.default.removeItem(at: file)
      }
      try FileManager.default.moveItem(at: location, to: file)
      let status = (task.response as? HTTPURLResponse)?.statusCode
      let receipt = Receipt(
        context: context, relativePath: file.lastPathComponent, statusCode: status)
      let data = try JSONEncoder().encode(receipt)
      try data.write(to: directory.appendingPathComponent("receipt.json"), options: .atomic)
      captures[task.taskIdentifier] = .success(file)
    } catch {
      captures[task.taskIdentifier] = .failure(error)
    }
  }

  private func result(from receipt: Receipt) throws -> SourceTransferResult {
    let directory = try directory(for: receipt.context)
    guard try activeContext(in: directory)?.transferId == receipt.context.transferId else {
      throw CancellationError()
    }
    let file = directory.appendingPathComponent(receipt.relativePath).standardizedFileURL
    guard file.deletingLastPathComponent() == directory.standardizedFileURL,
      let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
      values.isRegularFile == true, (values.fileSize ?? 0) > 0,
      Int64(values.fileSize ?? 0) <= receipt.context.downloadByteLimit
    else {
      try? FileManager.default.removeItem(at: directory.appendingPathComponent("receipt.json"))
      throw AudioFailure.storage
    }
    return SourceTransferResult(
      context: receipt.context, fileURL: file, statusCode: receipt.statusCode)
  }

  private func receipt(ownerUid: String, operationId: UUID) throws -> Receipt? {
    let context = SourceTransferContext(
      ownerUid: ownerUid, operationId: operationId, transferId: operationId,
      title: "", codec: "", fileExtension: "m4a", bitrate: 0)
    let directory = try directory(for: context)
    let file = directory.appendingPathComponent("receipt.json")
    guard FileManager.default.fileExists(atPath: file.path) else { return nil }
    let receipt = try JSONDecoder().decode(Receipt.self, from: Data(contentsOf: file))
    guard receipt.context.ownerUid == ownerUid, receipt.context.operationId == operationId else {
      throw ProcessingStoreFailure.invalidPath
    }
    return receipt
  }

  private func prepareDirectory(for context: SourceTransferContext) throws {
    let directory = try directory(for: context)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var excluded = directory
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try excluded.setResourceValues(values)
  }

  func claim(_ context: SourceTransferContext) throws {
    try prepareDirectory(for: context)
    let directory = try directory(for: context)
    if let active = try activeContext(in: directory), active.transferId != context.transferId {
      resumeWaiter(active.transferId, with: .failure(CancellationError()))
      try? FileManager.default.removeItem(at: directory.appendingPathComponent("receipt.json"))
      for child
        in (try? FileManager.default.contentsOfDirectory(
          at: directory, includingPropertiesForKeys: nil)) ?? []
      where child.lastPathComponent.hasPrefix("source.") {
        try? FileManager.default.removeItem(at: child)
      }
    }
    try JSONEncoder().encode(context).write(
      to: directory.appendingPathComponent("active.json"), options: .atomic)
  }

  private func activeContext(in directory: URL) throws -> SourceTransferContext? {
    let file = directory.appendingPathComponent("active.json")
    guard FileManager.default.fileExists(atPath: file.path) else { return nil }
    return try JSONDecoder().decode(SourceTransferContext.self, from: Data(contentsOf: file))
  }

  private func directory(for context: SourceTransferContext) throws -> URL {
    guard !purgedOwners.contains(context.ownerUid), !context.ownerUid.isEmpty else {
      throw ProcessingStoreFailure.invalidPath
    }
    let owner = SHA256.hash(data: Data(context.ownerUid.utf8)).map {
      String(format: "%02x", $0)
    }.joined()
    let directory = root.appendingPathComponent(owner, isDirectory: true)
      .appendingPathComponent(context.operationId.uuidString, isDirectory: true)
      .standardizedFileURL
    let base = root.standardizedFileURL.path + "/"
    guard directory.path.hasPrefix(base) else { throw ProcessingStoreFailure.invalidPath }
    return directory
  }

  private nonisolated static func context(_ task: URLSessionTask) -> SourceTransferContext? {
    guard let value = task.taskDescription, value.utf8.count <= 4096,
      let data = value.data(using: .utf8),
      let context = try? JSONDecoder().decode(SourceTransferContext.self, from: data),
      !context.ownerUid.isEmpty
    else { return nil }
    return context
  }

  private func drainBackgroundHandlers() {
    guard finishedEvents, !backgroundHandlers.isEmpty else { return }
    let handlers = backgroundHandlers
    backgroundHandlers.removeAll()
    finishedEvents = false
    for handler in handlers { handler() }
  }
}

extension BackgroundSourceTransferCoordinator: URLSessionDownloadDelegate, URLSessionDelegate {
  nonisolated func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask,
    didFinishDownloadingTo location: URL
  ) {
    MainActor.assumeIsolated { self.capture(location, task: downloadTask) }
  }

  nonisolated func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64
  ) {
    guard let context = Self.context(downloadTask) else { return }
    guard totalBytesWritten <= context.downloadByteLimit,
      totalBytesExpectedToWrite <= context.downloadByteLimit,
      context.startedAt.map({
        Date().timeIntervalSince($0) <= context.downloadTimeLimit
      }) ?? false
    else {
      downloadTask.cancel()
      return
    }
    let progress = DownloadProgress(
      downloadedBytes: max(0, totalBytesWritten),
      totalBytes: totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : nil)
    MainActor.assumeIsolated { self.waiters[context.transferId]?.progress(progress) }
  }

  nonisolated func urlSession(
    _ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?
  ) {
    MainActor.assumeIsolated { self.receiveCompletion(task: task, error: error) }
  }

  nonisolated func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    MainActor.assumeIsolated {
      self.finishedEvents = true
      self.drainBackgroundHandlers()
    }
  }
}
