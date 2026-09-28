import CryptoKit
import Foundation

enum PlaybackRepeatMode: String, CaseIterable {
  case off, all, one
}

@MainActor final class ProcessingModel: ObservableObject {
  @Published private(set) var photoSourceLimit = ProcessingMediaPolicy.standard.maxSourceBytes!
  @Published private(set) var preparing = false
  @Published private(set) var busy = false
  @Published private(set) var pendingInputName: String?
  @Published private(set) var messageKey: String?
  @Published var selectedJobID: String?
  @Published var selectedOperationID: UUID?
  @Published private(set) var sessionReady = false
  @Published private(set) var libraryJobs: [Job] = []
  @Published private(set) var playbackQueue: [Job] = []
  @Published private(set) var currentPlaybackJobID: String?
  @Published var shufflePlayback = false
  @Published var repeatPlayback = PlaybackRepeatMode.off
  @Published var autoPlayNext = true
  let urlImports: URLImportsModel
  let usageRepository: ProcessingUsageRepository
  private let api: JobsAPI
  let repository: ProcessingRepository
  let pipeline: AudioPipelineCoordinator
  let history: ProcessingHistoryModel
  let player: AudioPlayer
  private let preparer: AudioInputPreparer
  private let originalFile: (String, String) async throws -> URL
  private let outputFile: (String, String) async throws -> URL
  private let removeOutput: (String) async -> Void
  private let sessionDidChange: () -> Void
  private let reportFailure: AudioPipelineCoordinator.FailureReporter
  private var prepared: PreparedInput?
  private var ownerUid: String?
  private var didBind = false
  private var epoch: UInt64 = 0
  private var actions: [UUID: Task<Void, Never>] = [:]
  private var privatePlaybackID: UUID?
  private var originalPrefetch: Task<Void, Never>?
  private var sourcePickerFence: SessionFence?
  private var sourcePickerPending = false

  init(
    api: JobsAPI, repository: ProcessingRepository, preparer: AudioInputPreparer,
    pipeline: AudioPipelineCoordinator,
    player: AudioPlayer, outputFile: @escaping (String, String) async throws -> URL,
    originalFile: @escaping (String, String) async throws -> URL = { _, _ in
      throw JobArtifactFailure.unavailable
    },
    removeOutput: @escaping (String) async -> Void = { _ in },
    sessionDidChange: @escaping () -> Void = {},
    reportFailure: @escaping AudioPipelineCoordinator.FailureReporter = { _, _, _, _, _ in }
  ) {
    self.api = api
    self.urlImports = URLImportsModel(api: api, store: repository.store)
    self.usageRepository = ProcessingUsageRepository(api: api)
    self.repository = repository
    self.preparer = preparer
    self.pipeline = pipeline
    self.player = player
    self.outputFile = outputFile
    self.originalFile = originalFile
    self.removeOutput = removeOutput
    self.sessionDidChange = sessionDidChange
    self.reportFailure = reportFailure
    history = ProcessingHistoryModel(
      api: api,
      updateLibrary: { uid, jobs in
        try await repository.store.updateLibraryJobs(jobs, ownerUid: uid)
      })
    pipeline.beforePreparation = { [weak self] in
      guard let self else { throw CancellationError() }
      await self.refreshAvailability()
      try self.usageRepository.checkAvailability()
    }
    history.onJobsChanged = { [weak self, weak pipeline] jobs in
      await pipeline?.reconcile(jobs)
      guard let self else { return }
      if let session = self.repository.session {
        let tracks = (try? await self.repository.store.libraryJobs(ownerUid: session.uid)) ?? []
        guard self.repository.session == session else { return }
        self.libraryJobs = tracks
      }
      let snapshots = Dictionary(uniqueKeysWithValues: jobs.map { ($0.id, $0) })
      self.playbackQueue = self.playbackQueue.compactMap { snapshots[$0.id] ?? $0 }
      await self.usageRepository.refresh()
    }
    urlImports.onSubmitted = { [weak self] _ in
      await self?.history.refreshAfterChange()
    }
    history.onJobMissing = { [weak self] id in await self?.handleMissingJob(id) }
    history.onFailure = { [weak self] id, error in
      await self?.reportDiagnostic(error, stage: .refreshingJob, jobID: id)
    }
    player.onFinished = { [weak self] in self?.advanceAfterPlayback() }
    player.onNext = { [weak self] in self?.playNext() }
    player.onPrevious = { [weak self] in self?.playPrevious() }
  }

