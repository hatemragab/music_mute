import Foundation

struct URLImportView: Decodable, Sendable {
  struct Failure: Decodable, Sendable { let code: String }
  let importId: String
  let status: String
  let jobId: String?
  let error: Failure?

  func validated() throws -> Self {
    let idPattern = #"^[a-f0-9]{24}$"#
    guard importId.range(of: idPattern, options: .regularExpression) != nil,
      ["queued", "downloading", "validating", "uploading", "submitted", "failed"].contains(status),
      jobId == nil || jobId!.range(of: idPattern, options: .regularExpression) != nil,
      status != "submitted" || jobId != nil
    else { throw JobsFailure.malformedResponse }
    return self
  }
}

struct URLImportRecord: Codable, Equatable, Sendable {
  let url: String
  let requestId: UUID
  var trimEnabled: Bool? = nil
  var importId: String?
  var status = "pending"
  var jobId: String?
  var messageKey: String?
  var failedAt: Date? = nil
  var terminal: Bool { ["submitted", "failed"].contains(status) }
}

/// Account-scoped durable imports. Ambiguous writes retain their original request IDs.
@MainActor final class URLImportsModel: ObservableObject {
  @Published private(set) var records: [URLImportRecord] = []
  var record: URLImportRecord? { records.last }
  @Published private(set) var messageKey: String?
  @Published private(set) var busy = false
  @Published private(set) var submitting = false
  @Published private(set) var owner: String?
  private let api: JobsAPI
  private let store: ProcessingStore
  private var epoch: UInt64 = 0
  private var tasks: [UUID: Task<Void, Never>] = [:]
  private var suspended = Set<UUID>()
  private var active = true
  var onSubmitted: (String) async -> Void = { _ in }

  init(api: JobsAPI, store: ProcessingStore) {
    self.api = api
    self.store = store
  }

  func bindOwner(_ uid: String?) async {
    epoch &+= 1
    let ticket = epoch
    for task in tasks.values { task.cancel() }
    tasks.removeAll()
    suspended.removeAll()
    owner = uid
    records = []
    messageKey = nil
    busy = false
    submitting = false
    guard let uid else { return }
    do {
      let saved = try await store.urlImports(ownerUid: uid)
      guard ticket == epoch else { return }
      records = saved
      resume()
    } catch {
      if ticket == epoch { messageKey = "processing_error_storage" }
    }
  }

  func submit(_ raw: String, trimEnabled: Bool = true) async {
    guard !submitting, let uid = owner else { return }
    let ticket = epoch
    do {
      let url = try SupportedAudioSites.canonical(raw)
      let pending = URLImportRecord(url: url, requestId: UUID(), trimEnabled: trimEnabled)
      submitting = true
      defer { if ticket == epoch { submitting = false } }
      try await store.saveURLImport(pending, ownerUid: uid)
      guard ticket == epoch else { return }
      records.append(pending)
      messageKey = nil
      startPending()
    } catch {
      guard ticket == epoch else { return }
      messageKey = (error as? URLImportFailure)?.messageKey ?? processingErrorKey(error)
    }
  }

  func restore() async {
    active = true
    await bindOwner(owner)
  }

  func removeFailedImport(requestId: UUID? = nil) async {
    guard let uid = owner,
      let current = records.first(where: { $0.requestId == (requestId ?? record?.requestId) }),
      current.status == "failed", current.jobId == nil
    else { return }
    let ticket = epoch
    do {
      try await store.removeFailedURLImport(requestId: current.requestId, ownerUid: uid)
      guard ticket == epoch else { return }
      records.removeAll { $0.requestId == current.requestId }
      messageKey = nil
    } catch { if ticket == epoch { messageKey = "processing_error_storage" } }
  }

  func pause() {
    active = false
    epoch &+= 1
    for task in tasks.values { task.cancel() }
    tasks.removeAll()
    busy = false
    submitting = false
  }

  func isTracking(_ requestId: UUID) -> Bool { tasks[requestId] != nil }

  func resume(requestId: UUID? = nil) {
    if let requestId { suspended.remove(requestId) } else { suspended.removeAll() }
    startPending()
  }

  private func startPending() {
    guard active, let uid = owner else { return }
    // Leave capacity on the shared socket for history, usage and job details.
    for current in records where !current.terminal && !suspended.contains(current.requestId) {
      guard tasks.count < 100 else { break }
      let id = current.requestId
      guard tasks[id] == nil else { continue }
      let ticket = epoch
      tasks[id] = Task { [weak self] in
        guard let self else { return }
        defer {
          if ticket == self.epoch {
            self.tasks[id] = nil
            self.busy = !self.tasks.isEmpty
            self.startPending()
          }
        }
        do {
          var value = current
          if value.importId == nil {
            let view = try await self.api.createURLImport(
              url: value.url, requestId: value.requestId, trimEnabled: value.trimEnabled)
            value = try await self.save(view, record: value, owner: uid, ticket: ticket)
          }
          guard !value.terminal, let importId = value.importId else { return }
          if let realtime = self.api.realtime {
            for try await data in realtime.watch("import", params: ["id": importId]) {
              let view = try JSONDecoder.authDecoder().decode(URLImportView.self, from: data)
                .validated()
              value = try await self.save(view, record: value, owner: uid, ticket: ticket)
              if value.terminal { return }
            }
          } else {
            // Fixture/explicit-read clients get one snapshot, never status polling.
            let view = try await self.api.urlImport(id: importId)
            _ = try await self.save(view, record: value, owner: uid, ticket: ticket)
          }
          self.suspended.insert(id)
        } catch is CancellationError {
          return
        } catch {
          guard ticket == self.epoch, !Task.isCancelled else { return }
          self.suspended.insert(id)
          let key = (error as? URLImportFailure)?.messageKey ?? processingErrorKey(error)
          self.messageKey = key
          guard let index = self.records.firstIndex(where: { $0.requestId == id }) else { return }
          var failed = self.records[index]
          failed.messageKey = key
          if let failure = error as? URLImportFailure, case .server(let code) = failure,
            !["IMPORT_QUEUE_FULL", "IMPORT_DISABLED"].contains(code)
          {
            failed.status = "failed"
          }
          do {
            try await self.store.saveURLImport(failed, ownerUid: uid)
            guard ticket == self.epoch,
              let latest = self.records.firstIndex(where: { $0.requestId == id })
            else { return }
            self.records[latest] = failed
          } catch {
            if ticket == self.epoch { self.messageKey = "processing_error_storage" }
          }
        }
      }
    }
    busy = !tasks.isEmpty
  }

  private func save(
    _ view: URLImportView, record: URLImportRecord, owner uid: String, ticket: UInt64
  )
    async throws -> URLImportRecord
  {
    try Task.checkCancellation()
    guard ticket == epoch, owner == uid else { throw CancellationError() }
    let view = try view.validated()
    guard record.importId == nil || record.importId == view.importId else {
      throw JobsFailure.malformedResponse
    }
    var saved = record
    saved.importId = view.importId
    saved.status = view.status
    saved.jobId = view.jobId
    saved.messageKey = view.error.map { URLImportFailure.server($0.code).messageKey }
    try await store.saveURLImport(saved, ownerUid: uid)
    guard ticket == epoch, !Task.isCancelled,
      let index = records.firstIndex(where: { $0.requestId == saved.requestId })
    else { throw CancellationError() }
    records[index] = saved
    messageKey = nil
    if let job = saved.jobId, saved.status == "submitted" { await onSubmitted(job) }
    return saved
  }
}
