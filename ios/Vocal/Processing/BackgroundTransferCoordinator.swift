import Foundation

struct TransferContext: Codable, Equatable, Sendable {
  let ownerUid: String
  let operationId: UUID
  let transferId: UUID
}

struct TransferProgressSnapshot: Equatable, Sendable {
  let completedBytes: Int64
  let totalBytes: Int64?
  var fraction: Double? {
    guard let totalBytes, totalBytes > 0 else { return nil }
    return min(max(Double(completedBytes) / Double(totalBytes), 0), 1)
  }
}

struct TransferCompletion: Sendable {
  let context: TransferContext
  let statusCode: Int?
  let succeeded: Bool
}

@MainActor protocol BackgroundTransferring: AnyObject {
  var onCompletion: ((TransferCompletion) async -> Void)? { get set }
  var onProgress: ((TransferContext, TransferProgressSnapshot) -> Void)? { get set }
  func startUpload(file: S3MultipartFile, grant: UploadGrant, context: TransferContext) async throws
    -> Int
  func activeTransfers() async -> [TransferContext]
  func cancel(ownerUid: String, operationId: UUID?) async
  func cancel(context: TransferContext) async
}

/// The operating system owns file-backed transfer work; authenticated API calls stay outside it.
@MainActor final class BackgroundTransferCoordinator: NSObject, BackgroundTransferring {
  nonisolated static let backgroundSessionIdentifier = "com.hatem.vocal.processing.transfers"
  static let shared = BackgroundTransferCoordinator()

  var onCompletion: ((TransferCompletion) async -> Void)? {
    didSet { dispatchBufferedCompletions() }
  }
  var onProgress: ((TransferContext, TransferProgressSnapshot) -> Void)?
  private let identifier: String
  private var backgroundHandlers: [() -> Void] = []
  private var bufferedCompletions: [TransferCompletion] = []
  private var pendingPersistence = 0
  private var finishedEvents = false
  private lazy var session: URLSession = {
    let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
    configuration.isDiscretionary = false
    configuration.sessionSendsLaunchEvents = true
    configuration.httpShouldSetCookies = false
    configuration.httpCookieAcceptPolicy = .never
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForRequest = 60
    configuration.timeoutIntervalForResource = 3_600
    return URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
  }()

  init(identifier: String = BackgroundTransferCoordinator.backgroundSessionIdentifier) {
    self.identifier = identifier
    super.init()
  }

  @discardableResult
  func handleBackgroundEvents(identifier: String, completionHandler: @escaping () -> Void) -> Bool {
    guard identifier == self.identifier else { return false }
    backgroundHandlers.append(completionHandler)
    _ = session
    drainBackgroundHandlers()
    return true
  }

  func startUpload(file: S3MultipartFile, grant: UploadGrant, context: TransferContext) async throws
    -> Int
  {
    try Task.checkCancellation()
    try file.validate()
    guard grant.expiresAt > Date() else { throw ProcessingTransferFailure.expiredGrant }
    let request = try Self.uploadRequest(grant: grant, multipart: file)
    let task = session.uploadTask(with: request, fromFile: file.fileURL)
    task.taskDescription = String(data: try JSONEncoder().encode(context), encoding: .utf8)
    task.resume()
    return task.taskIdentifier
  }

  static func uploadRequest(grant: UploadGrant, multipart: S3MultipartFile) throws -> URLRequest {
    guard grant.url.scheme == "https", grant.url.host != nil,
      grant.url.user == nil, grant.url.password == nil, grant.url.fragment == nil
    else { throw ProcessingTransferFailure.invalidGrant }
    var request = URLRequest(
      url: grant.url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 60)
    request.httpMethod = "POST"
    request.httpShouldHandleCookies = false
    request.setValue(multipart.contentType, forHTTPHeaderField: "Content-Type")
    request.setValue(String(multipart.bytes), forHTTPHeaderField: "Content-Length")
    return request
  }

  func activeTransfers() async -> [TransferContext] {
    await session.allTasks.filter { $0.state == .running || $0.state == .suspended }
      .compactMap(Self.context)
  }

  func cancel(ownerUid: String, operationId: UUID? = nil) async {
    for task in await session.allTasks {
      guard let context = Self.context(task), context.ownerUid == ownerUid,
        operationId == nil || context.operationId == operationId
      else { continue }
      task.cancel()
    }
  }

  /// A captured transfer ID remains safe even if enumeration suspends across a rebind.
  func cancel(context expected: TransferContext) async {
    for task in await session.allTasks {
      guard let context = Self.context(task), context.ownerUid == expected.ownerUid,
        context.operationId == expected.operationId, context.transferId == expected.transferId
      else { continue }
      task.cancel()
    }
  }

  private nonisolated static func context(_ task: URLSessionTask) -> TransferContext? {
    guard let description = task.taskDescription, description.utf8.count <= 4096,
      let data = description.data(using: .utf8),
      let context = try? JSONDecoder().decode(TransferContext.self, from: data),
      !context.ownerUid.isEmpty
    else { return nil }
    return context
  }

  private func receiveCompletion(_ completion: TransferCompletion) {
    pendingPersistence += 1
    bufferedCompletions.append(completion)
    dispatchBufferedCompletions()
  }

  private func dispatchBufferedCompletions() {
    guard let onCompletion else { return }
    let buffered = bufferedCompletions
    bufferedCompletions.removeAll()
    for completion in buffered {
      Task { @MainActor in
        await onCompletion(completion)
        pendingPersistence -= 1
        drainBackgroundHandlers()
      }
    }
  }

  private func drainBackgroundHandlers() {
    guard finishedEvents, pendingPersistence == 0, !backgroundHandlers.isEmpty else { return }
    let handlers = backgroundHandlers
    backgroundHandlers.removeAll()
    finishedEvents = false
    for handler in handlers { handler() }
  }
}

extension BackgroundTransferCoordinator: URLSessionTaskDelegate, URLSessionDelegate {
  nonisolated func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    // A signed form and its bytes may only go to the server-authorized URL.
    completionHandler(nil)
  }

  nonisolated func urlSession(
    _ session: URLSession, task: URLSessionTask,
    didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64
  ) {
    guard let context = Self.context(task) else { return }
    let progress = TransferProgressSnapshot(
      completedBytes: max(totalBytesSent, 0),
      totalBytes: totalBytesExpectedToSend > 0 ? totalBytesExpectedToSend : nil)
    MainActor.assumeIsolated { self.onProgress?(context, progress) }
  }

  nonisolated func urlSession(
    _ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?
  ) {
    guard let context = Self.context(task) else { return }
    let status = (task.response as? HTTPURLResponse)?.statusCode
    let completion = TransferCompletion(
      context: context, statusCode: status,
      succeeded: error == nil && status.map { (200...299).contains($0) } == true)
    MainActor.assumeIsolated { self.receiveCompletion(completion) }
  }

  nonisolated func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    MainActor.assumeIsolated {
      self.finishedEvents = true
      self.drainBackgroundHandlers()
    }
  }
}
