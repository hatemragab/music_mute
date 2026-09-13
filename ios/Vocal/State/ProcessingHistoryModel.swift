import Foundation

func shouldPollProcessingJob(_ status: String) -> Bool {
  [
    "awaiting_upload", "queued", "validating", "processing", "uploading_result", "interrupted",
    "cancel_requested",
  ].contains(status)
}

func processingStatusKey(_ status: String) -> String {
  let known = [
    "awaiting_upload", "queued", "validating", "processing", "uploading_result",
    "interrupted", "cancel_requested", "ready", "failed", "cancelled",
  ]
  return known.contains(status) ? "processing_\(status)" : "processing_unknown"
}

func processingErrorKey(_ error: Error) -> String {
  if let key = ProcessingMediaMessage.key(error) { return key }
  if let artifact = error as? JobArtifactFailure {
    switch artifact {
    case .storage: return "processing_error_storage"
    case .unavailable: return "processing_error_state"
    case .invalidOutput: return "processing_error_service"
    }
  }
  if let auth = error as? AuthFailure {
    switch auth {
    case .offline: return "processing_error_offline"
    case .sessionExpired, .recentLoginRequired, .invalidCredentials: return "processing_error_auth"
    case .accountDisabled, .profileSyncRequired, .deviceConflict: return "processing_error_policy"
    case .rateLimited: return "processing_error_rate"
    default: return "processing_error_service"
    }
  }
  if let failure = error as? JobsFailure {
    switch failure {
    case .invalidInput: return "processing_error_input"
    case .installationRequired, .forbidden: return "processing_error_policy"
    case .notFound: return "processing_error_missing"
    case .conflict(let code):
      return code == "NEW_INPUT_REQUIRED"
        ? "processing_error_retry_input" : "processing_error_state"
    case .rateLimited: return "processing_error_rate"
    default: return "processing_error_service"
    }
  }
  if error is URLError { return "processing_error_offline" }
  if let input = error as? AudioInputPreparationError {
    return [.storage, .accessDenied, .unreadable].contains(input)
      ? "processing_error_storage" : "processing_error_input"
  }
  return "processing_error_service"
}

@MainActor final class ProcessingHistoryModel: ObservableObject {
  @Published private(set) var jobs: [Job] = []
  @Published private(set) var nextCursor: String?
  @Published private(set) var detail: Job?
  @Published private(set) var selectedId: String?
  @Published private(set) var loading = false
  @Published private(set) var loadingMore = false
  @Published private(set) var messageKey: String?
  private let api: any JobsAPI
  private let loadCached: (String) async throws -> [Job]
  private let saveCached: (String, [Job]) async throws -> Void
  private var owner: String?
  private var epoch: UInt64 = 0
  private var pageVersion: UInt64 = 0
  private var detailVersion: UInt64 = 0
  private var polling: Task<Void, Never>?
  private var visible = false
  private var retryDelay: TimeInterval = 10
  var onJobsChanged: @MainActor ([Job]) async -> Void = { _ in }
  var onJobMissing: @MainActor (String) async -> Void = { _ in }
  var onFailure: @MainActor (String?, Error) async -> Void = { _, _ in }

  init(
    api: any JobsAPI,
    loadCached: @escaping (String) async throws -> [Job] = { _ in [] },
    saveCached: @escaping (String, [Job]) async throws -> Void = { _, _ in }
  ) {
    self.api = api
    self.loadCached = loadCached
    self.saveCached = saveCached
  }

  func bindOwner(_ uid: String?) async {
    guard uid != owner else { return }
    polling?.cancel()
    polling = nil
    owner = uid
    epoch &+= 1
    pageVersion &+= 1
    detailVersion &+= 1
    jobs = []
    nextCursor = nil
    detail = nil
    selectedId = nil
    loading = false
    loadingMore = false
    messageKey = nil
    guard let uid else { return }
    let ticket = epoch
    let version = pageVersion
    defer {
      if ticket == epoch, visible, polling == nil { setVisible(true) }
    }
    do {
      let cached = try await loadCached(uid)
      guard ticket == epoch, version == pageVersion else { return }
      jobs = cached
      await onJobsChanged(jobs)
    } catch {
      if ticket == epoch { messageKey = "processing_error_storage" }
    }
  }

  func refresh() async {
    guard let uid = owner else { return }
    let ticket = epoch
    pageVersion &+= 1
    let version = pageVersion
    loading = true
    loadingMore = false
    messageKey = nil
    defer { if ticket == epoch, version == pageVersion { loading = false } }
    do {
      let page = try await api.list(cursor: nil, status: nil)
      guard !Task.isCancelled, ticket == epoch, version == pageVersion else { return }
      jobs = deduplicated(page.items)
      nextCursor = page.nextCursor
      retryDelay = 10
      try await saveCached(uid, jobs)
      await onJobsChanged(jobs)
      if ticket == epoch, let id = selectedId { await select(id) }
    } catch is CancellationError {} catch {
      if ticket == epoch, version == pageVersion { await report(error) }
    }
  }

  func loadMore() async {
    guard let uid = owner, let cursor = nextCursor, !loading, !loadingMore else { return }
    let ticket = epoch
    let version = pageVersion
    loadingMore = true
    defer { if ticket == epoch, version == pageVersion { loadingMore = false } }
    do {
      let page = try await api.list(cursor: cursor, status: nil)
      guard !Task.isCancelled, ticket == epoch, version == pageVersion else { return }
      jobs = deduplicated(jobs + page.items)
      nextCursor = page.nextCursor
      try await saveCached(uid, jobs)
      await onJobsChanged(jobs)
    } catch is CancellationError {} catch {
      if ticket == epoch, version == pageVersion { await report(error) }
    }
  }

  func select(_ id: String?) async {
    detailVersion &+= 1
    let version = detailVersion
    let ticket = epoch
    selectedId = id
    if detail?.id != id { detail = nil }
    guard let id, owner != nil else { return }
    do {
      let value = try await api.detail(id: id)
      guard !Task.isCancelled, ticket == epoch, version == detailVersion else { return }
      detail = value
      jobs = jobs.map { $0.id == id ? value : $0 }
      await onJobsChanged(jobs)
    } catch is CancellationError {} catch {
      guard ticket == epoch, version == detailVersion else { return }
      if (error as? JobsFailure) == .notFound {
        detail = nil
        jobs.removeAll { $0.id == id }
        if let owner { try? await saveCached(owner, jobs) }
        await onJobsChanged(jobs)
        await onJobMissing(id)
      }
      await report(error)
    }
  }

  func setVisible(_ visible: Bool) {
    self.visible = visible
    polling?.cancel()
    polling = nil
    guard visible, owner != nil else { return }
    polling = Task { [weak self] in
      await self?.refresh()
      while !Task.isCancelled {
        let seconds = self?.retryDelay ?? 10
        do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
        guard let self else { return }
        if self.messageKey != nil
          || self.jobs.contains(where: { shouldPollProcessingJob($0.status) })
          || self.detail.map({ shouldPollProcessingJob($0.status) }) == true
        {
          await self.refresh()
        }
      }
    }
  }

  private func report(_ error: Error) async {
    messageKey = processingErrorKey(error)
    if case JobsFailure.rateLimited(let seconds) = error {
      retryDelay = max(10, seconds)
    } else {
      retryDelay = min(60, retryDelay * 2)
    }
    await onFailure(selectedId, error)
  }

  private func deduplicated(_ values: [Job]) -> [Job] {
    var seen = Set<String>()
    return values.filter { seen.insert($0.id).inserted }
  }

  deinit { polling?.cancel() }
}