  func bindOwner(_ uid: String?) async {
    guard !didBind || uid != ownerUid else { return }
    didBind = true
    epoch &+= 1
    let ticket = epoch
    ownerUid = uid
    usageRepository.bind(uid)
    photoSourceLimit = ProcessingMediaPolicy.standard.maxSourceBytes!
    await preparer.configure(policy: .standard)
    sessionReady = false
    originalPrefetch?.cancel()
    originalPrefetch = nil
    for action in actions.values { action.cancel() }
    actions.removeAll()
    prepared = nil
    pendingInputName = nil
    sourcePickerFence = nil
    messageKey = nil
    selectedJobID = nil
    selectedOperationID = nil
    busy = false
    preparing = false
    playbackQueue = []
    libraryJobs = []
    currentPlaybackJobID = nil
    if let id = privatePlaybackID, player.currentID == id { player.stopAndClear() }
    privatePlaybackID = nil
    await urlImports.bindOwner(nil)
    await history.bindOwner(nil)
    await repository.setSession(uid: uid)
    guard ticket == epoch else { return }
    await pipeline.bind(repository.session)
    guard ticket == epoch else { return }
    await repository.resumePendingMutations()
    guard ticket == epoch else { return }
    sessionDidChange()
    if let uid {
      let tracks = (try? await repository.store.libraryJobs(ownerUid: uid)) ?? []
      guard ticket == epoch else { return }
      libraryJobs = tracks
    }
    await history.bindOwner(uid)
    guard ticket == epoch, uid != nil else { return }
    await urlImports.bindOwner(uid)
    guard ticket == epoch else { return }
    sessionReady = true
    await refreshAvailability()
  }

  func refreshAvailability() async {
    guard let captured = repository.session else { return }
    await usageRepository.refresh()
    do {
      let response = try await api.processingPolicy()
      let policy = try response.validated()
      guard repository.session == captured else { return }
      let effective = response.acceptNewJobs ? policy : .standard
      photoSourceLimit = effective.maxSourceBytes ?? ProcessingMediaPolicy.standard.maxSourceBytes!
      await preparer.configure(policy: effective)
    } catch {
      guard repository.session == captured else { return }
      photoSourceLimit = ProcessingMediaPolicy.standard.maxSourceBytes!
      await preparer.configure(policy: .standard)
    }
  }

  func resumePending() async {
    await urlImports.restore()
    guard let fence = repository.session else { return }
    await pipeline.bind(fence)
    await repository.resumePendingMutations()
    guard repository.session == fence else { return }
    for intent in pipeline.pipelines where !intent.phase.isTerminal {
      await pipeline.resume(intent.operationId)
    }
    await history.refreshAfterChange()
  }

  func importPhoto(_ url: URL) { importAudio(url, securityScoped: false) }

  func importAudio(_ url: URL, securityScoped: Bool = true) {
    let pickerFence = sourcePickerPending ? sourcePickerFence : repository.session
    sourcePickerPending = false
    guard let captured = pickerFence,
      captured == repository.session, captured.uid == ownerUid
    else {
      if !securityScoped { PreparedMediaCleanup.discardPhotoCopy(url) }
      return
    }
    sourcePickerFence = nil
    let ticket = epoch
    let operationID = UUID()
    Task {
      do {
        _ = try await pipeline.acceptFile(
          url, eventID: operationID, securityScoped: securityScoped, temporary: !securityScoped)
      } catch {
        guard ticket == epoch, repository.session == captured else { return }
        if (error as NSError).code != NSUserCancelledError {
          messageKey = processingErrorKey(error)
          await reportDiagnostic(
            error, stage: .sourceIntake, operationID: operationID, fence: captured)
        }
      }
    }
  }

