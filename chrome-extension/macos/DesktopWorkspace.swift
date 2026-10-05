import AVFoundation
import AppKit
import Combine
import CryptoKit
import Darwin
import Foundation

private final class DesktopStderrBudget: @unchecked Sendable {
  private let lock = NSLock()
  private var bytes = 0
  func exceeded(by count: Int) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    bytes += count
    return bytes > 2 * 1024 * 1024
  }
}

@MainActor final class DesktopBridge: ObservableObject {
  @Published private(set) var busy = false
  @Published private(set) var progress = ""
  private var process: Process?
  private var requestId: String?
  private var completion: CheckedContinuation<DesktopJSON, Error>?
  private var verification: Task<RuntimeVerifiedRuntime?, Error>?
  private var reader: Task<Void, Never>?
  private var writer: Task<Void, Never>?
  private var timeout: Task<Void, Never>?
  private var terminationWaiter: Task<Void, Never>?
  private var selectedResult: Result<DesktopJSON, Error>?
  private let resources: URL?
  private let support: URL
  private let signatureChecker: any RuntimeSignatureChecking
  private let verificationCoordinator: RuntimeVerificationCoordinator
  private let terminationGrace: Duration
  init(
    resources: URL?, support: URL = LocalPaths.support,
    signatureChecker: any RuntimeSignatureChecking = SystemRuntimeSignatureChecker(),
    verificationCoordinator: RuntimeVerificationCoordinator = .shared,
    terminationGrace: Duration = .seconds(3)
  ) {
    self.resources = resources
    self.support = support
    self.signatureChecker = signatureChecker
    self.verificationCoordinator = verificationCoordinator
    self.terminationGrace = terminationGrace
  }
  func request(type: String, payload: DesktopJSON, session: DesktopJSON?) async throws
    -> DesktopJSON
  {
    guard !busy, let resources else { throw DesktopAuthFailure.service("APP_OPERATION_BUSY") }
    let id = UUID().uuidString.lowercased()
    var fields: [String: DesktopJSON] = [
      "protocol_version": .number(1), "request_id": .string(id), "type": .string(type),
      "payload": payload,
    ]
    if let session { fields["session"] = session }
    let data = try JSONEncoder().encode(DesktopJSON.object(fields)) + Data([10])
    guard data.count <= 65_536 else { throw DesktopAuthFailure.service("INVALID_DESKTOP_REQUEST") }
    // Reserve the operation before verification suspends. MainActor methods are reentrant, so a
    // later reservation would let two requests overwrite the same process/continuation state.
    busy = true
    progress = "Starting local processing…"
    requestId = id
    defer {
      if requestId == id {
        verification?.cancel()
        verification = nil
        busy = false
        process = nil
        requestId = nil
        completion = nil
        reader = nil
        writer?.cancel()
        writer = nil
        timeout?.cancel()
        timeout = nil
        terminationWaiter?.cancel()
        terminationWaiter = nil
        selectedResult = nil
      }
    }
    let verifiedRuntime: RuntimeVerifiedRuntime
    do {
      let coordinator = verificationCoordinator
      let runtimeSupport = support
      let verificationTask = Task.detached(priority: .userInitiated) {
        () throws -> RuntimeVerifiedRuntime? in
        try coordinator.installedRuntime(resources: resources, support: runtimeSupport)
      }
      verification = verificationTask
      guard let verified = try await verificationTask.value else {
        throw DesktopAuthFailure.service("APP_RUNTIME_NOT_PREPARED")
      }
      guard requestId == id, !verificationTask.isCancelled, !Task.isCancelled else {
        throw DesktopAuthFailure.cancelled
      }
      verification = nil
      verifiedRuntime = verified
    } catch let failure as RuntimeBootstrapFailure {
      throw DesktopAuthFailure.service(failure.errorCode)
    } catch is CancellationError {
      throw DesktopAuthFailure.cancelled
    }
    let runtime = verifiedRuntime.runtimeRoot
    let node = runtime.appendingPathComponent("runtime/node/bin/node")
    let entry = resources.appendingPathComponent("companion/desktop-control.js")
    guard FileManager.default.isExecutableFile(atPath: node.path),
      FileManager.default.fileExists(atPath: entry.path),
      let launch = BundledControlLaunch.command(
        resources: resources, runtime: runtime, arguments: [entry.path])
    else {
      throw DesktopAuthFailure.service("DESKTOP_RUNTIME_UNAVAILABLE")
    }
    progress = "Starting…"
    defer {
      // Keep the shared runtime/update leases until the child reply/termination path completes.
      withExtendedLifetime(verifiedRuntime) {}
    }
    return try await withCheckedThrowingContinuation { continuation in
      completion = continuation
      let task = Process()
      let input = Pipe()
      // An unhealthy child can close stdin while the bounded request is still being written.
      _ = fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)
      let output = Pipe()
      let errors = Pipe()
      process = task
      task.executableURL = launch.executable
      task.arguments = launch.arguments
      task.currentDirectoryURL = resources
      task.environment = [
        "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
        "PATH": "\(node.deletingLastPathComponent().path):/usr/bin:/bin:/usr/sbin:/sbin",
        "LANG": "en_US.UTF-8",
        "TMPDIR": NSTemporaryDirectory(), "MUSICMUTE_LOCAL_APP_RESOURCES": resources.path,
        "MUSICMUTE_LOCAL_ROOT": support.path,
      ]
      task.standardInput = input
      task.standardOutput = output
      task.standardError = errors
      let stderrBudget = DesktopStderrBudget()
      errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
        // Arbitrary tool output can contain private paths, URLs or credentials. Drain without logging.
        let bytes = handle.availableData
        if bytes.isEmpty { handle.readabilityHandler = nil }
        if stderrBudget.exceeded(by: bytes.count) {
          handle.readabilityHandler = nil
          Task { @MainActor in
            guard let self, self.requestId == id else { return }
            self.finishAfterTerminating(
              task, .failure(DesktopAuthFailure.service("DESKTOP_STDERR_LIMIT")), id: id)
          }
        }
      }
      do {
        try task.run()
      } catch {
        task.terminate()
        errors.fileHandleForReading.readabilityHandler = nil
        finish(.failure(DesktopAuthFailure.service("DESKTOP_PROCESS_START_FAILED")), id: id)
        return
      }
      reader = Task { @MainActor in
        do {
          var bytes = 0
          var pending = Data()
          var terminal: DesktopJSON?
          for try await byte in output.fileHandleForReading.bytes {
            guard requestId == id else { break }
            bytes += 1
            guard bytes <= 4 * 1024 * 1024, pending.count <= 512 * 1024 else {
              throw DesktopAuthFailure.malformedResponse
            }
            if byte != 10 {
              pending.append(byte)
              continue
            }
            let event = try JSONDecoder().decode(DesktopJSON.self, from: pending)
            pending.removeAll(keepingCapacity: true)
            guard event["protocol_version"].number == 1, event["request_id"].string == id,
              let kind = event["type"].string
            else { throw DesktopAuthFailure.malformedResponse }
            guard terminal == nil else { throw DesktopAuthFailure.malformedResponse }
            if kind == "progress" {
              let stage = event["payload"]["stage"].string ?? "processing"
              guard safeIdentifier(stage) else { throw DesktopAuthFailure.malformedResponse }
              progress = stage.replacingOccurrences(of: "_", with: " ").capitalized
            } else if kind == "result" {
              terminal = event["payload"]
            } else if kind == "error" {
              throw DesktopAuthFailure.service(
                event["error_code"].string ?? "DESKTOP_OPERATION_FAILED")
            } else {
              throw DesktopAuthFailure.malformedResponse
            }
          }
          guard pending.isEmpty else { throw DesktopAuthFailure.malformedResponse }
          while task.isRunning {
            guard requestId == id, !Task.isCancelled else { return }
            try await Task.sleep(for: .milliseconds(20))
          }
          guard task.terminationStatus == 0 else {
            throw DesktopAuthFailure.service(
              task.terminationStatus == 75
                ? "UPDATE_INSTALLING"
                : task.terminationStatus == 76 ? "UPDATE_LOCK_UNSAFE" : "DESKTOP_PROCESS_EXITED")
          }
          if let terminal {
            finish(.success(terminal), id: id)
          } else if completion != nil {
            finish(.failure(DesktopAuthFailure.service("DESKTOP_RESULT_MISSING")), id: id)
          }
        } catch {
          finishAfterTerminating(
            task, .failure(error as? DesktopAuthFailure ?? .malformedResponse), id: id)
        }
        errors.fileHandleForReading.readabilityHandler = nil
      }
      timeout = Task { @MainActor in
        do { try await Task.sleep(for: .seconds(type == "LIBRARY_CACHE" ? 60 : 1440)) } catch {
          return
        }
        guard requestId == id else { return }
        finishAfterTerminating(
          task, .failure(DesktopAuthFailure.service("DESKTOP_OPERATION_TIMEOUT")), id: id)
      }
      writer = Task.detached(priority: .userInitiated) { [weak self] in
        do {
          try input.fileHandleForWriting.write(contentsOf: data)
          try input.fileHandleForWriting.close()
        } catch {
          try? input.fileHandleForWriting.close()
          await self?.inputFailed(task, id: id)
        }
      }
    }
  }
  private func inputFailed(_ task: Process, id: String) {
    guard requestId == id else { return }
    let code =
      !task.isRunning && task.terminationStatus == 75
      ? "UPDATE_INSTALLING"
      : !task.isRunning && task.terminationStatus == 76
        ? "UPDATE_LOCK_UNSAFE"
        : "DESKTOP_PROCESS_INPUT_FAILED"
    finishAfterTerminating(task, .failure(DesktopAuthFailure.service(code)), id: id)
  }
  private func finish(_ result: Result<DesktopJSON, Error>, id: String) {
    guard requestId == id, let continuation = completion else { return }
    if selectedResult == nil { selectedResult = result }
    guard terminationWaiter == nil, let selectedResult else { return }
    completion = nil
    continuation.resume(with: selectedResult)
  }
  func cancel() {
    verification?.cancel()
    guard let requestId else { return }
    if let process {
      finishAfterTerminating(process, .failure(DesktopAuthFailure.cancelled), id: requestId)
    } else {
      finish(.failure(DesktopAuthFailure.cancelled), id: requestId)
    }
  }
  private func finishAfterTerminating(
    _ process: Process, _ result: Result<DesktopJSON, Error>, id: String
  ) {
    guard requestId == id, completion != nil, selectedResult == nil else { return }
    selectedResult = result
    reader?.cancel()
    writer?.cancel()
    timeout?.cancel()
    guard process.isRunning else {
      finish(result, id: id)
      return
    }
    process.terminate()
    terminationWaiter = Task { @MainActor [weak self] in
      guard let self else { return }
      let deadline = ContinuousClock.now.advanced(by: self.terminationGrace)
      while process.isRunning && ContinuousClock.now < deadline {
        do { try await Task.sleep(for: .milliseconds(10)) } catch { return }
        guard self.requestId == id else { return }
      }
      if process.isRunning {
        let identifier = process.processIdentifier
        if identifier > 0 { kill(identifier, SIGKILL) }
      }
      while process.isRunning {
        do { try await Task.sleep(for: .milliseconds(10)) } catch { return }
        guard self.requestId == id else { return }
      }
      self.terminationWaiter = nil
      self.finish(result, id: id)
    }
  }
}

struct DesktopTrack: Identifiable, Sendable, Equatable {
  let id: String
  var title: String
  let duration: Double
  let path: URL?
  var jobId: String?
  let bytes: Int64
  let sourceVideoId: String?
  var operationId: UUID? = nil
  var trimEnabled: Bool? = nil
  var sourceDuration: Double? = nil
  var syncState: String? = nil
  var updatedAt: Date? = nil
  var canDownloadInput: Bool? = nil
  var cloud: Bool { jobId != nil }
  var originalAvailable: Bool { jobId != nil && canDownloadInput == true }
}

