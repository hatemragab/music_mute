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
  var terminal: Bool { ["submitted", "failed"].contains(status) }
}

/// One durable import per account. Ambiguous writes keep their original request ID.
@MainActor final class URLImportsModel: ObservableObject {
  @Published private(set) var record: URLImportRecord?
  @Published private(set) var messageKey: String?
  @Published private(set) var busy = false
  private let api: JobsAPI
  private let store: ProcessingStore
  @Published private(set) var owner: String?
  private var epoch: UInt64 = 0
  private var task: Task<Void, Never>?
  private var active = true
  var onSubmitted: (String) async -> Void = { _ in }

  init(api: JobsAPI, store: ProcessingStore) {
    self.api = api
    self.store = store
  }

  func bindOwner(_ uid: String?) async {
    epoch &+= 1
    let ticket = epoch
    task?.cancel()
    task = nil
    owner = uid
    record = nil
    messageKey = nil
    busy = false
    guard let uid else { return }
    do {
      let saved = try await store.urlImport(ownerUid: uid)
      guard ticket == epoch else { return }
      record = saved
      resume()
    } catch {
      if ticket == epoch { messageKey = "processing_error_storage" }
    }
  }

  func submit(_ raw: String, trimEnabled: Bool = true) async {
    guard !busy, record == nil || record?.terminal == true, let uid = owner else { return }
    let ticket = epoch
    do {
      let url = try SupportedAudioSites.canonical(raw)
      let pending = URLImportRecord(url: url, requestId: UUID(), trimEnabled: trimEnabled)
      busy = true
      try await store.saveURLImport(pending, ownerUid: uid)
      guard ticket == epoch else { return }
      record = pending
      messageKey = nil
      busy = false
      resume()
    } catch {
      guard ticket == epoch else { return }
      busy = false
      messageKey = (error as? URLImportFailure)?.messageKey ?? processingErrorKey(error)
    }
  }

  func restore() async {
    active = true
    await bindOwner(owner)
  }

  func pause() {
    active = false
    task?.cancel()
    task = nil
    busy = false
    epoch &+= 1
  }

  func resume() {
    guard active, task == nil, let uid = owner, let record, !record.terminal else { return }
    let ticket = epoch
    busy = true
    task = Task { [weak self] in
      guard let self else { return }
      defer {
        if ticket == self.epoch {
          self.task = nil
          self.busy = false
        }
      }
      while !Task.isCancelled, ticket == self.epoch, var current = self.record, !current.terminal {
        do {
          let view: URLImportView
          if let id = current.importId {
            view = try await self.api.urlImport(id: id)
          } else {
            view = try await self.api.createURLImport(
              url: current.url, requestId: current.requestId, trimEnabled: current.trimEnabled)
          }
          try Task.checkCancellation()
          guard ticket == self.epoch else { return }
          current.importId = view.importId
          current.status = view.status
          current.jobId = view.jobId
          current.messageKey = view.error.map { URLImportFailure.server($0.code).messageKey }
          try await self.store.saveURLImport(current, ownerUid: uid)
          guard ticket == self.epoch else { return }
          self.record = current
          self.messageKey = nil
          if let job = current.jobId, current.status == "submitted" {
            await self.onSubmitted(job)
            return
          }
          if current.terminal { return }
          try await Task.sleep(for: .seconds(3))
        } catch is CancellationError { return } catch {
          guard ticket == self.epoch, !Task.isCancelled else { return }
          self.messageKey = (error as? URLImportFailure)?.messageKey ?? processingErrorKey(error)
          if let failure = error as? URLImportFailure {
            let retryable: Bool
            switch failure {
            case .server(let code):
              retryable = ["IMPORT_QUEUE_FULL", "IMPORT_DISABLED"].contains(code)
            default: retryable = false
            }
            if !retryable {
              current.status = "failed"
              current.messageKey = failure.messageKey
              do {
                try await self.store.saveURLImport(current, ownerUid: uid)
                guard ticket == self.epoch else { return }
                self.record = current
              } catch {
                if ticket == self.epoch { self.messageKey = "processing_error_storage" }
              }
            }
          }
          // Explicit retry avoids a hot loop for permanent errors and honors HTTP cooldowns.
          return
        }
      }
    }
  }
}