  func submitImported() {
    guard let input = prepared else { return }
    perform(
      stage: .reservingJob, operationID: input.operationId
    ) { uid, ticket in
      guard input.ownerUid == uid else { throw CancellationError() }
      _ = try await self.repository.submit(prepared: input)
      try self.check(uid, ticket)
      self.prepared = nil
      self.pendingInputName = nil
      await self.history.refreshAfterChange()
    }
  }

  func removeMusic(from original: URL) {
    guard let captured = repository.session, captured.uid == ownerUid else { return }
    let ticket = epoch
    let operationID = UUID()
    Task {
      do {
        _ = try await pipeline.acceptFile(
          original, eventID: operationID, securityScoped: false)
      } catch {
        guard ticket == epoch, repository.session == captured else { return }
        messageKey = processingErrorKey(error)
        await reportDiagnostic(
          error, stage: .sourceIntake, operationID: operationID, fence: captured)
      }
    }
  }

  func resume(_ id: UUID) {
    Task { await pipeline.resume(id) }
  }

  func cancelOperation(_ id: UUID) {
    Task { await pipeline.cancel(id) }
  }

  func cancelSelected() {
    guard let task = selectedTask else { return }
    cancel(task)
  }

  func cancel(_ task: AudioTaskPresentation) {
    if let operationID = task.operationID {
      Task { await pipeline.cancel(operationID) }
      return
    }
    guard let id = task.jobID else { return }
    perform(stage: .cancelling, jobID: id) { uid, ticket in
      _ = try await self.repository.cancel(jobId: id)
      try self.check(uid, ticket)
      await self.history.refreshAfterChange()
    }
  }

  func retrySelected() {
    guard let task = selectedTask else { return }
    retry(task)
  }

  func retry(_ task: AudioTaskPresentation) {
    if let operationID = task.operationID,
      let intent = pipeline.pipelines.first(where: { $0.operationId == operationID }),
      [.failed, .awaitingAppResume].contains(intent.phase),
      task.jobID.flatMap({ id in history.jobs.first { $0.id == id }?.status }) != "failed"
    {
      Task { await pipeline.resume(operationID) }
      return
    }
    guard let id = task.jobID else { return }
    perform(stage: .retrying, operationID: task.operationID, jobID: id) { uid, ticket in
      let result = try await self.repository.retry(jobId: id)
      try self.check(uid, ticket)
      await self.history.refreshAfterChange()
      self.selectedJobID = result.id
      await self.history.select(result.id)
    }
  }

  func downloadSelected(onReady: ((URL) -> Void)? = nil) {
    downloadSelected(stage: .fetchingOutput, onReady: onReady)
  }

  func download(_ job: Job, onReady: ((URL) -> Void)? = nil) {
    guard job.status == "ready", job.canDownloadOutput else { return }
    perform(stage: .fetchingOutput, jobID: job.id) { uid, ticket in
      let file = try await self.outputFile(job.id, job.preferredName)
      try self.check(uid, ticket)
      self.messageKey = "processing_downloaded"
      onReady?(file)
    }
  }

  func downloadSelected(
    stage: ClientErrorStage, onReady: ((URL) -> Void)? = nil
  ) {
    guard let job = history.detail else { return }
    perform(stage: stage, operationID: selectedOperationID, jobID: job.id) { uid, ticket in
      let file = try await self.outputFile(job.id, job.preferredName)
      try self.check(uid, ticket)
      self.messageKey = "processing_downloaded"
      onReady?(file)
    }
  }

  func playSelected() {
    guard let job = history.detail else { return }
    play(job, queue: history.jobs.filter { $0.status == "ready" && $0.canDownloadOutput })
  }

