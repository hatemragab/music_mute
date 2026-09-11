import CryptoKit
import Foundation

/// A bounded owner-scoped queue. It persists only the typed diagnostic schema; raw errors are never
/// written to disk or sent to the API.
actor ClientErrorOutbox {
  private struct Snapshot: Codable {
    let version: Int
    let ownerUid: String
    var events: [ClientErrorEvent]
  }

  private let root: URL
  private let capacity: Int
  private var flushing = Set<String>()

  init(root: URL, capacity: Int = 50) {
    self.root = root.standardizedFileURL.resolvingSymlinksInPath()
    self.capacity = max(1, capacity)
  }

  private var purgedOwners = Set<String>()
  func purge(ownerUid: String) throws {
    purgedOwners.insert(ownerUid)
    let file = fileURL(ownerUid)
    if FileManager.default.fileExists(atPath: file.path) {
      try FileManager.default.removeItem(at: file)
    }
  }

  func enqueue(_ event: ClientErrorEvent, ownerUid: String) throws {
    guard !purgedOwners.contains(ownerUid), !ownerUid.isEmpty, Self.valid(event) else {
      throw ProcessingStoreFailure.corruptStore
    }
    var snapshot = try load(ownerUid)
    guard !snapshot.events.contains(where: { $0.eventId == event.eventId }) else { return }
    snapshot.events.append(event)
    if snapshot.events.count > capacity {
      snapshot.events.removeFirst(snapshot.events.count - capacity)
    }
    try persist(snapshot)
  }

  func pending(ownerUid: String) throws -> [ClientErrorEvent] { try load(ownerUid).events }

  func flush(
    fence: SessionFence, api: JobsAPI,
    currentSession: @escaping @MainActor @Sendable () -> SessionFence?
  ) async {
    guard !flushing.contains(fence.uid) else { return }
    flushing.insert(fence.uid)
    defer { flushing.remove(fence.uid) }
    while await currentSession() == fence {
      guard let snapshot = try? load(fence.uid), let first = snapshot.events.first else { return }
      do {
        guard
          let receipt = try await Self.reportIfCurrent(
            first, fence: fence, api: api, currentSession: currentSession)
        else { return }
        guard await currentSession() == fence,
          receipt.eventId.lowercased() == first.eventId.uuidString.lowercased()
        else { return }
        var current = try load(fence.uid)
        current.events.removeAll { $0.eventId == first.eventId }
        try persist(current)
      } catch {
        return
      }
    }
  }

  @MainActor private static func reportIfCurrent(
    _ event: ClientErrorEvent, fence: SessionFence, api: JobsAPI,
    currentSession: @escaping @MainActor @Sendable () -> SessionFence?
  ) async throws -> ClientErrorReceipt? {
    guard currentSession() == fence else { return nil }
    return try await api.report(event, ownerUid: fence.uid)
  }

  static func makeEvent(
    operationId: UUID, jobId: String?, stage: ClientErrorStage, error: Error,
    appVersion: String, osVersion: String, occurredAt: Date = Date(), eventId: UUID = UUID()
  ) -> ClientErrorEvent {
    let code: ClientErrorCode
    let retryable: Bool
    let status: Int?
    if let url = error as? URLError {
      code = url.code == .timedOut ? .timeout : .network
      retryable = true
      status = nil
    } else if let auth = error as? AuthFailure {
      code = .authentication
      retryable = auth == .offline
      status = nil
    } else if error is AudioInputPreparationError {
      code = .invalidMedia
      retryable = false
      status = nil
    } else if error is ProcessingStoreFailure || error is JobArtifactFailure {
      code = .storage
      retryable = false
      status = nil
    } else if let jobs = error as? JobsFailure {
      switch jobs {
      case .notFound: code = .jobNotFound
      case .conflict: code = .jobConflict
      default: code = .server
      }
      if case .rateLimited = jobs { status = 429 } else { status = nil }
      retryable = jobs == .serviceUnavailable || status == 429
    } else {
      code = .unknown
      retryable = false
      status = nil
    }
    return ClientErrorEvent(
      eventId: eventId, operationId: operationId, jobId: jobId, stage: stage, code: code,
      retryable: retryable, platform: .ios, appVersion: Self.printable(appVersion, limit: 32),
      osVersion: Self.printable(osVersion, limit: 64), occurredAt: occurredAt, httpStatus: status)
  }

  private func load(_ ownerUid: String) throws -> Snapshot {
    let file = fileURL(ownerUid)
    guard FileManager.default.fileExists(atPath: file.path) else {
      return Snapshot(version: 1, ownerUid: ownerUid, events: [])
    }
    do {
      let snapshot = try JSONDecoder().decode(Snapshot.self, from: Data(contentsOf: file))
      guard snapshot.version == 1, snapshot.ownerUid == ownerUid,
        snapshot.events.count <= capacity, snapshot.events.allSatisfy(Self.valid)
      else { throw ProcessingStoreFailure.corruptStore }
      return snapshot
    } catch let failure as ProcessingStoreFailure {
      throw failure
    } catch {
      throw ProcessingStoreFailure.corruptStore
    }
  }

  private func persist(_ snapshot: Snapshot) throws {
    guard !purgedOwners.contains(snapshot.ownerUid) else { return }
    do {
      try FileManager.default.createDirectory(
        at: root, withIntermediateDirectories: true,
        attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
      var excluded = root
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try excluded.setResourceValues(values)
      let data = try JSONEncoder().encode(snapshot)
      let file = fileURL(snapshot.ownerUid)
      try data.write(
        to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    } catch {
      throw ProcessingStoreFailure.storage
    }
  }

  private func fileURL(_ ownerUid: String) -> URL {
    root.appendingPathComponent(ProcessingStore.ownerDirectoryName(ownerUid) + ".json")
  }

  private static func valid(_ event: ClientErrorEvent) -> Bool {
    event.appVersion.utf8.count <= 32 && !event.appVersion.isEmpty
      && event.osVersion.utf8.count <= 64 && !event.osVersion.isEmpty
      && (event.jobId == nil
        || event.jobId!.range(of: "^[0-9a-fA-F]{24}$", options: .regularExpression) != nil)
      && (event.httpStatus == nil || (100...599).contains(event.httpStatus!))
  }

  private static func printable(_ raw: String, limit: Int) -> String {
    let value = raw.unicodeScalars.filter { $0.properties.generalCategory != .control }
    let result = String(String.UnicodeScalarView(value).prefix(limit))
    return result.isEmpty ? "unknown" : result
  }
}