struct DesktopSaveReceiptOutcome: Equatable {
  let state: String
  let notice: String
  let jobId: String?
}

struct DesktopCacheClearOutcome: Equatable {
  let clearedEntries: Int
  let remainingBytes: Int64
  let budgetBytes: Int64
}

struct DesktopCacheBudgetOutcome: Equatable {
  let cacheBytes: Int64
  let budgetBytes: Int64
}

/// Decimal GB limits stay exactly representable by the shared JavaScript helper.
enum DesktopOfflineStoragePolicy {
  static let defaultBytes: Int64 = 2_000_000_000
  static let maximumGigabytes: Int64 = 9_007_199
  private static let bytesPerGigabyte: Int64 = 1_000_000_000

  static func validBudget(_ value: DesktopJSON?) -> Int64? {
    guard let number = value?.number, number.isFinite,
      let bytes = Int64(exactly: number), bytes >= bytesPerGigabyte,
      bytes <= maximumGigabytes * bytesPerGigabyte, bytes % bytesPerGigabyte == 0
    else { return nil }
    return bytes
  }

  static func bytes(gigabytes: String) -> Int64? {
    let value = gigabytes.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty, value.count <= 7,
      value.allSatisfy({ $0.isWholeNumber }),
      let amount = Int64(value), (1...maximumGigabytes).contains(amount)
    else { return nil }
    return amount * bytesPerGigabyte
  }

  static func gigabytes(_ bytes: Int64) -> String {
    String(bytes / bytesPerGigabyte)
  }
}

enum DesktopPlaybackFailure: String {
  case cachePinUnavailable = "CACHE_PIN_UNAVAILABLE"
  case originalUnavailable = "ORIGINAL_NOT_AVAILABLE"
  case startFailed = "DESKTOP_PLAYBACK_START_FAILED"
  case audioFailed = "DESKTOP_AUDIO_PLAYBACK_FAILED"
  var message: String {
    switch self {
    case .cachePinUnavailable:
      "MusicMute could not protect this local voice for playback. Try again."
    case .originalUnavailable:
      "The original audio is not available for this voice."
    case .startFailed: "Playback could not start."
    case .audioFailed: "Audio playback failed. Try this voice again or save it offline."
    }
  }
}

enum DesktopPlaybackVariant: Equatable {
  case voice
  case original

  var isOriginal: Bool { self == .original }
}

enum DesktopPlaybackPreparation: Equatable {
  case downloading
  case preparing
  case buffering
  case failed(DesktopPlaybackFailure)

  var message: String {
    switch self {
    case .downloading: "Downloading audio…"
    case .preparing: "Preparing playback…"
    case .buffering: "Buffering audio…"
    case .failed(let failure): failure.message
    }
  }

  var loading: Bool {
    switch self {
    case .downloading, .preparing: true
    case .buffering, .failed: false
    }
  }
}

private struct DesktopPlaybackRequest {
  let operation: UUID
  let scope: DesktopSessionScope?
  let sameTrack: Bool
  let priorVariant: DesktopPlaybackVariant
  let resumePlayback: Bool
  let position: Double
  let bookmarks: [Double]
  let loopStart: Double?
  let loopEnd: Double?
}

struct DesktopPlaybackVolume: Equatable {
  static let defaultLevel = 1.0
  static let defaultRestoreLevel = 0.8

  private(set) var level: Double
  private(set) var muted: Bool
  private(set) var lastAudibleLevel: Double

  init(level: Double? = nil, muted: Bool? = nil, lastAudibleLevel: Double? = nil) {
    let normalizedLevel = Self.normalized(level, fallback: Self.defaultLevel)
    self.level = normalizedLevel
    self.muted = (muted ?? false) || normalizedLevel == 0
    self.lastAudibleLevel = Self.audible(
      lastAudibleLevel,
      fallback: normalizedLevel > 0 ? normalizedLevel : Self.defaultRestoreLevel)
  }

  mutating func setLevel(_ value: Double) {
    guard value.isFinite else { return }
    level = min(max(value, 0), 1)
    if level > 0 {
      lastAudibleLevel = level
      muted = false
    } else {
      muted = true
    }
  }

  mutating func adjust(by delta: Double) {
    guard delta.isFinite else { return }
    setLevel(level + delta)
  }

  mutating func toggleMute() {
    if muted {
      if level == 0 { level = lastAudibleLevel }
      muted = false
    } else {
      if level > 0 { lastAudibleLevel = level }
      muted = true
    }
  }

  private static func normalized(_ value: Double?, fallback: Double) -> Double {
    guard let value, value.isFinite else { return fallback }
    return min(max(value, 0), 1)
  }

  private static func audible(_ value: Double?, fallback: Double) -> Double {
    guard let value, value.isFinite, value > 0 else { return fallback }
    return min(value, 1)
  }

  static func storedDouble(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber,
      CFGetTypeID(number) != CFBooleanGetTypeID()
    else { return nil }
    return number.doubleValue
  }
}

@MainActor final class DesktopPlaybackClock: ObservableObject {
  @Published private(set) var position = 0.0
  @Published private(set) var duration = 0.0

  func update(position: Double? = nil, duration: Double? = nil) {
    if let position, position.isFinite {
      let normalized = max(0, position)
      if abs(self.position - normalized) > 0.000_1 { self.position = normalized }
    }
    if let duration, duration.isFinite {
      let normalized = max(0, duration)
      if abs(self.duration - normalized) > 0.000_1 { self.duration = normalized }
    }
  }

  func reset() {
    update(position: 0, duration: 0)
  }
}

@MainActor final class DesktopPlaybackVolumeState: ObservableObject {
  @Published private(set) var value: DesktopPlaybackVolume

  init(_ value: DesktopPlaybackVolume) { self.value = value }

  func update(_ value: DesktopPlaybackVolume) {
    guard value != self.value else { return }
    self.value = value
  }
}

enum DesktopPlaybackAdvance: Equatable {
  case pause
  case replayCurrent(variant: DesktopPlaybackVariant)
  case playQueued(index: Int, requeueCurrent: Bool, variant: DesktopPlaybackVariant)

  static func next(
    repeatMode: String, hasCurrent: Bool, currentVariant: DesktopPlaybackVariant, queueCount: Int,
    selectedQueueIndex: Int
  ) -> Self {
    if repeatMode == "Track", hasCurrent {
      return .replayCurrent(variant: currentVariant)
    }
    if queueCount > 0 {
      let index = (0..<queueCount).contains(selectedQueueIndex) ? selectedQueueIndex : 0
      return .playQueued(
        index: index, requeueCurrent: repeatMode == "Queue" && hasCurrent,
        variant: currentVariant)
    }
    if repeatMode == "Queue", hasCurrent {
      return .replayCurrent(variant: currentVariant)
    }
    return .pause
  }
}

enum DesktopLibrarySnapshotReadiness: Equatable {
  case disconnected
  case awaitingInitialSnapshot(scope: DesktopSessionScope, streamID: String)
  case ready(scope: DesktopSessionScope, streamID: String)

  var isReady: Bool {
    if case .ready = self { return true }
    return false
  }

  func isReady(scope: DesktopSessionScope?, streamID: String?) -> Bool {
    guard case .ready(let readyScope, let readyStreamID) = self else { return false }
    return readyScope == scope && readyStreamID == streamID
  }

  mutating func jobsSubscriptionRequested(scope: DesktopSessionScope, streamID: String) {
    if case .ready(let currentScope, let currentStreamID) = self,
      currentScope == scope, currentStreamID == streamID
    {
      // Replacing the current subscription for pagination does not invalidate the
      // initial page already received on this account connection.
      return
    }
    self = .awaitingInitialSnapshot(scope: scope, streamID: streamID)
  }

  mutating func jobsSnapshotReceived(scope: DesktopSessionScope, streamID: String) {
    guard
      case .awaitingInitialSnapshot(let expectedScope, let expectedStreamID) = self,
      expectedScope == scope, expectedStreamID == streamID
    else { return }
    self = .ready(scope: scope, streamID: streamID)
  }

  mutating func reset() { self = .disconnected }
}

struct DesktopCloudJobsPage: Equatable {
  let rows: [DesktopJSON]
  let nextCursor: String?
}