  func play(_ job: Job, queue: [Job]? = nil) {
    guard let uid = ownerUid, job.status == "ready", job.canDownloadOutput else { return }
    let id = playbackID(uid: uid, jobID: job.id)
    let candidates = (queue ?? playbackQueue).filter {
      $0.status == "ready" && $0.canDownloadOutput
    }
    playbackQueue = deduplicatedPlaybackQueue(
      candidates.contains(where: { $0.id == job.id }) ? candidates : [job] + candidates)
    if player.currentID == id {
      player.playing ? player.pause() : player.resume()
      return
    }
    perform(stage: .playback, operationID: selectedOperationID, jobID: job.id) { uid, ticket in
      let file = try await self.outputFile(job.id, job.preferredName)
      try self.check(uid, ticket)
      self.privatePlaybackID = id
      self.currentPlaybackJobID = job.id
      self.player.toggle(id: id, title: job.preferredName, file: file)
      self.originalPrefetch?.cancel()
      self.originalPrefetch = Task { [weak self] in
        guard let self, job.canDownloadInput else { return }
        do {
          try self.check(uid, ticket)
          _ = try await self.originalFile(job.id, job.preferredName)
        } catch {
          // Voice remains playable; an explicit switch can retry.
        }
      }
    }
  }

  func selectOriginal(_ original: Bool) {
    guard let job = currentPlaybackJob, player.original != original, !busy,
      !original || job.canDownloadInput
    else {
      return
    }
    let expectedID = player.currentID
    perform(stage: .playback, operationID: selectedOperationID, jobID: job.id) { uid, ticket in
      let current = job
      let file = try await (original ? self.originalFile : self.outputFile)(
        job.id, job.preferredName)
      try self.check(uid, ticket)
      guard self.player.currentID == expectedID else { return }
      let position = try comparisonPosition(
        self.player.position, toOriginal: original, job: current)
      try self.player.replaceSource(file: file, original: original, position: position)
    }
  }

  func playNext() {
    guard let target = nextPlaybackJob(wrapping: repeatPlayback == .all) else { return }
    play(target, queue: playbackQueue)
  }

  func playPrevious() {
    if player.position > 3 {
      player.seek(to: 0)
      return
    }
    guard let currentPlaybackJobID,
      let index = playbackQueue.firstIndex(where: { $0.id == currentPlaybackJobID })
    else { return }
    let target =
      index > 0 ? playbackQueue[index - 1] : (repeatPlayback == .all ? playbackQueue.last : nil)
    if let target { play(target, queue: playbackQueue) }
  }

  func removeFromPlaybackQueue(_ id: String) {
    guard id != currentPlaybackJobID else { return }
    playbackQueue.removeAll { $0.id == id }
  }

  func downloadOriginal(onReady: @escaping (URL) -> Void) {
    guard let job = history.detail else { return }
    downloadOriginal(job, onReady: onReady)
  }

  func downloadOriginal(_ job: Job, onReady: @escaping (URL) -> Void) {
    guard job.status == "ready", job.canDownloadInput else { return }
    perform(stage: .exporting, jobID: job.id) { uid, ticket in
      let file = try await self.originalFile(job.id, job.preferredName)
      try self.check(uid, ticket)
      onReady(file)
    }
  }

  var selectedIsPlaying: Bool {
    guard let id = history.detail?.id, let uid = ownerUid else { return false }
    return player.currentID == playbackID(uid: uid, jobID: id) && player.playing
  }

  var selectedHasPlayback: Bool {
    guard let id = history.detail?.id, let uid = ownerUid else { return false }
    return player.currentID == playbackID(uid: uid, jobID: id)
  }

  var selectedTask: AudioTaskPresentation? {
    AudioTaskPresentation.merge(
      pipelines: pipeline.pipelines, uploads: repository.operations, jobs: history.jobs
    ).first {
      if let selectedOperationID { return $0.operationID == selectedOperationID }
      if let selectedJobID { return $0.jobID == selectedJobID }
      return false
    }
  }

