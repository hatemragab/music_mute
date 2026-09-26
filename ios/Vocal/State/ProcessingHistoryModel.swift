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
  @Published private(set) var connection: RealtimeState = .paused
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
  private var liveDetail: Task<Void, Never>?
  private var liveTasks: [String: Task<Void, Never>] = [:]
  private var livePages: [String: JobPage] = [:]
  private var liveCursors: [String] = []
  private var visible = false
  private var retryDelay: TimeInterval = 10
  private let now: () -> TimeInterval
  private var retryNotBefore: TimeInterval = 0
  private var lastRefreshAt: TimeInterval?
  private var lastSuccessfulRefreshAt: TimeInterval?
  private var reading = false
  private var freshIds: Set<String> = []
  private var refreshPending = false
  var onJobsChanged: @MainActor ([Job]) async -> Void = { _ in }
  var onJobMissing: @MainActor (String) async -> Void = { _ in }
  var onFailure: @MainActor (String?, Error) async -> Void = { _, _ in }

  init(
    api: any JobsAPI,
    loadCached: @escaping (String) async throws -> [Job] = { _ in [] },
    saveCached: @escaping (String, [Job]) async throws -> Void = { _, _ in },
    now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
  ) {
    self.api = api
    self.loadCached = loadCached
    self.saveCached = saveCached
    self.now = now
  }

  func bindOwner(_ uid: String?) async {
    guard uid != owner else { return }
    polling?.cancel()
    polling = nil
    liveDetail?.cancel()
    liveDetail = nil
    for task in liveTasks.values { task.cancel() }
    liveTasks.removeAll()
    livePages.removeAll()
    liveCursors.removeAll()
    api.realtime?.bindOwner(uid)
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
    reading = false
    retryDelay = 10
    retryNotBefore = 0
    lastRefreshAt = nil
    lastSuccessfulRefreshAt = nil
    freshIds = []
    refreshPending = false
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
    if let realtime = api.realtime {
      if visible { startLive() }
      realtime.resync()
      return
    }
    guard let uid = owner, !reading, now() >= retryNotBefore else { return }
    refreshPending = false
    reading = true
    let ticket = epoch
    pageVersion &+= 1
    let version = pageVersion
    loading = true
    loadingMore = false
    messageKey = nil
    defer {
      if ticket == epoch, version == pageVersion {
        loading = false
        finishReading(ticket)
      }
    }
    do {
      if let lastRefreshAt {
        try await Task.sleep(for: .seconds(max(0, lastRefreshAt + 1 - now())))
      }
      guard ticket == epoch, now() >= retryNotBefore else { return }
      lastRefreshAt = now()
      let page = try await api.list(cursor: nil, status: nil)
      guard !Task.isCancelled, ticket == epoch, version == pageVersion else { return }
      jobs = deduplicated(page.items)
      lastSuccessfulRefreshAt = now()
      freshIds = Set(jobs.map(\.id))
      nextCursor = page.nextCursor
      retryDelay = 10
      retryNotBefore = 0
      try await saveCached(uid, jobs)
      await onJobsChanged(jobs)
      guard ticket == epoch else { return }
      reading = false
      if ticket == epoch, let id = selectedId { await select(id) }
    } catch is CancellationError {} catch {
      if ticket == epoch, version == pageVersion { await report(error) }
    }
  }

  func loadMore() async {
    guard let uid = owner, let cursor = nextCursor, !reading, now() >= retryNotBefore else {
      return
    }
    if api.realtime != nil {
      watchPage(cursor)
      return
    }
    reading = true
    let ticket = epoch
    let version = pageVersion
    loadingMore = true
    defer {
      if ticket == epoch, version == pageVersion {
        loadingMore = false
        finishReading(ticket)
      }
    }
    do {
      let page = try await api.list(cursor: cursor, status: nil)
      guard !Task.isCancelled, ticket == epoch, version == pageVersion else { return }
      jobs = deduplicated(jobs + page.items)
      nextCursor = page.nextCursor
      try await saveCached(uid, jobs)
      await onJobsChanged(jobs)
      guard ticket == epoch else { return }
      reading = false
      if let selectedId { await select(selectedId) }
    } catch is CancellationError {} catch {
      if ticket == epoch, version == pageVersion { await report(error) }
    }
  }

  func select(_ id: String?) async {
    liveDetail?.cancel()
    liveDetail = nil
    if reading, id == selectedId { return }
    detailVersion &+= 1
    let version = detailVersion
    let ticket = epoch
    selectedId = id
    if detail?.id != id { detail = nil }
    guard let id, owner != nil else { return }
    if let realtime = api.realtime {
      guard visible else { return }
      liveDetail = Task { [weak self] in
        guard let self else { return }
        do {
          for try await data in realtime.watch("job", params: ["id": id]) {
            let value = try JSONDecoder.authDecoder().decode(Job.self, from: data)
            guard !Task.isCancelled, ticket == self.epoch, version == self.detailVersion else {
              return
            }
            self.detail = value
            self.jobs = self.jobs.map { $0.id == id ? value : $0 }
            self.messageKey = nil
            await self.onJobsChanged(self.jobs)
          }
        } catch is CancellationError {} catch {
          guard ticket == self.epoch, version == self.detailVersion else { return }
          if (error as? JobsFailure) == .notFound {
            self.detail = nil
            self.jobs.removeAll { $0.id == id }
            if let owner = self.owner { try? await self.saveCached(owner, self.jobs) }
            await self.onJobsChanged(self.jobs)
            await self.onJobMissing(id)
          }
          await self.report(error)
        }
      }
      return
    }
    if freshIds.contains(id), let value = jobs.first(where: { $0.id == id }),
      value.workerAvailable != nil || ["ready", "failed", "cancelled"].contains(value.status),
      let lastSuccessfulRefreshAt, now() - lastSuccessfulRefreshAt < 10
    {
      detail = value
      return
    }
    guard !reading, now() >= retryNotBefore else { return }
    reading = true
    defer {
      if ticket == epoch {
        finishReading(ticket)
        if let selectedId, selectedId != id {
          Task {
            guard ticket == self.epoch else { return }
            await self.select(selectedId)
          }
        }
      }
    }
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
    if self.visible == visible, !visible || polling != nil { return }
    self.visible = visible
    polling?.cancel()
    polling = nil
    api.realtime?.setForeground(visible)
    if !visible {
      liveDetail?.cancel()
      liveDetail = nil
      for task in liveTasks.values { task.cancel() }
      liveTasks.removeAll()
      livePages.removeAll()
      liveCursors.removeAll()
      return
    }
    guard owner != nil else { return }
    if api.realtime != nil {
      startLive()
      return
    }
    polling = Task { [weak self] in await self?.refreshAfterChange() }
  }

  private func startLive() {
    guard visible, owner != nil, let realtime = api.realtime else { return }
    if polling == nil {
      polling = Task { [weak self] in
        for await state in realtime.$state.values {
          guard let self, !Task.isCancelled else { return }
          self.connection = state
          if state == .signedOut {
            self.jobs = []
            self.detail = nil
            self.messageKey = "processing_error_auth"
          }
        }
      }
    }
    if liveTasks.isEmpty || (livePages[""] != nil && liveTasks[""] == nil) { watchPage(nil) }
    if let selectedId, liveDetail == nil { Task { await self.select(selectedId) } }
  }

  private func watchPage(_ cursor: String?) {
    guard let owner, let realtime = api.realtime else { return }
    let key = cursor ?? ""
    guard liveTasks[key] == nil else { return }
    if liveTasks.count >= 10, let oldest = liveCursors.first {
      liveTasks.removeValue(forKey: oldest)?.cancel()
      livePages.removeValue(forKey: oldest)
      liveCursors.removeFirst()
    }
    if cursor == nil { pageVersion &+= 1 }
    let ticket = epoch
    if !liveCursors.contains(key) { liveCursors.append(key) }
    loading = cursor == nil && jobs.isEmpty
    loadingMore = cursor != nil
    liveTasks[key] = Task { [weak self] in
      guard let self else { return }
      do {
        var params = ["limit": "20"]
        if let cursor { params["cursor"] = cursor }
        for try await data in realtime.watch("jobs", params: params) {
          let page = try JSONDecoder.authDecoder().decode(JobPage.self, from: data)
          guard !Task.isCancelled, ticket == self.epoch else { return }
          if let prior = self.livePages[key], prior.nextCursor != page.nextCursor,
            let index = self.liveCursors.firstIndex(of: key)
          {
            for later in self.liveCursors.dropFirst(index + 1) {
              self.liveTasks.removeValue(forKey: later)?.cancel()
              self.livePages.removeValue(forKey: later)
            }
            self.liveCursors = Array(self.liveCursors.prefix(index + 1))
          }
          self.livePages[key] = page
          self.jobs = self.deduplicated(
            self.liveCursors.flatMap { self.livePages[$0]?.items ?? [] })
          self.nextCursor =
            self.liveCursors.last.flatMap { self.livePages[$0]?.nextCursor }
          self.loading = false
          self.loadingMore = false
          self.messageKey = nil
          try await self.saveCached(owner, self.jobs)
          await self.onJobsChanged(self.jobs)
        }
      } catch is CancellationError {} catch {
        guard ticket == self.epoch else { return }
        self.liveTasks.removeValue(forKey: key)
        self.loading = false
        self.loadingMore = false
        await self.report(error)
      }
    }
  }

  private func report(_ error: Error) async {
    messageKey = processingErrorKey(error)
    if case JobsFailure.rateLimited(let seconds) = error {
      retryDelay = max(10, seconds)
      retryNotBefore = max(retryNotBefore, now() + seconds)
    } else {
      retryDelay = min(60, retryDelay * 2)
    }
    await onFailure(selectedId, error)
  }

  func refreshAfterChange() async {
    refreshPending = true
    await refresh()
  }

  private func finishReading(_ ticket: UInt64) {
    guard ticket == epoch else { return }
    reading = false
    if refreshPending, now() >= retryNotBefore, visible || !Task.isCancelled {
      Task {
        guard ticket == self.epoch else { return }
        await self.refresh()
      }
    }
  }

  private func deduplicated(_ values: [Job]) -> [Job] {
    var seen = Set<String>()
    return values.filter { seen.insert($0.id).inserted }
  }

  deinit {
    polling?.cancel()
    liveDetail?.cancel()
    for task in liveTasks.values { task.cancel() }
  }
}