@MainActor final class DesktopWorkspace: ObservableObject {
  @Published private(set) var localTracks: [DesktopTrack] = []
  @Published private(set) var cloudJobs: [DesktopJSON] = []
  @Published private(set) var cacheBytes: Int64 = 0
  @Published private(set) var budgetBytes: Int64 = DesktopOfflineStoragePolicy.defaultBytes
  @Published private(set) var savingCacheBudget = false
  @Published private(set) var cacheBudgetStatus: String?
  @Published private(set) var clearingCache = false
  @Published private(set) var cacheClearStatus: String?
  @Published private(set) var processing = false
  @Published private(set) var progress = ""
  @Published var failure: String?
  @Published var notice: String?
  @Published private(set) var pendingCloudHandoff: DesktopCloudHandoff?
  @Published private(set) var currentTrack: DesktopTrack?
  @Published private(set) var playing = false
  @Published private(set) var playbackPreparation: DesktopPlaybackPreparation?
  @Published var rate = 1.0
  @Published var queue: [DesktopTrack] = []
  @Published var shuffle = false
  @Published var repeatMode = "Off"
  @Published var favorites: Set<String> = []
  @Published var hidden: Set<String> = []
  @Published var usage = DesktopJSON.null
  @Published private(set) var loopStart: Double?
  @Published private(set) var loopEnd: Double?
  @Published private(set) var bookmarks: [Double] = []
  @Published private(set) var skipSilence = false
  @Published private(set) var analyzingSilence = false
  @Published private(set) var preparingOriginal = false
  @Published private(set) var cloudConnected = false
  @Published private var librarySnapshotReadiness = DesktopLibrarySnapshotReadiness.disconnected
  @Published private(set) var cloudHasMore = false
  @Published private(set) var localHasMore = false
  @Published private(set) var localTotal = 0
  let playbackClock = DesktopPlaybackClock()
  let playbackVolumeState: DesktopPlaybackVolumeState
  let account: DesktopAccountModel
  let bridge: DesktopBridge
  private let syncBridge: DesktopBridge
  private let playbackBridge: DesktopBridge
  private let journal: UIJournal?
  private let playbackSupport: URL
  private let preferences: UserDefaults
  private let playbackAssetLoader: (@MainActor (URL) async throws -> AVURLAsset)?
  private var player: AVPlayer?
  private var periodicObserver: Any?
  private var endObserver: NSObjectProtocol?
  private var socket: URLSessionWebSocketTask?
  private var socketLoop: Task<Void, Never>?
  private var nextCursor: String?
  private var nextLocalCursor: String?
  private var streamId: String?
  private var lastFrameAt = Date()
  private var readyAt: Date?
  private var jobsSubscriptionID: String?
  private var jobsCursor: String?
  private var jobSnapshotRequestedAt: Date?
  private var sequences: [String: Double] = [:]
  private var activeSession: DesktopSessionScope?
  private var observer: AnyCancellable?
  private var sleepTask: Task<Void, Never>?
  private var compare = false
  private var playbackTimelineVariant = DesktopPlaybackVariant.voice
  private var playbackPin: URL?
  private var playbackTemporary: URL?
  private var playbackOperation: UUID?
  private var playbackTask: Task<Bool, Never>?
  private var playbackAsset: AVURLAsset?
  private var playbackPinTask: Task<URL, Error>?
  private var playbackStatus: NSKeyValueObservation?
  private var playbackWaiting: NSKeyValueObservation?
  private var receiptWatchers: [DesktopOutboxWatcher] = []
  private var syncOperation: UUID?
  private var syncRequested = false
  private var shuttingDown = false
  private var silenceTask: Task<[DesktopSilenceRange], Error>?
  private var silenceRanges: [DesktopSilenceRange] = []
  var libraryConnected: Bool {
    librarySnapshotReadiness.isReady(scope: account.scope, streamID: streamId)
  }
  init(
    account: DesktopAccountModel, resources: URL?, journal: UIJournal? = nil,
    playbackSupport: URL = LocalPaths.support, preferences: UserDefaults = .standard,
    playbackAssetLoader: (@MainActor (URL) async throws -> AVURLAsset)? = nil
  ) {
    self.account = account
    self.journal = journal
    self.playbackSupport = playbackSupport
    self.preferences = preferences
    self.playbackAssetLoader = playbackAssetLoader
    bridge = DesktopBridge(resources: resources)
    syncBridge = DesktopBridge(resources: resources)
    playbackBridge = DesktopBridge(resources: resources)
    playbackVolumeState = DesktopPlaybackVolumeState(
      DesktopPlaybackVolume(
        level: DesktopPlaybackVolume.storedDouble(
          preferences.object(forKey: DesktopPreferenceKey.playbackVolume)),
        muted: preferences.object(forKey: DesktopPreferenceKey.playbackMuted) as? Bool,
        lastAudibleLevel: DesktopPlaybackVolume.storedDouble(
          preferences.object(forKey: DesktopPreferenceKey.playbackLastAudibleVolume))))
    observer = bridge.$progress.sink { [weak self] value in self?.progress = value }
    account.onSessionChanged = { [weak self] scope in self?.sessionChanged(scope) }
  }
  func start() async {
    shuttingDown = false
    await loadCache()
    if account.scope != nil { connectCloud() }
  }
  /// Reconciles the workspace after Setup (or a readiness check) confirms that the runtime exists.
  /// The first launch intentionally starts the workspace while Setup is still checking, so a
  /// pre-setup cache read must never survive as a stale Home error after preparation succeeds.
  func runtimeBecameReady() async {
    clearRuntimePreparationFailure()
    _ = await loadCache()
  }
  func clearRuntimePreparationFailure() {
    let expected = ["APP_RUNTIME_NOT_PREPARED", "APP_RUNTIME_INCOMPATIBLE"].map {
      DesktopAuthFailure.service($0).message
    }
    if failure.map(expected.contains) == true { failure = nil }
  }
  func receiveCloudHandoff(_ handoff: DesktopCloudHandoff) {
    guard !processing else {
      notice =
        "Finish or cancel the current preparation, then choose MusicMute cloud again in Chrome."
      return
    }
    pendingCloudHandoff = handoff
  }
  func consumeCloudHandoff() { pendingCloudHandoff = nil }
  var updateBusy: Bool {
    processing || bridge.busy || syncBridge.busy || playbackBridge.busy || currentTrack != nil
      || playing
      || clearingCache || analyzingSilence || syncOperation != nil
  }
  private func sessionChanged(_ scope: DesktopSessionScope?) {
    guard !shuttingDown else { return }
    bridge.cancel()
    syncBridge.cancel()
    playbackBridge.cancel()
    stopReceiptWatchers()
    syncOperation = nil
    syncRequested = false
    stop()
    socketLoop?.cancel()
    socketLoop = nil
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    cloudJobs = []
    usage = .null
    cloudConnected = false
    librarySnapshotReadiness.reset()
    activeSession = scope
    localTracks = []
    favorites = []
    hidden = []
    queue = []
    nextCursor = nil
    if let scope {
      favorites = Set(
        UserDefaults.standard.stringArray(forKey: preferenceKey("favorites", scope.firebaseUid))
          ?? [])
      hidden = Set(
        UserDefaults.standard.stringArray(forKey: preferenceKey("hidden", scope.firebaseUid)) ?? [])
      for directory in [
        "sync-outbox", "sync-captures", "cache-restores", "youtube-community-outbox/owner-links",
      ] {
        let watcher = DesktopOutboxWatcher(
          root: LocalPaths.support.appendingPathComponent(directory, isDirectory: true),
          uid: scope.firebaseUid
        ) { [weak self] in
          Task { @MainActor in
            guard let self, self.account.scope == scope, !self.shuttingDown else { return }
            await self.syncAccount()
          }
        }
        receiptWatchers.append(watcher)
        do { try watcher.start() } catch {
          notice = "Local voices are available. Automatic account save could not start."
        }
      }
    }
    Task {
      await loadCache()
      if scope != nil { connectCloud() }
    }
  }
  private func stopReceiptWatchers() {
    for watcher in receiptWatchers { watcher.stop() }
    receiptWatchers = []
  }
  private func preferenceKey(_ kind: String, _ owner: String) -> String {
    "desktop.\(kind).\(SHA256.hash(data: Data(owner.utf8)).map { String(format: "%02x", $0) }.joined())"
  }
  func favorite(_ track: DesktopTrack) {
    let keys = Set([track.id, track.jobId].compactMap { $0 })
    if keys.isDisjoint(with: favorites) {
      favorites.formUnion(keys)
    } else {
      favorites.subtract(keys)
    }
    UserDefaults.standard.set(
      Array(favorites).sorted(), forKey: preferenceKey("favorites", account.firebaseUid ?? "local"))
  }
  func hide(_ track: DesktopTrack) {
    let keys = Set([track.id, track.jobId].compactMap { $0 })
    if keys.isDisjoint(with: hidden) { hidden.formUnion(keys) } else { hidden.subtract(keys) }
    UserDefaults.standard.set(
      Array(hidden).sorted(), forKey: preferenceKey("hidden", account.firebaseUid ?? "local"))
  }
  @discardableResult func loadCache(cursor: String? = nil, append: Bool = false) async -> Bool {
    guard !bridge.busy else { return false }
    let fence = account.scope
    do {
      var fields: [String: DesktopJSON] = ["limit": .number(50)]
      if let cursor { fields["cursor"] = .string(cursor) }
      let value = try await bridge.request(
        type: "LIBRARY_CACHE", payload: .object(fields), session: account.localSession())
      guard account.scope == fence else { return false }
      let records = value["items"].array
      guard records.count <= 50, let bytes = Self.nonnegativeInt64(value["cache_bytes"]),
        let budget = DesktopOfflineStoragePolicy.validBudget(value["budget_bytes"])
      else { throw DesktopAuthFailure.malformedResponse }
      let page = try records.map { record in
        guard let key = record["cache_key"].string, DiagnosticIdentity.validDigest(key),
          let path = record["vocal_path"].string, let url = validatedVocalPath(path),
          let duration = record["duration_seconds"].number, duration.isFinite, duration > 0,
          let bytes = Self.nonnegativeInt64(record["bytes"]),
          record["owner_uid"].string == nil || record["owner_uid"].string == fence?.firebaseUid,
          record["job_id"].string.map(Self.validJobID) != false
        else {
          throw DesktopAuthFailure.malformedResponse
        }
        var track = DesktopTrack(
          id: key, title: Self.trackTitle(record["source_title"].string, fallback: "Saved voice"),
          duration: duration, path: url, jobId: record["job_id"].string, bytes: bytes,
          sourceVideoId: record["video_id"].string)
        if let sourceDuration = record["source_duration_seconds"].number {
          guard sourceDuration.isFinite, sourceDuration > 0 else {
            throw DesktopAuthFailure.malformedResponse
          }
          track.sourceDuration = sourceDuration
        }
        track.trimEnabled = record["trim_enabled"].bool
        track.updatedAt = Self.date(milliseconds: record["updated_at"].number)
        return track
      }
      if append {
        let existing = Set(localTracks.map(\.id))
        localTracks += page.filter { !existing.contains($0.id) }
      } else {
        localTracks = page
      }
      reconcilePlaybackMetadata()
      guard localTracks.count <= 4096 else { throw DesktopAuthFailure.malformedResponse }
      nextLocalCursor = value["next_cursor"].string
      localHasMore = nextLocalCursor != nil
      if let total = value["total"].number, total >= 0, total <= 4096 { localTotal = Int(total) }
      cacheBytes = bytes
      budgetBytes = budget
      return true
    } catch {
      if let message = Self.visibleCacheLoadFailure(error) { failure = message }
      return false
    }
  }
  static func visibleCacheLoadFailure(_ error: Error) -> String? {
    if let failure = error as? DesktopAuthFailure, failure.requiresRuntimePreparation {
      // Setup owns this expected first-run state. Home and Library should remain quiet until the
      // user explicitly tries processing, where the same code has actionable guidance.
      return nil
    }
    return (error as? DesktopAuthFailure)?.message ?? "The local library could not be read."
  }
  func nextLocalPage() async {
    if let nextLocalCursor { await loadCache(cursor: nextLocalCursor, append: true) }
  }
  /// Refreshes the Library at the user's navigation boundary without polling or reconnecting.
  func libraryBecameVisible() async {
    let fence = account.scope
    _ = await loadCache()
    guard account.scope == fence, !shuttingDown else { return }
    if jobsCursor != nil, cloudConnected, jobsSubscriptionID != nil {
      do { try await subscribeJobs() } catch {
        if account.scope == fence { failure = "The newest account voices could not be loaded." }
      }
    }
    guard account.scope == fence, account.signedIn, !account.deletionPending else { return }
    await syncAccount()
  }
  nonisolated static func cacheClearOutcome(_ value: DesktopJSON) throws
    -> DesktopCacheClearOutcome
  {
    guard case .object(let fields) = value,
      Set(fields.keys) == Set(["cleared_entries", "cache_bytes", "budget_bytes"]),
      let cleared = fields["cleared_entries"]?.number, cleared.isFinite,
      cleared.rounded(.towardZero) == cleared, cleared >= 0, cleared <= 8192,
      let clearedEntries = Int(exactly: cleared),
      let remainingBytes = nonnegativeInt64(fields["cache_bytes"]),
      let budgetBytes = DesktopOfflineStoragePolicy.validBudget(fields["budget_bytes"])
    else { throw DesktopAuthFailure.malformedResponse }
    return DesktopCacheClearOutcome(
      clearedEntries: clearedEntries, remainingBytes: remainingBytes, budgetBytes: budgetBytes)
  }
  private nonisolated static func nonnegativeInt64(_ value: DesktopJSON?) -> Int64? {
    guard let number = value?.number, number.isFinite, number >= 0 else { return nil }
    return Int64(exactly: number)
  }
  nonisolated static func cacheBudgetOutcome(_ value: DesktopJSON) throws
    -> DesktopCacheBudgetOutcome
  {
    guard case .object(let fields) = value,
      Set(fields.keys) == Set(["cache_bytes", "budget_bytes"]),
      let bytes = nonnegativeInt64(fields["cache_bytes"]),
      let budget = DesktopOfflineStoragePolicy.validBudget(fields["budget_bytes"])
    else { throw DesktopAuthFailure.malformedResponse }
    return DesktopCacheBudgetOutcome(cacheBytes: bytes, budgetBytes: budget)
  }