  func select(_ task: AudioTaskPresentation?) {
    selectedOperationID = task?.operationID
    selectedJobID = task?.jobID
    Task { await history.select(task?.jobID) }
  }

  func renameSelected(_ name: String) {
    guard let task = selectedTask else { return }
    perform(stage: .refreshingJob, operationID: task.operationID, jobID: task.jobID) {
      uid, ticket in
      if let operationID = task.operationID {
        try await self.pipeline.rename(operationID, to: name)
      } else if let jobID = task.jobID {
        _ = try await self.repository.rename(jobId: jobID, displayName: name)
      }
      try self.check(uid, ticket)
      await self.history.refreshAfterChange()
      if let jobID = task.jobID { await self.history.select(jobID) }
    }
  }

  func deleteSelected(onDeleted: @escaping () -> Void = {}) {
    guard let task = selectedTask, task.canDelete else { return }
    perform(stage: .refreshingJob, operationID: task.operationID, jobID: task.jobID) {
      uid, ticket in
      if let jobID = task.jobID {
        try await self.repository.delete(jobId: jobID)
        try self.check(uid, ticket)
        if self.player.currentID == self.playbackID(uid: uid, jobID: jobID) {
          self.player.stopAndClear()
          self.privatePlaybackID = nil
          self.currentPlaybackJobID = nil
        }
        self.playbackQueue.removeAll { $0.id == jobID }
        self.libraryJobs.removeAll { $0.id == jobID }
        await self.removeOutput(jobID)
        // The server deletion is authoritative. Leave a now-missing detail immediately,
        // even if local pipeline cleanup still has work to finish.
        self.selectedJobID = nil
        self.selectedOperationID = nil
        await self.history.select(nil)
        onDeleted()
      }
      if let operationID = task.operationID {
        try await self.pipeline.remove(
          operationID, serverDeletionConfirmed: task.jobID != nil)
      }
      try self.check(uid, ticket)
      if task.jobID == nil {
        self.selectedJobID = nil
        self.selectedOperationID = nil
        await self.history.select(nil)
        onDeleted()
      }
      await self.history.refreshAfterChange()
    }
  }

  func reportImportFailure(_ error: Error) {
    let captured = sourcePickerFence
    sourcePickerFence = nil
    guard (error as NSError).code != NSUserCancelledError else { return }
    guard let captured, captured == repository.session else { return }
    messageKey = processingErrorKey(error)
    Task {
      await reportDiagnostic(
        error, stage: .sourceIntake, operationID: UUID(), fence: captured)
    }
  }

  func beginSourceImport() {
    sourcePickerPending = true
    sourcePickerFence = repository.session
  }

  private func perform(
    preparation: Bool = false, stage: ClientErrorStage,
    operationID: UUID? = nil, jobID: String? = nil,
    _ operation: @escaping (String, UInt64) async throws -> Void
  ) {
    guard let uid = ownerUid, repository.session?.uid == uid else { return }
    let ticket = epoch
    let actionID = UUID()
    messageKey = nil
    busy = !preparation
    preparing = preparation
    let task = Task {
      defer {
        self.actions[actionID] = nil
        if ticket == self.epoch {
          self.busy = !self.actions.isEmpty
          self.preparing = false
        }
      }
      do { try await operation(uid, ticket) } catch is CancellationError {} catch {
        guard ticket == self.epoch, uid == self.ownerUid else { return }
        self.messageKey = processingErrorKey(error)
        await self.reportDiagnostic(
          error, stage: stage, operationID: operationID, jobID: jobID)
        await self.history.refreshAfterChange()
      }
    }
    actions[actionID] = task
  }