  func saveOfflineStorageLimit(gigabytes: String) async {
    guard let bytes = DesktopOfflineStoragePolicy.bytes(gigabytes: gigabytes) else {
      cacheBudgetStatus = "Enter a whole number of GB, starting at 1."
      return
    }
    guard !bridge.busy, !processing, !clearingCache, !savingCacheBudget else {
      cacheBudgetStatus = "Wait for the current MusicMute operation to finish, then try again."
      return
    }
    savingCacheBudget = true
    cacheBudgetStatus = "Saving offline voice storage limit…"
    defer { savingCacheBudget = false }
    do {
      let value = try await bridge.request(
        type: "SET_CACHE_BUDGET", payload: .object(["budget_bytes": .number(Double(bytes))]),
        session: nil)
      let outcome = try Self.cacheBudgetOutcome(value)
      guard outcome.budgetBytes == bytes else { throw DesktopAuthFailure.malformedResponse }
      cacheBytes = outcome.cacheBytes
      budgetBytes = outcome.budgetBytes
      cacheBudgetStatus = "Offline voice storage limit saved."
    } catch {
      cacheBudgetStatus =
        "The storage limit could not be saved. Try again after MusicMute finishes its current operation."
    }
  }
  func clearOfflineVoices() async {
    guard !bridge.busy, !processing, !clearingCache else {
      cacheClearStatus = "Wait for the current MusicMute operation to finish, then try again."
      return
    }
    let fence = account.scope
    stop()
    clearingCache = true
    cacheClearStatus = "Clearing eligible offline voices…"
    failure = nil
    notice = nil
    defer { clearingCache = false }
    do {
      let value = try await bridge.request(
        type: "CLEAR_CACHE", payload: .object([:]), session: account.localSession())
      guard account.scope == fence else { return }
      invalidateLocalCacheView()
      let outcome = try Self.cacheClearOutcome(value)
      cacheBytes = outcome.remainingBytes
      budgetBytes = outcome.budgetBytes
      let reloaded = await loadCache()
      guard account.scope == fence else { return }
      guard reloaded else {
        cacheClearStatus =
          "Offline voices were cleared, but the local library could not be refreshed. Reopen MusicMute to reload it."
        failure = cacheClearStatus
        return
      }
      cacheClearStatus =
        outcome.clearedEntries == 0
        ? "No eligible offline voices were removed. Protected account saves or active playback may remain."
        : "Removed \(outcome.clearedEntries) eligible offline voice\(outcome.clearedEntries == 1 ? "" : "s") from this Mac."
      notice = cacheClearStatus
    } catch {
      guard account.scope == fence else { return }
      cacheClearStatus =
        (error as? DesktopAuthFailure)?.message
        ?? "Offline voices could not be cleared safely. Try again after playback and account saves finish."
      failure = cacheClearStatus
    }
  }
  private func invalidateLocalCacheView() {
    localTracks = []
    queue.removeAll { $0.path != nil }
    nextLocalCursor = nil
    localHasMore = false
    localTotal = 0
  }
  private func nativeSession() async throws -> DesktopJSON? {
    guard account.scope != nil else { return nil }
    var session = try await account.authorizedSession()
    if case .object(var fields) = session {
      fields["installation_id"] = .string(account.installationId)
      session = .object(fields)
    }
    return session
  }
  func process(
    url: String?, file: URL?, cloud: Bool, expectedAccountScope: DesktopSessionScope? = nil
  ) async {
    guard !processing, !bridge.busy else { return }
    guard !account.updateRequired else {
      failure = "Update MusicMute before starting new processing."
      return
    }
    let fence = account.scope
    if cloud && !account.signedIn {
      failure = "Sign in before choosing cloud processing."
      return
    }
    if cloud && (expectedAccountScope == nil || expectedAccountScope != fence) {
      failure = "Your account changed. Review the account and confirm cloud processing again."
      return
    }
    var payload: [String: DesktopJSON] = [:]
    if let file {
      payload = [
        "source_kind": .string("file"), "source_path": .string(file.path),
        "source_title": .string(file.deletingPathExtension().lastPathComponent),
      ]
    } else if let url {
      payload = ["source_kind": .string("url"), "youtube_url": .string(url)]
    } else {
      return
    }
    processing = true
    failure = nil
    notice = nil
    defer { processing = false }
    do {
      let result = try await bridge.request(
        type: cloud ? "CLOUD_START" : "LOCAL_START", payload: .object(payload),
        session: cloud ? try await nativeSession() : account.localSession())
      guard account.scope == fence, let path = result["vocal_path"].string,
        let vocal = validatedVocalPath(path),
        let duration = result["duration_seconds"].number, duration > 0, duration.isFinite,
        let key = result["cache_key"].string, DiagnosticIdentity.validDigest(key)
      else { throw DesktopAuthFailure.malformedResponse }
      var track = DesktopTrack(
        id: key,
        title: Self.trackTitle(
          result["source_title"].string,
          fallback: file?.deletingPathExtension().lastPathComponent ?? "YouTube voice"),
        duration: duration, path: vocal, jobId: result["job_id"].string, bytes: 0,
        sourceVideoId: result["video_id"].string)
      if let id = result["operation_id"].string {
        guard let operation = UUID(uuidString: id) else {
          throw DesktopAuthFailure.malformedResponse
        }
        track.operationId = operation
      }
      track.trimEnabled = result["trim_enabled"].bool
      track.syncState = result["sync_state"].string
      if let sourceDuration = result["source_duration_seconds"].number {
        guard sourceDuration > 0, sourceDuration.isFinite else {
          throw DesktopAuthFailure.malformedResponse
        }
        track.sourceDuration = sourceDuration
      }
      if await play(track) {
        notice = Self.resultNotice(
          cacheHit: result["cache_hit"].bool == true, syncState: result["sync_state"].string)
      }
      await loadCache()
      if !cloud, account.signedIn { Task { await self.syncAccount() } }
    } catch { failure = (error as? DesktopAuthFailure)?.message ?? "Processing could not finish." }
  }
  static func resultNotice(cacheHit: Bool, syncState: String?) -> String {
    if syncState == "unavailable" {
      return
        "Voice playback is available. Account saving is unavailable for this result; your local voice has been kept."
    }
    if syncState == "pending" {
      return cacheHit
        ? "Playing your cached voice without processing again. Account saving is pending."
        : "Voice ready. Account saving is pending."
    }
    return cacheHit ? "Playing your saved voice without processing again." : "Voice ready."
  }
  func cancelProcessing() { bridge.cancel() }
  func syncAccount() async {
    await syncAccount(captureDrainRemaining: 31)
  }
  static func saveReceiptOutcome(for track: DesktopTrack, items: [DesktopJSON])
    -> DesktopSaveReceiptOutcome?
  {
    let matching = items.filter { item in
      if let key = item["cache_key"].string { return key == track.id }
      guard let request = item["request_id"].string,
        let requestID = UUID(uuidString: request), let operationID = track.operationId
      else { return false }
      return requestID == operationID
    }
    let states = Set(matching.compactMap { $0["state"].string })
    if !states.isDisjoint(with: ["ready", "committed"]) {
      let jobId = matching.first(where: {
        ["ready", "committed"].contains($0["state"].string ?? "")
          && $0["job_id"].string.map(Self.validJobID) == true
      })?["job_id"].string
      return DesktopSaveReceiptOutcome(
        state: "ready", notice: "This voice is saved to your account.", jobId: jobId)
    }
    if states.contains("rejected") {
      return DesktopSaveReceiptOutcome(
        state: "unavailable", notice: resultNotice(cacheHit: true, syncState: "unavailable"),
        jobId: nil)
    }
    if !states.isDisjoint(with: ["failed", "deferred", "pending", "uploading", "capturing"]) {
      return DesktopSaveReceiptOutcome(
        state: "pending",
        notice:
          "Voice playback is available. Account upload is pending; no local voice was removed.",
        jobId: nil)
    }
    return nil
  }
  static func captureFollowUpBudget(_ result: DesktopJSON, remaining: Int) -> Int? {
    guard
      result["capture_more_pending"].bool == true
        || result["cache_restore_more_pending"].bool == true,
      remaining > 0
    else { return nil }
    return min(remaining, 31) - 1
  }
  private func syncAccount(captureDrainRemaining: Int) async {
    guard !shuttingDown, account.signedIn, !account.deletionPending else { return }
    if syncOperation != nil {
      syncRequested = true
      return
    }
    let operation = UUID()
    syncOperation = operation
    syncRequested = false
    let fence = account.scope
    var followUpBudget: Int?
    defer {
      if syncOperation == operation {
        syncOperation = nil
        if syncRequested, account.scope == fence {
          syncRequested = false
          Task { @MainActor in
            guard self.account.scope == fence, !self.shuttingDown else { return }
            await self.syncAccount()
          }
        } else if let followUpBudget, account.scope == fence {
          Task { @MainActor in
            guard self.account.scope == fence, !self.shuttingDown else { return }
            await self.syncAccount(captureDrainRemaining: followUpBudget)
          }
        }
      }
    }
    do {
      let session = try await nativeSession()
      guard account.scope == fence, syncOperation == operation else { return }
      let result = try await syncBridge.request(
        type: "SYNC", payload: .object([:]), session: session)
      guard account.scope == fence else { return }
      let items = result["items"].array
      followUpBudget = Self.captureFollowUpBudget(result, remaining: captureDrainRemaining)
      if let track = currentTrack,
        let outcome = Self.saveReceiptOutcome(for: track, items: items)
      {
        currentTrack?.syncState = outcome.state
        if let jobId = outcome.jobId { currentTrack?.jobId = jobId }
        notice = outcome.notice
      } else if currentTrack == nil,
        result["pending_count"].number == 0 && !items.isEmpty
          && items.allSatisfy({ ["ready", "committed"].contains($0["state"].string ?? "") })
      {
        notice = "Queued voices were saved to your account."
      } else if currentTrack == nil, (result["pending_count"].number ?? 0) > 0 {
        notice = "Account saves are pending. Local voices remain available."
      }
      await loadCache()
    } catch {
      if account.scope == fence,
        currentTrack == nil || currentTrack?.syncState == "pending"
      {
        notice =
          "Voice playback is available. Account upload is pending; no local voice was removed."
      }
    }
  }
  func download(_ track: DesktopTrack) async {
    guard let job = track.jobId, Self.validJobID(job), !bridge.busy else { return }
    let fence = account.scope
    do {
      _ = try await bridge.request(
        type: "LIBRARY_DOWNLOAD", payload: .object(["job_id": .string(job)]),
        session: try await nativeSession())
      guard account.scope == fence else { return }
      await loadCache()
      notice = "Voice saved offline."
    } catch {
      failure = (error as? DesktopAuthFailure)?.message ?? "The voice could not be saved offline."
    }
  }
  private func validatedVocalPath(_ path: String) -> URL? {
    guard
      let url = LocalPaths.descendant(
        path, of: playbackSupport.appendingPathComponent("cache", isDirectory: true)),
      FileManager.default.fileExists(atPath: url.path),
      ["mp3", "m4a", "wav"].contains(url.pathExtension.lowercased())
    else { return nil }
    return url
  }
  private func validatedOriginalPath(_ path: String) -> URL? {
    guard
      let url = LocalPaths.descendant(
        path,
        of: playbackSupport.appendingPathComponent(
          "cache/original-playback/leases", isDirectory: true)),
      FileManager.default.fileExists(atPath: url.path), url.pathExtension.lowercased() == "m4a"
    else { return nil }
    return url
  }
  var tracks: [DesktopTrack] {
    Self.libraryTracks(localTracks: localTracks, cloudJobs: cloudJobs)
  }
  static func trackTitle(_ candidates: String?..., fallback: String) -> String {
    for candidate in candidates {
      guard let candidate else { continue }
      let cleaned = String(
        candidate.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }
      ).trimmingCharacters(in: .whitespacesAndNewlines)
      if !cleaned.isEmpty { return String(cleaned.prefix(200)) }
    }
    return String(fallback.prefix(200))
  }
  static func libraryTracks(localTracks: [DesktopTrack], cloudJobs: [DesktopJSON]) -> [DesktopTrack]
  {
    var result = localTracks.map { track in
      guard let jobID = track.jobId, Self.validJobID(jobID),
        let job = cloudJobs.first(where: { $0["id"].string == jobID })
      else { return track }
      var namedTrack = track
      namedTrack.title = Self.trackTitle(
        job["display_name"].string, job["source_title"].string, fallback: track.title)
      namedTrack.updatedAt = [track.updatedAt, Self.cloudDate(job)].compactMap { $0 }.max()
      namedTrack.canDownloadInput = job["can_download_input"].bool
      namedTrack.trimEnabled = job["trim_enabled"].bool ?? track.trimEnabled
      if let sourceDuration = job["input"]["duration_seconds"].number,
        sourceDuration.isFinite, sourceDuration > 0
      {
        namedTrack.sourceDuration = sourceDuration
      }
      return namedTrack
    }
    let locallySavedJobs = Set(localTracks.compactMap(\.jobId))
    for job in cloudJobs where job["status"].string == "ready" {
      guard let id = job["id"].string, Self.validJobID(id), !locallySavedJobs.contains(id) else {
        continue
      }
      guard let sourceDuration = job["input"]["duration_seconds"].number,
        sourceDuration.isFinite, sourceDuration > 0
      else { continue }
      let outputDuration = job["output"]["duration_seconds"].number ?? sourceDuration
      guard outputDuration.isFinite, outputDuration > 0 else { continue }
      result.append(
        DesktopTrack(
          id: id,
          title: Self.trackTitle(
            job["display_name"].string, job["source_title"].string, fallback: "Voice track"),
          duration: outputDuration, path: nil, jobId: id, bytes: 0, sourceVideoId: nil,
          trimEnabled: job["trim_enabled"].bool, sourceDuration: sourceDuration,
          updatedAt: Self.cloudDate(job), canDownloadInput: job["can_download_input"].bool))
    }
    return result
  }
  static func newestTracks(_ tracks: [DesktopTrack]) -> [DesktopTrack] {
    tracks.sorted { left, right in
      switch (left.updatedAt, right.updatedAt) {
      case (let left?, let right?) where left != right: return left > right
      case (_?, nil): return true
      case (nil, _?): return false
      default:
        let title = left.title.localizedStandardCompare(right.title)
        return title == .orderedSame ? left.id < right.id : title == .orderedAscending
      }
    }
  }
  private func reconcilePlaybackMetadata() {
    let candidates = tracks
    if let currentTrack {
      self.currentTrack = Self.reconciledTrack(currentTrack, candidates: candidates)
    }
    queue = queue.map { Self.reconciledTrack($0, candidates: candidates) }
  }
  static func reconciledTrack(_ track: DesktopTrack, candidates: [DesktopTrack]) -> DesktopTrack {
    guard
      let candidate = candidates.first(where: {
        $0.id == track.id
          || (track.jobId != nil && $0.jobId == track.jobId)
      })
    else { return track }
    var result = track
    result.title = candidate.title
    if let jobId = candidate.jobId, validJobID(jobId) { result.jobId = jobId }
    result.canDownloadInput = candidate.canDownloadInput ?? track.canDownloadInput
    result.trimEnabled = candidate.trimEnabled ?? track.trimEnabled
    result.sourceDuration = candidate.sourceDuration ?? track.sourceDuration
    result.updatedAt = [track.updatedAt, candidate.updatedAt].compactMap { $0 }.max()
    return result
  }
  private static func date(milliseconds: Double?) -> Date? {
    guard let milliseconds, milliseconds.isFinite, milliseconds >= 0 else { return nil }
    return Date(timeIntervalSince1970: milliseconds / 1_000)
  }
  private static func cloudDate(_ job: DesktopJSON) -> Date? {
    for key in ["finished_at", "updated_at", "created_at"] {
      guard let value = job[key].string else { continue }
      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      if let date = formatter.date(from: value) { return date }
      formatter.formatOptions = [.withInternetDateTime]
      if let date = formatter.date(from: value) { return date }
    }
    return nil
  }
  func starred(_ track: DesktopTrack) -> Bool {
    favorites.contains(track.id) || track.jobId.map(favorites.contains) == true
  }
  func removed(_ track: DesktopTrack) -> Bool {
    hidden.contains(track.id) || track.jobId.map(hidden.contains) == true
  }
  @discardableResult func play(_ track: DesktopTrack, original: Bool = false) async -> Bool {
    let sameTrack = currentTrack?.id == track.id
    let request = DesktopPlaybackRequest(
      operation: UUID(), scope: account.scope, sameTrack: sameTrack,
      priorVariant: playbackTimelineVariant,
      resumePlayback: sameTrack && player != nil ? playing : true,
      position: sameTrack ? position : 0,
      bookmarks: sameTrack ? bookmarks : [],
      loopStart: sameTrack ? loopStart : nil, loopEnd: sameTrack ? loopEnd : nil)
    playbackTask?.cancel()
    playbackAsset?.cancelLoading()
    playbackAsset = nil
    playbackPinTask?.cancel()
    playbackPinTask = nil
    playbackBridge.cancel()
    playbackOperation = request.operation
    teardownPlayer()
    playing = false
    currentTrack = Self.reconciledTrack(track, candidates: tracks)
    compare = original
    preparingOriginal = original
    let localVocalAvailable =
      !original && track.path.flatMap { validatedVocalPath($0.path) } != nil
    playbackPreparation = localVocalAvailable ? .preparing : .downloading
    playbackClock.update(
      position: request.position,
      duration: original ? (track.sourceDuration ?? track.duration) : track.duration)
    failure = nil
    notice = nil
    if !sameTrack {
      playbackTimelineVariant = original ? .original : .voice
      silenceTask?.cancel()
      silenceTask = nil
      silenceRanges = []
      skipSilence = false
      analyzingSilence = false
      loopStart = nil
      loopEnd = nil
      sleepTask?.cancel()
      sleepTask = nil
      let bookmarkKey = bookmarkPreferenceKey(track.id, original: original)
      bookmarks = (UserDefaults.standard.array(forKey: bookmarkKey) as? [Double] ?? []).filter {
        $0.isFinite && $0 >= 0
      }.prefix(100).sorted()
    }
    let task = Task { await preparePlayback(track, original: original, request: request) }
    playbackTask = task
    let started = await withTaskCancellationHandler {
      await task.value
    } onCancel: {
      task.cancel()
    }
    if playbackOperation == request.operation {
      playbackTask = nil
      if task.isCancelled { stop() }
    }
    return started
  }
  private func preparePlayback(
    _ track: DesktopTrack, original: Bool, request: DesktopPlaybackRequest
  ) async -> Bool {
    let fence = request.scope
    let operation = request.operation
    let sameTrack = request.sameTrack
    var acquiredPin: URL?
    var acquiredTemporary: URL?
    defer {
      if playbackOperation == operation {
        playbackPinTask = nil
        preparingOriginal = false
      }
      if let acquiredPin { try? FileManager.default.removeItem(at: acquiredPin) }
      if let acquiredTemporary { try? FileManager.default.removeItem(at: acquiredTemporary) }
    }
    do {
      try Task.checkCancellation()
      var oldPosition = request.position
      var mappedBookmarks = request.bookmarks
      var mappedLoopStart = request.loopStart
      var mappedLoopEnd = request.loopEnd
      if sameTrack, request.priorVariant.isOriginal != original, let jobID = track.jobId,
        Self.validJobID(jobID)
      {
        let metadata: DesktopJSON
        if let cached = cloudJobs.first(where: { $0["id"].string == jobID }) {
          metadata = cached
        } else {
          metadata = try await account.api("GET", "/jobs/\(jobID)")
        }
        guard account.scope == fence else { throw DesktopAuthFailure.sessionChanged }
        oldPosition = try DesktopComparison.position(
          request.position, toOriginal: original, job: metadata)
        mappedBookmarks = try request.bookmarks.map {
          try DesktopComparison.position($0, toOriginal: original, job: metadata)
        }
        if let loopStart = request.loopStart {
          mappedLoopStart = try DesktopComparison.position(
            loopStart, toOriginal: original, job: metadata)
        }
        if let loopEnd = request.loopEnd {
          mappedLoopEnd = try DesktopComparison.position(
            loopEnd, toOriginal: original, job: metadata)
        }
      }
      guard account.scope == fence, playbackOperation == operation, !Task.isCancelled else {
        return false
      }
      if sameTrack {
        playbackTimelineVariant = original ? .original : .voice
        playbackClock.update(position: oldPosition)
        bookmarks = mappedBookmarks
        loopStart = mappedLoopStart
        loopEnd = mappedLoopEnd
      }
      let url: URL
      var expectedDuration = original ? (track.sourceDuration ?? track.duration) : track.duration
      if original {
        guard track.originalAvailable, let job = track.jobId, Self.validJobID(job) else {
          throw DesktopAuthFailure.service("ORIGINAL_NOT_AVAILABLE")
        }
        let session = try await nativeSession()
        guard account.scope == fence, playbackOperation == operation, !Task.isCancelled else {
          return false
        }
        let result = try await playbackBridge.request(
          type: "LIBRARY_ORIGINAL_PLAYBACK", payload: .object(["job_id": .string(job)]),
          session: session)
        guard account.scope == fence, let path = result["original_path"].string,
          let valid = validatedOriginalPath(path),
          let preparedDuration = result["duration_seconds"].number,
          preparedDuration.isFinite, preparedDuration > 0,
          result["cache_hit"].bool != nil
        else { throw DesktopAuthFailure.malformedResponse }
        acquiredTemporary = valid
        expectedDuration = preparedDuration
        url = valid
      } else if let path = track.path, let valid = validatedVocalPath(path.path) {
        let support = playbackSupport
        let task = Task {
          try await DesktopPlaybackPin.protect(
            track: track, support: support, owner: fence?.firebaseUid)
        }
        playbackPinTask = task
        acquiredPin = try await withTaskCancellationHandler {
          try await task.value
        } onCancel: {
          task.cancel()
        }
        if playbackOperation == operation { playbackPinTask = nil }
        url = valid
      } else if let job = track.jobId, Self.validJobID(job) {
        let grant = try await account.api(
          "POST", "/jobs/\(job)/download-grants",
          body: .object([
            "artifact": .string("output"),
            "request_id": .string(UUID().uuidString.lowercased()),
          ]))
        guard account.scope == fence, let value = grant["url"].string,
          let candidate = URL(string: value), candidate.scheme == "https",
          candidate.user == nil, candidate.password == nil
        else { throw DesktopAuthFailure.malformedResponse }
        url = candidate
      } else {
        throw DesktopAuthFailure.service(
          original ? "ORIGINAL_NOT_AVAILABLE" : "DESKTOP_PLAYBACK_START_FAILED")
      }
      guard account.scope == fence else { throw DesktopAuthFailure.sessionChanged }
      guard playbackOperation == operation, !Task.isCancelled else { return false }
      playbackPreparation = url.isFileURL ? .preparing : .downloading
      let asset: AVURLAsset
      if let playbackAssetLoader {
        asset = try await playbackAssetLoader(url)
      } else {
        asset = AVURLAsset(url: url)
      }
      guard account.scope == fence, playbackOperation == operation, !Task.isCancelled else {
        asset.cancelLoading()
        return false
      }
      playbackAsset = asset
      guard try await asset.load(.isPlayable) else {
        throw DesktopAuthFailure.service("DESKTOP_AUDIO_PLAYBACK_FAILED")
      }
      let measured = try await asset.load(.duration).seconds
      guard account.scope == fence, playbackOperation == operation, !Task.isCancelled else {
        return false
      }
      if measured.isFinite, measured > 0 { expectedDuration = measured }
      let item = AVPlayerItem(asset: asset)
      let instance = AVPlayer(playerItem: item)
      if oldPosition > 0 {
        await instance.seek(to: CMTime(seconds: oldPosition, preferredTimescale: 600))
      }
      guard account.scope == fence, playbackOperation == operation, !Task.isCancelled else {
        return false
      }
      playbackAsset = nil
      Self.applyPlaybackVolume(playbackVolume, to: instance)
      let resumePlayback = request.resumePlayback
      teardownPlayer()
      playbackPin = acquiredPin
      acquiredPin = nil
      playbackTemporary = acquiredTemporary
      acquiredTemporary = nil
      currentTrack = Self.reconciledTrack(track, candidates: tracks)
      if sameTrack {
        bookmarks = mappedBookmarks.filter { $0.isFinite && $0 >= 0 }.prefix(100).sorted()
        UserDefaults.standard.set(
          bookmarks,
          forKey: bookmarkPreferenceKey(track.id, original: original))
        loopStart = mappedLoopStart
        loopEnd = mappedLoopEnd
      }
      playbackClock.update(
        position: max(0, min(expectedDuration, oldPosition)), duration: expectedDuration)
      compare = original
      player = instance
      playbackPreparation = item.status == .readyToPlay ? nil : .preparing
      playbackStatus = item.observe(\.status, options: [.initial, .new]) {
        [weak self] item, _ in
        Task { @MainActor in
          guard let self, self.player === instance else { return }
          if item.status == .failed {
            self.teardownPlayer()
            self.playing = false
            self.playbackPreparation = .failed(.audioFailed)
            self.recordPlaybackFailure(.audioFailed)
          } else if item.status == .readyToPlay {
            self.playbackPreparation =
              instance.timeControlStatus == .waitingToPlayAtSpecifiedRate ? .buffering : nil
          }
        }
      }
      playbackWaiting = instance.observe(\.timeControlStatus, options: [.new]) {
        [weak self] _, _ in
        Task { @MainActor in
          guard let self, self.player === instance, item.status == .readyToPlay else { return }
          self.playbackPreparation =
            instance.timeControlStatus == .waitingToPlayAtSpecifiedRate ? .buffering : nil
        }
      }
      periodicObserver = instance.addPeriodicTimeObserver(
        forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main
      ) { [weak self] time in
        Task { @MainActor in
          guard let self, self.player === instance else { return }
          let value = time.seconds
          if value.isFinite { self.playbackClock.update(position: value) }
          if let end = self.loopEnd, let start = self.loopStart, value >= end {
            self.seek(start)
          } else if self.skipSilence, !self.compare,
            let range = self.silenceRanges.first(where: {
              value >= $0.start && value < $0.end - 0.04
            })
          {
            self.seek(min(range.end, self.loopEnd ?? range.end))
          }
          let measured = instance.currentItem?.duration.seconds ?? 0
          if measured.isFinite && measured > 0 {
            self.playbackClock.update(duration: measured)
          }
        }
      }
      endObserver = NotificationCenter.default.addObserver(
        forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
      ) { [weak self] _ in
        Task { @MainActor in
          guard let self, self.player === instance else { return }
          await self.next()
        }
      }
      if resumePlayback { instance.playImmediately(atRate: Float(rate)) }
      playing = resumePlayback
      failure = nil
      return true
    } catch {
      guard account.scope == fence, playbackOperation == operation, !Task.isCancelled else {
        return false
      }
      let errorCode = (error as? DesktopAuthFailure)?.code
      let code: DesktopPlaybackFailure =
        errorCode == "CACHE_PIN_UNAVAILABLE"
        ? .cachePinUnavailable
        : errorCode == "ORIGINAL_NOT_AVAILABLE"
          ? .originalUnavailable
          : errorCode == "DESKTOP_AUDIO_PLAYBACK_FAILED" ? .audioFailed : .startFailed
      playbackAsset = nil
      playbackPreparation = .failed(code)
      playing = false
      recordPlaybackFailure(code)
      return false
    }
  }
  var preparingPlayback: Bool { playbackPreparation?.loading == true }
  var canControlPlayback: Bool { player != nil && !preparingPlayback }
  func retryPlayback() async {
    guard case .failed = playbackPreparation, let currentTrack else { return }
    await play(currentTrack, original: compare)
  }
  func recordPlaybackFailure(_ code: DesktopPlaybackFailure) {
    notice = nil
    failure = code.message
    journal?.record(.appOperationError, code: code.rawValue)
  }
  func togglePlayback() {
    guard canControlPlayback, let player else { return }
    if playing { player.pause() } else { player.playImmediately(atRate: Float(rate)) }
    playing.toggle()
  }
  func changeRate(_ value: Double) {
    guard value.isFinite, (0.25...3).contains(value) else { return }
    rate = value
    if playing { player?.rate = Float(value) }
  }
  var position: Double { playbackClock.position }
  var duration: Double { playbackClock.duration }
  var playbackVolume: DesktopPlaybackVolume { playbackVolumeState.value }
  var volume: Double { playbackVolume.level }
  var muted: Bool { playbackVolume.muted }
  func previewVolume(_ value: Double) {
    var next = playbackVolume
    next.setLevel(value)
    updatePlaybackVolume(next, persist: false)
  }
  func setVolume(_ value: Double) {
    var next = playbackVolume
    next.setLevel(value)
    updatePlaybackVolume(next, persist: true)
  }
  func adjustVolume(by delta: Double) {
    var next = playbackVolume
    next.adjust(by: delta)
    updatePlaybackVolume(next, persist: true)
  }
  func toggleMute() {
    var next = playbackVolume
    next.toggleMute()
    updatePlaybackVolume(next, persist: true)
  }
  static func applyPlaybackVolume(_ volume: DesktopPlaybackVolume, to player: AVPlayer) {
    player.volume = Float(volume.level)
    player.isMuted = volume.muted
  }
  func commitPlaybackVolume() { persistPlaybackVolume(playbackVolume) }
  private func updatePlaybackVolume(_ value: DesktopPlaybackVolume, persist: Bool) {
    guard value != playbackVolume else { return }
    playbackVolumeState.update(value)
    if persist { persistPlaybackVolume(value) }
    if let player { Self.applyPlaybackVolume(value, to: player) }
  }
  private func persistPlaybackVolume(_ value: DesktopPlaybackVolume) {
    preferences.set(value.level, forKey: DesktopPreferenceKey.playbackVolume)
    preferences.set(value.muted, forKey: DesktopPreferenceKey.playbackMuted)
    preferences.set(
      value.lastAudibleLevel, forKey: DesktopPreferenceKey.playbackLastAudibleVolume)
  }
  func seek(_ value: Double) {
    guard canControlPlayback, value.isFinite else { return }
    let target = max(0, min(duration, value))
    playbackClock.update(position: target)
    player?.seek(to: CMTime(seconds: target, preferredTimescale: 600))
  }
  func compareOriginal() async {
    guard !preparingPlayback, let currentTrack else { return }
    if !compare, !currentTrack.originalAvailable { return }
    await play(currentTrack, original: !compare)
  }
  var originalPlaying: Bool { compare }
  var canCompareOriginal: Bool { originalPlaying || currentTrack?.originalAvailable == true }
  private func teardownPlayer() {
    if let periodicObserver { player?.removeTimeObserver(periodicObserver) }
    periodicObserver = nil
    if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
    endObserver = nil
    playbackStatus?.invalidate()
    playbackStatus = nil
    playbackWaiting?.invalidate()
    playbackWaiting = nil
    player?.pause()
    player = nil
    if let playbackPin { try? FileManager.default.removeItem(at: playbackPin) }
    playbackPin = nil
    if let playbackTemporary { try? FileManager.default.removeItem(at: playbackTemporary) }
    playbackTemporary = nil
  }
  func stop() {
    playbackOperation = nil
    playbackTask?.cancel()
    playbackTask = nil
    playbackAsset?.cancelLoading()
    playbackAsset = nil
    playbackPinTask?.cancel()
    playbackPinTask = nil
    playbackBridge.cancel()
    preparingOriginal = false
    playbackPreparation = nil
    silenceTask?.cancel()
    silenceTask = nil
    silenceRanges = []
    skipSilence = false
    analyzingSilence = false
    loopStart = nil
    loopEnd = nil
    bookmarks = []
    sleepTask?.cancel()
    sleepTask = nil
    teardownPlayer()
    playing = false
    playbackClock.reset()
    currentTrack = nil
  }
  func next() async {
    let selectedQueueIndex = shuffle && !queue.isEmpty ? Int.random(in: 0..<queue.count) : 0
    let advance = DesktopPlaybackAdvance.next(
      repeatMode: repeatMode, hasCurrent: currentTrack != nil,
      currentVariant: compare ? .original : .voice,
      queueCount: queue.count, selectedQueueIndex: selectedQueueIndex)
    switch advance {
    case .pause:
      player?.pause()
      playing = false
    case .replayCurrent(let variant):
      guard let currentTrack else {
        player?.pause()
        playing = false
        return
      }
      seek(0)
      await play(
        currentTrack, original: variant.isOriginal && currentTrack.originalAvailable)
    case .playQueued(let index, let requeueCurrent, let variant):
      let track = queue.remove(at: index)
      if requeueCurrent, let currentTrack { queue.append(currentTrack) }
      await play(track, original: variant.isOriginal && track.originalAvailable)
    }
  }
  func sleep(after seconds: Double) {
    sleepTask?.cancel()
    sleepTask = nil
    guard seconds > 0 else { return }
    sleepTask = Task { @MainActor in
      do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
      self.player?.pause()
      self.playing = false
    }
  }
  func markLoopStart() {
    loopStart = position
    if let loopEnd, loopEnd <= position { self.loopEnd = nil }
  }
  func markLoopEnd() { if let loopStart, position > loopStart + 0.1 { loopEnd = position } }
  func clearLoop() {
    loopStart = nil
    loopEnd = nil
  }
  func addBookmark() {
    guard let currentTrack else { return }
    if !bookmarks.contains(where: { abs($0 - position) < 0.5 }) {
      bookmarks.append(position)
      bookmarks = Array(bookmarks.sorted().prefix(100))
    }
    UserDefaults.standard.set(
      bookmarks,
      forKey: bookmarkPreferenceKey(currentTrack.id, original: compare))
  }
  func removeBookmark(_ value: Double) {
    guard let currentTrack else { return }
    bookmarks.removeAll { $0 == value }
    UserDefaults.standard.set(
      bookmarks,
      forKey: bookmarkPreferenceKey(currentTrack.id, original: compare))
  }
  private func bookmarkPreferenceKey(_ trackID: String, original: Bool) -> String {
    preferenceKey(
      "bookmarks-\(trackID)\(original ? "-original" : "")", account.firebaseUid ?? "local")
  }
  func setSkipSilence(_ value: Bool) async {
    guard let track = currentTrack, let path = track.path, !compare else { return }
    if !value {
      skipSilence = false
      silenceTask?.cancel()
      return
    }
    guard let valid = validatedVocalPath(path.path) else {
      failure = "Keep this voice offline to skip silence."
      return
    }
    let fence = account.scope
    analyzingSilence = true
    let task = Task.detached(priority: .utility) { try DesktopSilenceAnalysis.ranges(url: valid) }
    silenceTask = task
    defer { if currentTrack?.id == track.id { analyzingSilence = false } }
    do {
      let ranges = try await task.value
      guard currentTrack?.id == track.id, account.scope == fence, !compare, !task.isCancelled else {
        return
      }
      silenceRanges = ranges
      skipSilence = true
    } catch is CancellationError {} catch {
      if currentTrack?.id == track.id { failure = "Silence skipping could not prepare this voice." }
    }
  }
  func rename(_ track: DesktopTrack, title: String) async {
    guard let id = track.jobId, Self.validJobID(id) else {
      failure = "Rename is available after this voice is saved to your account."
      return
    }
    do {
      _ = try await account.api(
        "PATCH", "/jobs/\(id)", body: .object(["display_name": .string(title)]))
    } catch { failure = (error as? DesktopAuthFailure)?.message ?? "Rename failed." }
  }
  func deleteCloud(_ track: DesktopTrack) async {
    guard let id = track.jobId, Self.validJobID(id) else { return }
    do {
      _ = try await account.api("DELETE", "/jobs/\(id)")
      if currentTrack?.id == track.id { stop() }
    } catch { failure = (error as? DesktopAuthFailure)?.message ?? "Deletion failed." }
  }
  func export(_ track: DesktopTrack) {
    guard let path = track.path, let valid = validatedVocalPath(path.path) else {
      failure = "Save this voice offline before exporting."
      return
    }
    let panel = NSSavePanel()
    panel.nameFieldStringValue = "\(track.title).\(valid.pathExtension)"
    guard panel.runModal() == .OK, let destination = panel.url else { return }
    do { try FileManager.default.copyItem(at: valid, to: destination) } catch {
      failure = "The voice could not be exported. Choose a new file name or another folder."
    }
  }
  func share(_ track: DesktopTrack) {
    guard let path = track.path, let valid = validatedVocalPath(path.path) else {
      failure = "Save this voice offline before sharing."
      return
    }
    NSSharingServicePicker(items: [valid]).show(
      relativeTo: .zero, of: NSApp.keyWindow?.contentView ?? NSView(), preferredEdge: .minY)
  }
  func shutdown() {
    shuttingDown = true
    commitPlaybackVolume()
    bridge.cancel()
    syncBridge.cancel()
    playbackBridge.cancel()
    stopReceiptWatchers()
    syncOperation = nil
    syncRequested = false
    socketLoop?.cancel()
    socket?.cancel(with: .goingAway, reason: nil)
    cloudConnected = false
    librarySnapshotReadiness.reset()
    stop()
  }
  private func connectCloud() {
    guard socketLoop == nil, let fence = account.scope else { return }
    socketLoop = Task { @MainActor in
      var attempts = 0
      while !Task.isCancelled, self.account.scope == fence {
        do {
          try await self.receiveCloud(fence)
          attempts = 0
        } catch {
          if self.account.scope == fence {
            self.cloudConnected = false
            self.librarySnapshotReadiness.reset()
          }
          if self.account.scope == fence, let failure = error as? DesktopAuthFailure,
            [
              .service("UNAUTHENTICATED"), .service("ACCOUNT_DISABLED"),
              .service("ACCOUNT_DELETION_PENDING"),
            ].contains(failure)
          {
            self.cloudJobs = []
            self.usage = .null
            self.failure = failure.message
            break
          }
        }
        guard !Task.isCancelled, self.account.scope == fence else { break }
        attempts += 1
        do {
          try await Task.sleep(
            for: .seconds(Double.random(in: 1...min(30, pow(2, Double(min(attempts, 5)))))))
        } catch { break }
      }
    }
  }
  private func receiveCloud(_ fence: DesktopSessionScope) async throws {
    let ticket = try await account.api("POST", "/realtime-tickets", body: .object([:]))
    guard account.scope == fence, let token = ticket["ticket"].string,
      token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
      ticket["protocol"].string == "musicmute.realtime.v1",
      let path = ticket["path"].string, path.hasPrefix("/"), !path.hasPrefix("//"),
      !path.contains("?"), !path.contains("#"),
      let config = account.configuration, var url = URLComponents(string: config.backendBaseURL)
    else { throw DesktopAuthFailure.malformedResponse }
    url.scheme = "wss"
    url.path = path
    guard let endpoint = url.url else { throw DesktopAuthFailure.configuration }
    let configSession = URLSessionConfiguration.ephemeral
    configSession.httpShouldSetCookies = false
    configSession.urlCache = nil
    let session = URLSession(
      configuration: configSession, delegate: DesktopSocketRedirect(), delegateQueue: nil)
    let connection = session.webSocketTask(
      with: endpoint, protocols: ["musicmute.realtime.v1", "ticket.\(token)"])
    socket = connection
    defer {
      session.invalidateAndCancel()
      if socket === connection {
        socket = nil
        cloudConnected = false
        librarySnapshotReadiness.reset()
      }
    }
    streamId = nil
    sequences = [:]
    nextCursor = nil
    connection.maximumMessageSize = 2 * 1024 * 1024
    lastFrameAt = Date()
    readyAt = nil
    jobsSubscriptionID = nil
    jobsCursor = nil
    jobSnapshotRequestedAt = nil
    librarySnapshotReadiness.reset()
    let openedAt = Date()
    connection.resume()
    let watchdog = Task { @MainActor in
      while !Task.isCancelled, self.socket === connection {
        do { try await Task.sleep(for: .seconds(5)) } catch { return }
        let idle = Date().timeIntervalSince(self.lastFrameAt)
        let missingFirstSnapshot =
          self.jobSnapshotRequestedAt.map {
            Date().timeIntervalSince($0) > 15
              && self.jobsSubscriptionID.flatMap { self.sequences[$0] } == nil
          } ?? false
        if (self.streamId == nil && Date().timeIntervalSince(openedAt) > 10) || idle > 65
          || missingFirstSnapshot
        {
          connection.cancel(with: .goingAway, reason: nil)
          return
        }
      }
    }
    defer { watchdog.cancel() }
    while !Task.isCancelled, account.scope == fence {
      let frame = try await connection.receive()
      let data: Data
      switch frame {
      case .data(let bytes): data = bytes
      case .string(let string): data = Data(string.utf8)
      @unknown default: throw DesktopAuthFailure.malformedResponse
      }
      guard data.count <= 2 * 1024 * 1024 else { throw DesktopAuthFailure.malformedResponse }
      let event = try JSONDecoder().decode(DesktopJSON.self, from: data)
      lastFrameAt = Date()
      guard account.scope == fence else { throw DesktopAuthFailure.sessionChanged }
      let type = event["type"].string
      if type == "ready" {
        guard streamId == nil, event["protocol_version"].number == 1,
          let id = event["stream_id"].string, !id.isEmpty, id.count <= 128
        else { throw DesktopAuthFailure.malformedResponse }
        streamId = id
        cloudConnected = true
        readyAt = Date()
        try await subscribeJobs()
        try await sendSocket(
          .object([
            "type": .string("subscribe"), "subscription_id": .string("desktop-usage"),
            "resource": .string("usage"), "params": .object([:]),
          ]))
        try await sendSocket(
          .object([
            "type": .string("subscribe"), "subscription_id": .string("desktop-policy"),
            "resource": .string("policy"), "params": .object([:]),
          ]))
      } else if type == "ping" {
        try await sendSocket(.object(["type": .string("pong")]))
      } else if type == "snapshot" {
        guard event["protocol_version"].number == 1, let currentStreamID = streamId,
          event["stream_id"].string == currentStreamID,
          let id = event["subscription_id"].string,
          let sequence = event["sequence"].number, sequence > 0
        else { throw DesktopAuthFailure.malformedResponse }
        let previous = sequences[id] ?? 0
        guard id == jobsSubscriptionID || id == "desktop-usage" || id == "desktop-policy" else {
          continue
        }
        if sequence <= previous { continue }
        if previous > 0 && sequence != previous + 1 {
          sequences[id] = nil
          try await sendSocket(
            .object(["type": .string("resync"), "subscription_id": .string(id)]))
          continue
        }
        sequences[id] = sequence
        if id == jobsSubscriptionID {
          let page = try Self.cloudJobsPage(event["data"])
          cloudJobs = page.rows
          nextCursor = page.nextCursor
          cloudHasMore = nextCursor != nil
          reconcilePlaybackMetadata()
          librarySnapshotReadiness.jobsSnapshotReceived(
            scope: fence, streamID: currentStreamID)
        } else if id == "desktop-usage" {
          usage = event["data"]
        } else if id == "desktop-policy" {
          account.receivePolicy(event["data"])
        }
      } else if type == "subscription_error" {
        throw DesktopAuthFailure.service(event["code"].string ?? "REALTIME_UNAVAILABLE")
      } else {
        throw DesktopAuthFailure.malformedResponse
      }
    }
  }
  private func sendSocket(_ value: DesktopJSON) async throws {
    guard let socket else { throw DesktopAuthFailure.service("REALTIME_UNAVAILABLE") }
    try await socket.send(.string(String(decoding: try JSONEncoder().encode(value), as: UTF8.self)))
  }
  nonisolated static func cloudJobsPage(_ value: DesktopJSON) throws -> DesktopCloudJobsPage {
    guard case .object(let data) = value, case .array(let rows)? = data["items"],
      let cursorValue = data["next_cursor"],
      cursorValue == .null || cursorValue.string != nil, rows.count <= 50
    else { throw DesktopAuthFailure.malformedResponse }
    return DesktopCloudJobsPage(rows: rows, nextCursor: cursorValue.string)
  }
  private func subscribeJobs(cursor: String? = nil) async throws {
    guard let scope = account.scope, let currentStreamID = streamId else {
      throw DesktopAuthFailure.sessionChanged
    }
    var params: [String: DesktopJSON] = ["limit": .string("50"), "status": .string("ready")]
    if let cursor { params["cursor"] = .string(cursor) }
    if let previous = jobsSubscriptionID {
      try await sendSocket(
        .object(["type": .string("unsubscribe"), "subscription_id": .string(previous)]))
      sequences[previous] = nil
    }
    let id = "desktop-jobs-\(UUID().uuidString.lowercased())"
    jobsSubscriptionID = id
    jobSnapshotRequestedAt = Date()
    librarySnapshotReadiness.jobsSubscriptionRequested(scope: scope, streamID: currentStreamID)
    try await sendSocket(
      .object([
        "type": .string("subscribe"), "subscription_id": .string(id), "resource": .string("jobs"),
        "params": .object(params),
      ]))
    jobsCursor = cursor
  }
  func nextCloudPage() async {
    do { if let nextCursor { try await subscribeJobs(cursor: nextCursor) } } catch {
      failure = "The next library page could not be loaded."
    }
  }
  static func validJobID(_ value: String) -> Bool {
    value.range(of: "^[0-9a-f]{24}$", options: .regularExpression) != nil
  }
}

enum DesktopComparison {
  static func position(_ seconds: Double, toOriginal: Bool, job: DesktopJSON) throws -> Double {
    guard seconds.isFinite else { throw DesktopAuthFailure.malformedResponse }
    if job["trim_enabled"].bool == false { return max(0, seconds) }
    let ranges = job["comparison_ranges"].array
    guard !ranges.isEmpty, ranges.count <= 100_000 else {
      throw DesktopAuthFailure.service("COMPARISON_TIMELINE_UNAVAILABLE")
    }
    let sample = max(0, seconds) * 44_100
    var previousEnd = 0.0
    var outputStart = 0.0
    for range in ranges {
      let values = range.array
      guard values.count == 2, let start = values[0].number, let end = values[1].number,
        start.rounded() == start, end.rounded() == end, start >= previousEnd, end > start,
        end <= 52_920_000
      else { throw DesktopAuthFailure.malformedResponse }
      let length = end - start
      if toOriginal && sample < outputStart + length {
        return (start + max(0, sample - outputStart)) / 44_100
      }
      if !toOriginal && sample < end {
        return (outputStart + min(length, max(0, sample - start))) / 44_100
      }
      previousEnd = end
      outputStart += length
    }
    return (toOriginal ? previousEnd : outputStart) / 44_100
  }
}