  private func handleMissingJob(_ jobID: String) async {
    guard let uid = ownerUid else { return }
    if player.currentID == playbackID(uid: uid, jobID: jobID) {
      player.stopAndClear()
      privatePlaybackID = nil
      currentPlaybackJobID = nil
    }
    playbackQueue.removeAll { $0.id == jobID }
    libraryJobs.removeAll { $0.id == jobID }
    try? await repository.store.saveLibraryJobs(libraryJobs, ownerUid: uid)
    await removeOutput(jobID)
    if let operation = pipeline.pipelines.first(where: { $0.jobId == jobID }) {
      try? await pipeline.remove(operation.operationId, serverDeletionConfirmed: true)
    }
    if selectedJobID == jobID {
      selectedJobID = nil
      selectedOperationID = nil
    }
  }

  private func reportDiagnostic(
    _ error: Error, stage: ClientErrorStage, operationID: UUID? = nil, jobID: String? = nil,
    fence expectedFence: SessionFence? = nil
  ) async {
    guard (error as NSError).code != NSUserCancelledError,
      let fence = repository.session, fence.uid == ownerUid
    else { return }
    if let expectedFence, expectedFence != fence { return }
    await reportFailure(fence, operationID ?? UUID(), jobID, stage, error)
  }

  private func check(_ uid: String, _ ticket: UInt64) throws {
    try Task.checkCancellation()
    guard uid == ownerUid, ticket == epoch, repository.session?.uid == uid else {
      throw CancellationError()
    }
  }

  private func playbackID(uid: String, jobID: String) -> UUID {
    let bytes = Array(SHA256.hash(data: Data("\(uid):\(jobID)".utf8)).prefix(16))
    return UUID(
      uuid: (
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
      ))
  }

  var currentPlaybackJob: Job? {
    guard let currentPlaybackJobID else { return nil }
    return playbackQueue.first { $0.id == currentPlaybackJobID }
      ?? history.jobs.first { $0.id == currentPlaybackJobID }
  }

  private func nextPlaybackJob(wrapping: Bool) -> Job? {
    guard !playbackQueue.isEmpty else { return nil }
    if shufflePlayback, playbackQueue.count > 1 {
      return playbackQueue.filter { $0.id != currentPlaybackJobID }.randomElement()
    }
    guard let currentPlaybackJobID,
      let index = playbackQueue.firstIndex(where: { $0.id == currentPlaybackJobID })
    else { return playbackQueue.first }
    return playbackQueue.indices.contains(index + 1)
      ? playbackQueue[index + 1] : (wrapping ? playbackQueue.first : nil)
  }

  private func advanceAfterPlayback() {
    if repeatPlayback == .one {
      player.seek(to: 0)
      player.resume()
      return
    }
    guard autoPlayNext,
      let target = nextPlaybackJob(wrapping: repeatPlayback == .all)
    else { return }
    play(target, queue: playbackQueue)
  }

  private func deduplicatedPlaybackQueue(_ jobs: [Job]) -> [Job] {
    var ids = Set<String>()
    return jobs.filter { ids.insert($0.id).inserted }
  }
}

func comparisonPosition(_ seconds: Double, toOriginal: Bool, job: Job) throws -> Double {
  if job.trimEnabled == false { return max(0, seconds) }
  guard let ranges = job.comparisonRanges, !ranges.isEmpty else {
    throw JobArtifactFailure.unavailable
  }
  let sample = max(0, seconds) * 44100
  var previousEnd: Int64 = 0
  var outputStart: Int64 = 0
  for range in ranges {
    guard range.count == 2, range[0] >= previousEnd, range[1] > range[0], range[1] <= 52_920_000
    else { throw JobArtifactFailure.invalidOutput }
    let length = range[1] - range[0]
    if toOriginal && sample < Double(outputStart + length) {
      return (Double(range[0]) + max(0, sample - Double(outputStart))) / 44100
    }
    if !toOriginal && sample < Double(range[1]) {
      return (Double(outputStart) + min(Double(length), max(0, sample - Double(range[0])))) / 44100
    }
    previousEnd = range[1]
    outputStart += length
  }
  return Double(toOriginal ? previousEnd : outputStart) / 44100
}