enum DesktopPlaybackPin {
  // The companion's pruner uses the same hard-link lease. Validate, pin and touch
  // the managed entry while owning it; an earlier path lookup is not protection.
  static func protect(track: DesktopTrack, support: URL, owner: String?) async throws -> URL {
    let task = Task.detached(priority: .userInitiated) {
      let deadline = ContinuousClock.now.advanced(by: .seconds(3))
      while true {
        try Task.checkCancellation()
        do { return try protectNow(track: track, support: support, owner: owner) } catch let error
          as DesktopAuthFailure where error.code == "LOCAL_COMPANION_BUSY"
        {
          guard ContinuousClock.now < deadline else {
            throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE")
          }
          try await Task.sleep(for: .milliseconds(50))
        } catch is CancellationError {
          throw CancellationError()
        } catch {
          throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE")
        }
      }
    }
    return try await withTaskCancellationHandler {
      try await task.value
    } onCancel: {
      task.cancel()
    }
  }
  #if MUSICMUTE_NATIVE_TESTS
    static func protectForTesting(
      track: DesktopTrack, support: URL, owner: String? = nil,
      afterPin: (() throws -> Void)? = nil
    ) throws -> URL {
      try protectNow(track: track, support: support, owner: owner, afterPin: afterPin)
    }
    static func withMutationForTesting<T>(support: URL, operation: () throws -> T) throws -> T {
      try withMutation(support: support) { _ in try operation() }
    }
  #endif
  private static func protectNow(
    track: DesktopTrack, support: URL, owner: String?, afterPin: (() throws -> Void)? = nil
  ) throws -> URL {
    try withMutation(support: support) { cacheDescriptor in
      let output = support.appendingPathComponent("cache/vocals/\(track.id)/vocals.mp3")
      guard DiagnosticIdentity.validDigest(track.id), track.path?.path == output.path else {
        throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE")
      }
      let vocals = try directory(cacheDescriptor, "vocals")
      defer { _ = close(vocals) }
      let entry = try directory(vocals, track.id)
      defer { _ = close(entry) }
      let metadata = try file(entry, "result.json", maximum: 16 * 1024)
      defer { _ = close(metadata) }
      let manifest = try JSONDecoder().decode(
        DesktopJSON.self, from: boundedRead(metadata, maximum: 16 * 1024))
      guard manifest["output_path"].string == output.path,
        let bytes = manifest["bytes"].number, bytes.rounded() == bytes, bytes > 0,
        bytes <= 60 * 1024 * 1024,
        track.bytes == 0 || Double(track.bytes) == bytes,
        let digest = manifest["sha256"].string, DiagnosticIdentity.validDigest(digest),
        let duration = manifest["duration_seconds"].number, duration.isFinite, duration > 0,
        abs(duration - track.duration) <= 0.25
      else { throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE") }
      if manifest["owner_uid"] != .null {
        guard let retainedOwner = manifest["owner_uid"].string, !retainedOwner.isEmpty,
          retainedOwner.utf16.count <= 128,
          retainedOwner.range(of: #"\p{Cc}"#, options: .regularExpression) == nil
        else { throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE") }
        if retainedOwner != owner {
          guard manifest["account_job_id"] == .null,
            manifest["source"]["kind"].string == "youtube",
            let video = manifest["source"]["video_id"].string, video == track.sourceVideoId,
            video.range(of: #"\A[A-Za-z0-9_-]{11}\z"#, options: .regularExpression) != nil
          else { throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE") }
        }
      }
      let audio = try file(entry, "vocals.mp3", maximum: Int64(bytes))
      defer { _ = close(audio) }
      var before = stat()
      guard fstat(audio, &before) == 0, before.st_size == Int64(bytes) else {
        throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE")
      }
      let handle = FileHandle(fileDescriptor: audio, closeOnDealloc: false)
      var checksum = SHA256()
      var readBytes: Int64 = 0
      while let chunk = try handle.read(upToCount: 128 * 1024), !chunk.isEmpty {
        try Task.checkCancellation()
        readBytes += Int64(chunk.count)
        guard readBytes <= Int64(bytes) else {
          throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE")
        }
        checksum.update(data: chunk)
      }
      var after = stat()
      guard fstat(audio, &after) == 0, sameFile(before, after),
        before.st_size == after.st_size,
        before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
        before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
        checksum.finalize().map({ String(format: "%02x", $0) }).joined() == digest
      else { throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE") }
      try verifyNamed(entry, "vocals.mp3", descriptor: audio)
      try verifyNamed(vocals, track.id, descriptor: entry)
      try Task.checkCancellation()
      let pin = try create(
        cacheKey: track.id, cacheDescriptor: cacheDescriptor,
        directory: support.appendingPathComponent("cache/pins"), beforeDirectoryCreation: nil)
      do {
        guard futimens(entry, nil) == 0, fsync(entry) == 0 else {
          throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE")
        }
        try afterPin?()
        return pin
      } catch {
        try? FileManager.default.removeItem(at: pin)
        throw error
      }
    }
  }
  private static func withMutation<T>(support: URL, operation: (Int32) throws -> T) throws -> T {
    let supportDescriptor = open(support.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard supportDescriptor >= 0 else { throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE") }
    defer { _ = close(supportDescriptor) }
    try verify(supportDescriptor)
    let cache = try directory(supportDescriptor, "cache")
    defer { _ = close(cache) }
    let temporary = ".mutation-\(UUID().uuidString.lowercased()).tmp"
    let descriptor = openat(cache, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else { throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE") }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    var attributes = stat()
    var owned = false
    defer {
      try? handle.close()
      if owned {
        var named = stat()
        if fstatat(cache, ".mutation.lock", &named, AT_SYMLINK_NOFOLLOW) == 0,
          sameFile(named, attributes)
        {
          _ = unlinkat(cache, ".mutation.lock", 0)
        }
      }
      _ = unlinkat(cache, temporary, 0)
    }
    let value = DesktopJSON.object([
      "version": .number(1), "pid": .number(Double(getpid())),
      "nonce": .string(UUID().uuidString.lowercased()),
    ])
    try handle.write(contentsOf: JSONEncoder().encode(value))
    guard fsync(descriptor) == 0, fstat(descriptor, &attributes) == 0 else {
      throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE")
    }
    if linkat(cache, temporary, cache, ".mutation.lock", 0) != 0 {
      guard errno == EEXIST else { throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE") }
      let existing = try file(cache, ".mutation.lock", maximum: 256, maximumLinks: 2)
      defer { _ = close(existing) }
      var held = stat()
      guard fstat(existing, &held) == 0 else {
        throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE")
      }
      let record = try JSONDecoder().decode(
        DesktopJSON.self, from: boundedRead(existing, maximum: 256))
      guard record["version"].number == 1, let pid = record["pid"].number,
        pid.rounded() == pid, (1...2_147_483_647).contains(pid),
        let nonce = record["nonce"].string, UUID(uuidString: nonce) != nil
      else { throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE") }
      guard kill(pid_t(pid), 0) != 0, errno == ESRCH else {
        throw DesktopAuthFailure.service("LOCAL_COMPANION_BUSY")
      }
      try verifyNamed(cache, ".mutation.lock", descriptor: existing)
      guard unlinkat(cache, ".mutation.lock", 0) == 0 else {
        throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE")
      }
      guard linkat(cache, temporary, cache, ".mutation.lock", 0) == 0 else {
        throw DesktopAuthFailure.service("LOCAL_COMPANION_BUSY")
      }
    }
    owned = true
    _ = unlinkat(cache, temporary, 0)
    return try operation(cache)
  }
  private static func directory(_ parent: Int32, _ name: String) throws -> Int32 {
    let descriptor = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard descriptor >= 0 else { throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE") }
    do { try verify(descriptor) } catch {
      _ = close(descriptor)
      throw error
    }
    return descriptor
  }
  private static func file(
    _ parent: Int32, _ name: String, maximum: Int64, maximumLinks: UInt16 = 1
  ) throws -> Int32 {
    let descriptor = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    guard descriptor >= 0 else { throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE") }
    var info = stat()
    do {
      guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
        info.st_uid == geteuid(), info.st_mode & 0o077 == 0,
        info.st_nlink > 0, info.st_nlink <= maximumLinks, info.st_size > 0,
        info.st_size <= maximum
      else { throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE") }
      try verifyNamed(parent, name, descriptor: descriptor)
      return descriptor
    } catch {
      _ = close(descriptor)
      throw error
    }
  }
  private static func verifyNamed(_ parent: Int32, _ name: String, descriptor: Int32) throws {
    var opened = stat()
    var named = stat()
    guard fstat(descriptor, &opened) == 0,
      fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) == 0, sameFile(opened, named)
    else { throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE") }
  }
  private static func sameFile(_ first: stat, _ second: stat) -> Bool {
    first.st_ino == second.st_ino && first.st_dev == second.st_dev
      && first.st_mode == second.st_mode && first.st_uid == second.st_uid
      && first.st_nlink == second.st_nlink
  }
  private static func boundedRead(_ descriptor: Int32, maximum: Int) throws -> Data {
    var before = stat()
    guard fstat(descriptor, &before) == 0 else {
      throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE")
    }
    let data =
      try FileHandle(fileDescriptor: descriptor, closeOnDealloc: false).read(
        upToCount: maximum + 1) ?? Data()
    var after = stat()
    guard !data.isEmpty, data.count <= maximum, fstat(descriptor, &after) == 0,
      sameFile(before, after), before.st_size == after.st_size, data.count == after.st_size,
      before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
      before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec
    else {
      throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE")
    }
    return data
  }
  static func create(cacheKey: String, support: URL = LocalPaths.support) throws -> URL {
    try create(cacheKey: cacheKey, support: support, beforeDirectoryCreation: nil)
  }
  #if MUSICMUTE_NATIVE_TESTS
    static func createForTesting(
      cacheKey: String, support: URL, beforeDirectoryCreation: @escaping () throws -> Void
    ) throws -> URL {
      try create(
        cacheKey: cacheKey, support: support, beforeDirectoryCreation: beforeDirectoryCreation)
    }
  #endif
  private static func create(
    cacheKey: String, support: URL, beforeDirectoryCreation: (() throws -> Void)?
  ) throws -> URL {
    guard DiagnosticIdentity.validDigest(cacheKey) else {
      throw DesktopAuthFailure.malformedResponse
    }
    let cache = support.appendingPathComponent("cache", isDirectory: true)
    let supportDescriptor = open(support.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard supportDescriptor >= 0 else { throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE") }
    defer { _ = close(supportDescriptor) }
    try verify(supportDescriptor)
    let cacheDescriptor = openat(supportDescriptor, "cache", O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard cacheDescriptor >= 0 else { throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE") }
    defer { _ = close(cacheDescriptor) }
    try verify(cacheDescriptor)
    return try create(
      cacheKey: cacheKey, cacheDescriptor: cacheDescriptor,
      directory: cache.appendingPathComponent("pins", isDirectory: true),
      beforeDirectoryCreation: beforeDirectoryCreation)
  }
  private static func create(
    cacheKey: String, cacheDescriptor: Int32, directory: URL,
    beforeDirectoryCreation: (() throws -> Void)?
  ) throws -> URL {
    var existing = stat()
    if fstatat(cacheDescriptor, "pins", &existing, AT_SYMLINK_NOFOLLOW) != 0 {
      guard errno == ENOENT else { throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE") }
      try beforeDirectoryCreation?()
      guard mkdirat(cacheDescriptor, "pins", 0o700) == 0 || errno == EEXIST else {
        throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE")
      }
    }
    let pinsDescriptor = openat(cacheDescriptor, "pins", O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard pinsDescriptor >= 0 else { throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE") }
    defer { _ = close(pinsDescriptor) }
    try verify(pinsDescriptor)
    let name = "playback-\(UUID().uuidString.lowercased())"
    let temporary = "\(name).tmp"
    let destination = directory.appendingPathComponent("\(name).json")
    let descriptor = openat(
      pinsDescriptor, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else { throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE") }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    do {
      let data = try JSONEncoder().encode(
        DesktopJSON.object([
          "version": .number(1), "cache_key": .string(cacheKey), "pid": .number(Double(getpid())),
        ]))
      try handle.write(contentsOf: data)
      guard fsync(descriptor) == 0 else {
        throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE")
      }
      try handle.close()
      guard renameat(pinsDescriptor, temporary, pinsDescriptor, destination.lastPathComponent) == 0,
        fsync(pinsDescriptor) == 0
      else { throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE") }
      return destination
    } catch {
      try? handle.close()
      _ = unlinkat(pinsDescriptor, temporary, 0)
      _ = unlinkat(pinsDescriptor, destination.lastPathComponent, 0)
      throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE")
    }
  }
  private static func verify(_ descriptor: Int32) throws {
    var attributes = stat()
    guard fstat(descriptor, &attributes) == 0, attributes.st_mode & S_IFMT == S_IFDIR,
      attributes.st_uid == geteuid(), attributes.st_mode & 0o077 == 0
    else { throw DesktopAuthFailure.service("CACHE_PIN_UNAVAILABLE") }
  }
}

private final class DesktopSocketRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
  ) { completionHandler(nil) }
}
