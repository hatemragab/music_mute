import AppKit
import Combine
import Darwin
import Foundation

/// The app controls the existing per-user worker; it never owns the LaunchAgent's lifetime.
enum DesktopWorkerCommand: String, CaseIterable, Sendable {
  case versions, adopt, recover, install, status, start, stop, restart, pause, drain, resume
  case update, uninstall, unpair, logs, job, errors, explain, perf, diagnostics, doctor, cleanup
  case capacity, benchmark
  case benchmarkFile = "benchmark-file"

  func requiresConfirmation(_ parameters: DesktopJSON) -> Bool {
    switch self {
    case .install, .recover, .unpair, .uninstall, .capacity, .benchmark, .benchmarkFile: true
    case .adopt, .cleanup: parameters["apply"].bool == true
    case .logs: parameters["clear"].bool == true
    case .update: parameters["check"].bool != true
    case .stop, .restart: parameters["force"].bool == true
    default: false
    }
  }
  func isCritical(_ parameters: DesktopJSON) -> Bool {
    switch self {
    case .versions, .status, .job, .errors, .explain, .perf, .doctor: false
    case .logs: parameters["clear"].bool == true
    case .adopt, .cleanup: parameters["apply"].bool == true
    case .update: parameters["check"].bool != true
    default: true
    }
  }
}

/// Closed command schemas mirror the worker's app-control-protocol.ts. No arbitrary CLI text.
struct DesktopWorkerRequest: Sendable {
  let command: DesktopWorkerCommand
  let parameters: DesktopJSON
  init(command: DesktopWorkerCommand, parameters: DesktopJSON, subscription: Bool = false) throws {
    guard case .object(let fields) = parameters else {
      throw DesktopWorkerFailure("INVALID_REQUEST")
    }
    let allowed: Set<String>
    let required: Set<String>
    switch command {
    case .versions, .recover, .pause, .drain, .resume:
      allowed = []
      required = []
    case .adopt:
      allowed = ["apply"]
      required = []
    case .install:
      allowed = ["label", "group_id", "enrollment_code", "new_code"]
      required = ["label"]
    case .status:
      allowed = ["local"]
      required = []
    case .start:
      allowed = ["wait_ready"]
      required = []
    case .stop, .restart, .unpair:
      allowed = ["force"]
      required = []
    case .update:
      allowed = ["check", "force", "source"]
      required = []
    case .uninstall:
      allowed = ["purge"]
      required = []
    case .logs:
      allowed = ["lines", "events", "errors", "clear", "attempt_id", "since", "level"]
      required = []
    case .job:
      allowed = ["job_id"]
      required = ["job_id"]
    case .errors:
      allowed = ["since", "limit"]
      required = []
    case .explain:
      allowed = ["code", "since"]
      required = ["code"]
    case .perf:
      allowed = ["last", "since", "recipe"]
      required = []
    case .diagnostics:
      allowed = ["job_id", "since", "output"]
      required = []
    case .doctor:
      allowed = ["full"]
      required = []
    case .cleanup:
      allowed = ["apply"]
      required = []
    case .capacity:
      allowed = ["workers"]
      required = ["workers"]
    case .benchmark:
      allowed = ["workers"]
      required = []
    case .benchmarkFile:
      allowed = [
        "input", "recipe", "warmup_runs", "runs", "group_size", "candidate_engine", "report",
        "save_audio_dir", "baseline_report",
      ]
      required = ["input"]
    }
    guard Set(fields.keys).isSubset(of: allowed), required.isSubset(of: Set(fields.keys))
    else { throw DesktopWorkerFailure("INVALID_REQUEST") }
    for (key, value) in fields {
      let valid: Bool
      switch key {
      case "local", "wait_ready", "force", "check", "purge", "events", "errors", "clear", "full",
        "apply", "new_code":
        valid = value.bool != nil
      case "label": valid = Self.text(value, maximum: 120)
      case "group_id": valid = Self.text(value, maximum: 100)
      case "enrollment_code": valid = Self.text(value, maximum: 4096)
      case "job_id":
        valid = value.string?.range(of: "^[0-9a-fA-F]{24}$", options: .regularExpression) != nil
      case "attempt_id":
        valid = value.string.map { UUID(uuidString: $0) != nil && $0.count == 36 } == true
      case "code": valid = value.string.map(DesktopWorkerFailure.safeCode) == true
      case "since": valid = value.string.map(Self.validSince) == true
      case "source": valid = value.string.map { ["app", "catalog"].contains($0) } == true
      case "level": valid = value.string.map { ["info", "warning", "error"].contains($0) } == true
      case "recipe":
        valid = value.string.map { ["kim-vocals-v2", "kim-vocals-v2-trim"].contains($0) } == true
      case "lines": valid = Self.integer(value, 1...1000)
      case "limit", "last": valid = Self.integer(value, 1...100)
      case "workers": valid = value.number.map { [1, 2].contains($0) } == true
      case "group_size": valid = value.number.map { [1, 2, 4].contains($0) } == true
      case "warmup_runs": valid = Self.integer(value, 0...2)
      case "runs": valid = Self.integer(value, 3...10)
      case "output", "input", "candidate_engine", "report", "save_audio_dir", "baseline_report":
        valid =
          Self.text(value, maximum: 4096)
          && value.string.map {
            $0.hasPrefix("/") && $0 != "/"
              && URL(fileURLWithPath: $0).standardizedFileURL.path == $0
          } == true
      default: valid = false
      }
      guard valid else { throw DesktopWorkerFailure("INVALID_REQUEST") }
    }
    if command == .update && parameters["check"].bool == true && parameters["force"].bool == true {
      throw DesktopWorkerFailure("INVALID_REQUEST")
    }
    if command == .logs {
      guard !(parameters["events"].bool == true && parameters["errors"].bool == true),
        !(parameters["clear"].bool == true && fields.count != 1),
        Set(fields.keys).isDisjoint(with: ["attempt_id", "since", "level"])
          || parameters["events"].bool == true || parameters["errors"].bool == true
      else { throw DesktopWorkerFailure("INVALID_REQUEST") }
    }
    guard
      !subscription
        || ((command == .status || command == .logs)
          && parameters["clear"].bool != true && parameters["local"].bool != false)
    else { throw DesktopWorkerFailure("INVALID_REQUEST") }
    self.command = command
    self.parameters = parameters
  }
  private static func text(_ value: DesktopJSON, maximum: Int) -> Bool {
    guard let text = value.string, !text.isEmpty, text.utf16.count <= maximum else { return false }
    return !text.unicodeScalars.contains { $0.value < 32 || $0.value == 127 }
  }
  private static func integer(_ value: DesktopJSON, _ range: ClosedRange<Int>) -> Bool {
    guard let number = value.number, number.rounded() == number else { return false }
    return number >= Double(range.lowerBound) && number <= Double(range.upperBound)
  }
  static func validSince(_ text: String) -> Bool {
    guard text.count <= 5,
      text.range(of: "^[1-9][0-9]*[smhd]$", options: .regularExpression) != nil,
      let magnitude = Double(text.dropLast()), let unit = text.last
    else { return false }
    let multiplier: Double = ["s": 1, "m": 60, "h": 3600, "d": 86400][String(unit)] ?? 0
    return magnitude * multiplier <= 30 * 86400
  }
}

struct DesktopWorkerFailure: Error, Sendable, Equatable {
  let code: String
  init(_ code: String) {
    self.code = Self.safeCode(code) ? code : "WORKER_OPERATION_FAILED"
  }
  static func safeCode(_ code: String) -> Bool {
    code.range(of: "^[A-Z][A-Z0-9_]{0,95}$", options: .regularExpression) != nil
  }
  var guidance: String {
    switch code {
    case "WORKER_UPDATE_REQUIRED":
      "Update the existing worker to a release compatible with shared processing, then try moving it into the app again."
    case "APP_WORKER_RECOVERY_REQUIRED":
      "Recover the interrupted app-managed worker migration before making another worker change."
    case "RUNTIME_CONSUMER_REFERENCE_INVALID":
      "A worker runtime reference could not be verified. Run Worker Doctor and recover the worker installation before preparing a different runtime."
    case "APP_RUNTIME_NOT_PREPARED", "APP_RUNTIME_INCOMPATIBLE", "WORKER_RUNTIME_UNAVAILABLE":
      "Prepare your Mac in Setup before opening Worker controls."
    case "WORKER_PERSONAL_BUSY":
      "Finish or cancel personal app or Chrome audio before running worker maintenance."
    case "NOT_INSTALLED":
      "Pair this Mac in Worker setup or recover an existing worker installation."
    case "MAINTENANCE_RECOVERY_REQUIRED":
      "Recover the interrupted worker operation before making another change."
    case "BACKEND_UNAVAILABLE":
      "The backend connection is unavailable. Accepted work and local state remain on this Mac."
    case "INVALID_REQUEST": "Review the worker fields and filters before trying again."
    case "ENROLLMENT_REQUIRED", "WORKER_ENROLLMENT_REQUIRED":
      "Enter a new worker enrollment code from your administrator."
    case "COMMAND_BUSY", "WORKER_OPERATION_BUSY", "APP_OPERATION_BUSY":
      "Wait for the current worker operation to finish."
    case "WORKER_SUBSCRIPTION_CLOSED":
      "The local connection ended. Reconnect to see current worker status."
    case "WORKER_CONTROL_INVALID_RESPONSE", "WORKER_CONTROL_OUTPUT_LIMIT":
      "The worker returned an invalid response. Reconnect or check the worker installation."
    case "WORKER_CONFIRMATION_REQUIRED": "Review and confirm this worker action first."
    default:
      "The worker operation could not finish. Run Worker health checks for safe recovery guidance."
    }
  }
}

struct DesktopWorkerFrame: Sendable, Equatable {
  enum Kind: String, Sendable {
    case result = "RESULT"
    case snapshot = "SNAPSHOT"
    case progress = "PROGRESS"
    case error = "ERROR"
  }
  let kind: Kind
  let payload: DesktopJSON
  let errorCode: String?
  static func decode(_ data: Data, requestID: String) throws -> Self {
    guard !data.isEmpty, data.count <= 4 * 1024 * 1024 + 1024,
      let value = try? JSONDecoder().decode(DesktopJSON.self, from: data),
      case .object(let fields) = value,
      Set(fields.keys).isSubset(of: [
        "protocol_version", "request_id", "type", "payload", "error_code",
      ]),
      value["protocol_version"].number == 1, value["request_id"].string == requestID,
      let type = value["type"].string, let kind = Kind(rawValue: type)
    else { throw DesktopWorkerFailure("WORKER_CONTROL_INVALID_RESPONSE") }
    if kind == .error {
      guard let code = value["error_code"].string, DesktopWorkerFailure.safeCode(code)
      else { throw DesktopWorkerFailure("WORKER_CONTROL_INVALID_RESPONSE") }
      return Self(kind: kind, payload: .null, errorCode: code)
    }
    guard case .object = value["payload"], Self.bounded(value["payload"], depth: 0)
    else { throw DesktopWorkerFailure("WORKER_CONTROL_INVALID_RESPONSE") }
    return Self(kind: kind, payload: value["payload"], errorCode: nil)
  }
  private static func bounded(_ value: DesktopJSON, depth: Int) -> Bool {
    guard depth <= 16 else { return false }
    switch value {
    case .object(let fields):
      return fields.count <= 256
        && fields.allSatisfy {
          $0.key.utf8.count <= 128 && bounded($0.value, depth: depth + 1)
        }
    case .array(let values):
      return values.count <= 2000 && values.allSatisfy { bounded($0, depth: depth + 1) }
    case .string(let text): return text.utf8.count <= 2 * 1024 * 1024
    case .number(let value): return value.isFinite && abs(value) <= 9_007_199_254_740_991
    default: return true
    }
  }
}

struct DesktopWorkerSnapshot: Sendable, Equatable {
  let raw: DesktopJSON
  init(_ raw: DesktopJSON) throws {
    guard case .object = raw, raw["installed"].bool != nil,
      raw["service"]["running"].bool != nil, raw["service"]["loaded"].bool != nil,
      let phase = raw["readiness"]["phase"].string, Self.safeIdentifier(phase),
      case .array = raw["readiness"]["blockers"], case .array = raw["runtime"]["currentAttempts"],
      raw["readiness"]["blockers"].array.allSatisfy({ $0.string.map(Self.safeIdentifier) == true })
    else { throw DesktopWorkerFailure("WORKER_CONTROL_INVALID_RESPONSE") }
    self.raw = raw
  }
  static func safeIdentifier(_ value: String) -> Bool {
    value.range(of: "^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,127}$", options: .regularExpression) != nil
  }
  var installed: Bool { raw["installed"].bool == true }
  var running: Bool { raw["service"]["running"].bool == true }
  var phase: String { raw["readiness"]["phase"].string ?? "unknown" }
  var blockers: [String] { raw["readiness"]["blockers"].array.compactMap(\.string) }
  var jobs: [DesktopJSON] { raw["runtime"]["currentAttempts"].array }
}

/// Generation fences protect a reopened subscription from a late frame from its predecessor.
struct DesktopWorkerGeneration: Sendable {
  private(set) var value: UInt64 = 0
  mutating func advance() -> UInt64 {
    value &+= 1
    return value
  }
  func accepts(_ candidate: UInt64) -> Bool { candidate == value }
}

private final class WorkerOutputBudget: @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0
  func exceeded(_ additional: Int) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    count += additional
    return count > 2 * 1024 * 1024
  }
}

@MainActor final class DesktopWorkerProcess {
  private let resources: URL?
  private let support: URL
  private let coordinator: RuntimeVerificationCoordinator
  private var task: Process?
  private var reader: Task<Void, Never>?
  private var writer: Task<Void, Never>?
  private var deadline: Task<Void, Never>?
  private var waiter: Task<Void, Never>?
  private var lease: RuntimeVerifiedRuntime?
  private var generation = DesktopWorkerGeneration()
  private var onEnd: ((DesktopWorkerFailure?) -> Void)?
  private(set) var running = false
  private var opening = false
  private var openingWaiters: [CheckedContinuation<Void, Never>] = []

  init(
    resources: URL?, support: URL = LocalPaths.support,
    coordinator: RuntimeVerificationCoordinator = .shared
  ) {
    self.resources = resources
    self.support = support
    self.coordinator = coordinator
  }
  func open(
    command: DesktopWorkerCommand, parameters: DesktopJSON, subscription: Bool,
    onFrame: @escaping (DesktopWorkerFrame) -> Void,
    onEnd: @escaping (DesktopWorkerFailure?) -> Void
  ) async throws {
    guard !Task.isCancelled else { throw DesktopWorkerFailure("WORKER_OPERATION_CANCELLED") }
    if opening { await waitUntilClosed() }
    if let waiter { await waiter.value }
    guard !Task.isCancelled else { throw DesktopWorkerFailure("WORKER_OPERATION_CANCELLED") }
    guard !running else { throw DesktopWorkerFailure("WORKER_OPERATION_BUSY") }
    guard let resources else { throw DesktopWorkerFailure("WORKER_RUNTIME_UNAVAILABLE") }
    _ = try DesktopWorkerRequest(
      command: command, parameters: parameters, subscription: subscription)
    let id = UUID().uuidString.lowercased()
    let bytes =
      try JSONEncoder().encode(
        DesktopJSON.object([
          "protocol_version": .number(1), "request_id": .string(id),
          "type": .string(subscription ? "SUBSCRIBE" : "COMMAND"),
          "command": .string(command.rawValue), "parameters": parameters,
        ])) + Data([10])
    guard bytes.count <= 65_536 else { throw DesktopWorkerFailure("WORKER_REQUEST_TOO_LARGE") }
    running = true
    opening = true
    defer {
      opening = false
      let waiters = openingWaiters
      openingWaiters.removeAll()
      for waiter in waiters { waiter.resume() }
    }
    let token = generation.advance()
    self.onEnd = onEnd
    do {
      let coordinator = coordinator
      let support = support
      let resolved = try await Task.detached(priority: .userInitiated) {
        try coordinator.installedRuntime(resources: resources, support: support)
      }.value
      guard generation.accepts(token), running, !Task.isCancelled else { return }
      guard let resolved else { throw DesktopWorkerFailure("APP_RUNTIME_NOT_PREPARED") }
      lease = resolved
      let runtime = resolved.runtimeRoot
      let node = runtime.appendingPathComponent("runtime/node/bin/node")
      let entry = resources.appendingPathComponent("worker/controller.js")
      guard FileManager.default.isExecutableFile(atPath: node.path),
        FileManager.default.fileExists(atPath: entry.path),
        let launch = BundledControlLaunch.command(
          resources: resources, runtime: runtime, arguments: [entry.path])
      else { throw DesktopWorkerFailure("WORKER_RUNTIME_UNAVAILABLE") }
      let process = Process()
      let input = Pipe()
      let output = Pipe()
      let errors = Pipe()
      _ = fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)
      process.executableURL = launch.executable
      process.arguments = launch.arguments
      process.currentDirectoryURL = resources
      process.environment = [
        "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
        "PATH": "\(node.deletingLastPathComponent().path):/usr/bin:/bin:/usr/sbin:/sbin",
        "LANG": "en_US.UTF-8", "TMPDIR": NSTemporaryDirectory(),
        "MUSICMUTE_LOCAL_APP_RESOURCES": resources.path,
        "MUSICMUTE_LOCAL_ROOT": support.path,
      ]
      process.standardInput = input
      process.standardOutput = output
      process.standardError = errors
      task = process
      let budget = WorkerOutputBudget()
      errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
        let data = handle.availableData
        if data.isEmpty { handle.readabilityHandler = nil }
        if budget.exceeded(data.count) {
          Task { @MainActor in
            guard let self, self.generation.accepts(token) else { return }
            self.stop(DesktopWorkerFailure("WORKER_CONTROL_OUTPUT_LIMIT"))
          }
        }
      }
      try process.run()
      reader = Task { @MainActor [weak self] in
        guard let self else { return }
        var total = 0
        var pending = Data()
        var terminal: DesktopWorkerFrame?
        do {
          for try await byte in output.fileHandleForReading.bytes {
            guard self.generation.accepts(token), !Task.isCancelled else { break }
            total += 1
            guard pending.count < 4 * 1024 * 1024 + 1024, subscription || total <= 16 * 1024 * 1024
            else { throw DesktopWorkerFailure("WORKER_CONTROL_OUTPUT_LIMIT") }
            if byte != 10 {
              pending.append(byte)
              continue
            }
            let frame = try DesktopWorkerFrame.decode(pending, requestID: id)
            pending.removeAll(keepingCapacity: true)
            guard terminal == nil else {
              throw DesktopWorkerFailure("WORKER_CONTROL_INVALID_RESPONSE")
            }
            if frame.kind == .error {
              throw DesktopWorkerFailure(frame.errorCode ?? "WORKER_OPERATION_FAILED")
            }
            if subscription {
              guard frame.kind == .snapshot else {
                throw DesktopWorkerFailure("WORKER_CONTROL_INVALID_RESPONSE")
              }
              self.deadline?.cancel()
              self.deadline = nil
              onFrame(frame)
            } else if frame.kind == .result {
              terminal = frame
            } else if frame.kind == .progress {
              onFrame(frame)
            } else {
              throw DesktopWorkerFailure("WORKER_CONTROL_INVALID_RESPONSE")
            }
          }
          guard self.generation.accepts(token), !Task.isCancelled else { return }
          guard pending.isEmpty else {
            throw DesktopWorkerFailure("WORKER_CONTROL_INVALID_RESPONSE")
          }
          while process.isRunning { try await Task.sleep(for: .milliseconds(20)) }
          guard process.terminationStatus == 0 else {
            throw DesktopWorkerFailure("WORKER_CONTROL_PROCESS_EXITED")
          }
          if subscription { throw DesktopWorkerFailure("WORKER_SUBSCRIPTION_CLOSED") }
          guard let terminal else { throw DesktopWorkerFailure("WORKER_CONTROL_RESULT_MISSING") }
          onFrame(terminal)
          self.finish(nil, token: token)
        } catch {
          guard self.generation.accepts(token) else { return }
          self.stop(
            error as? DesktopWorkerFailure
              ?? DesktopWorkerFailure("WORKER_CONTROL_INVALID_RESPONSE"))
        }
        errors.fileHandleForReading.readabilityHandler = nil
      }
      writer = Task.detached { [weak self] in
        do {
          try input.fileHandleForWriting.write(contentsOf: bytes)
          // Subscription keeps stdin open. EOF is its graceful disconnect signal.
          if !subscription { try input.fileHandleForWriting.close() }
        } catch {
          await self?.inputFailed(token)
        }
      }
      if subscription {
        deadline = Task { @MainActor [weak self] in
          do { try await Task.sleep(for: .seconds(30)) } catch { return }
          guard let self, self.generation.accepts(token) else { return }
          self.stop(DesktopWorkerFailure("WORKER_CONTROL_TIMEOUT"))
        }
      } else {
        deadline = Task { @MainActor [weak self] in
          do { try await Task.sleep(for: .seconds(7200)) } catch { return }
          guard let self, self.generation.accepts(token) else { return }
          self.stop(DesktopWorkerFailure("WORKER_CONTROL_TIMEOUT"))
        }
      }
    } catch {
      guard generation.accepts(token) else { return }
      let failure =
        (error as? DesktopWorkerFailure)
        ?? (error as? RuntimeBootstrapFailure).map { DesktopWorkerFailure($0.errorCode) }
        ?? DesktopWorkerFailure("WORKER_CONTROL_START_FAILED")
      stop(failure)
    }
  }
  private func inputFailed(_ token: UInt64) {
    guard generation.accepts(token) else { return }
    stop(DesktopWorkerFailure("WORKER_CONTROL_INPUT_FAILED"))
  }
  func waitUntilClosed() async {
    if opening {
      await withCheckedContinuation { openingWaiters.append($0) }
    }
    if let waiter { await waiter.value }
  }
  /// Terminates only the disposable controller. The fleet service remains independent.
  func close() { stop(nil) }
  private func stop(_ failure: DesktopWorkerFailure?) {
    guard running, waiter == nil else { return }
    reader?.cancel()
    writer?.cancel()
    deadline?.cancel()
    let token = generation.advance()
    guard let task, task.isRunning else {
      finish(failure, token: token)
      return
    }
    task.terminate()
    waiter = Task { @MainActor [weak self] in
      guard let self else { return }
      let limit = ContinuousClock.now.advanced(by: .seconds(3))
      while task.isRunning && ContinuousClock.now < limit {
        do { try await Task.sleep(for: .milliseconds(20)) } catch { return }
      }
      if task.isRunning, task.processIdentifier > 0 { kill(task.processIdentifier, SIGKILL) }
      while task.isRunning {
        do { try await Task.sleep(for: .milliseconds(20)) } catch { return }
      }
      self.finish(failure, token: token)
    }
  }
  private func finish(_ failure: DesktopWorkerFailure?, token: UInt64) {
    guard generation.accepts(token) else { return }
    let callback = onEnd
    onEnd = nil
    running = false
    task = nil
    reader = nil
    writer = nil
    deadline?.cancel()
    deadline = nil
    waiter = nil
    // Release both app-update and runtime/setup leases only after controller exit.
    lease = nil
    callback?(failure)
  }
}

@MainActor protocol DesktopWorkerTransport: AnyObject {
  func execute(
    _ command: DesktopWorkerCommand, parameters: DesktopJSON,
    progress: @escaping (DesktopJSON) -> Void
  ) async throws -> DesktopJSON
  func subscribe(
    _ command: DesktopWorkerCommand, parameters: DesktopJSON,
    snapshot: @escaping (DesktopJSON) -> Void,
    ended: @escaping (DesktopWorkerFailure?) -> Void) async throws
  func closeSubscriptions()
  func waitUntilSubscriptionsClose() async
}

@MainActor final class DesktopWorkerBridge: DesktopWorkerTransport {
  private let operation: DesktopWorkerProcess
  private let status: DesktopWorkerProcess
  private let logs: DesktopWorkerProcess
  init(resources: URL?, support: URL = LocalPaths.support) {
    operation = DesktopWorkerProcess(resources: resources, support: support)
    status = DesktopWorkerProcess(resources: resources, support: support)
    logs = DesktopWorkerProcess(resources: resources, support: support)
  }
  func execute(
    _ command: DesktopWorkerCommand, parameters: DesktopJSON,
    progress: @escaping (DesktopJSON) -> Void
  ) async throws -> DesktopJSON {
    var result: DesktopJSON?
    return try await withCheckedThrowingContinuation { continuation in
      Task { @MainActor in
        do {
          try await operation.open(
            command: command, parameters: parameters, subscription: false,
            onFrame: { frame in
              if frame.kind == .result {
                result = frame.payload
              } else if frame.kind == .progress {
                progress(frame.payload)
              }
            },
            onEnd: { failure in
              if let failure {
                continuation.resume(throwing: failure)
              } else if let result {
                continuation.resume(returning: result)
              } else {
                continuation.resume(throwing: DesktopWorkerFailure("WORKER_CONTROL_RESULT_MISSING"))
              }
            })
        } catch { continuation.resume(throwing: error) }
      }
    }
  }
  func subscribe(
    _ command: DesktopWorkerCommand, parameters: DesktopJSON,
    snapshot: @escaping (DesktopJSON) -> Void,
    ended: @escaping (DesktopWorkerFailure?) -> Void
  ) async throws {
    let process = command == .logs ? logs : status
    try await process.open(
      command: command, parameters: parameters, subscription: true,
      onFrame: { snapshot($0.payload) }, onEnd: ended)
  }
  func closeSubscriptions() {
    status.close()
    logs.close()
  }
  func waitUntilSubscriptionsClose() async {
    await status.waitUntilClosed()
    await logs.waitUntilClosed()
  }
}

@MainActor final class DesktopWorkerModel: ObservableObject {
  @Published private(set) var snapshot: DesktopWorkerSnapshot?
  @Published private(set) var connected = false
  @Published private(set) var busy = false
  @Published private(set) var currentCommand: DesktopWorkerCommand?
  @Published private(set) var report: DesktopJSON = .null
  @Published private(set) var reportCommand: DesktopWorkerCommand?
  @Published private(set) var logReport: DesktopJSON = .null
  @Published private(set) var progress: DesktopJSON = .null
  @Published private(set) var failure: DesktopWorkerFailure?
  private let transport: any DesktopWorkerTransport
  private let fixture: Bool
  private var generation = DesktopWorkerGeneration()
  private var operationGeneration = DesktopWorkerGeneration()
  private var visible = false
  private var suspendedLogParameters: DesktopJSON?
  private var observation: Task<Void, Never>?
  private var logsObservation: Task<Void, Never>?
  var isCriticalOperation = false
  var canOperate: (() -> Bool)?

  init(resources: URL?, fixture: Bool = false, transport: (any DesktopWorkerTransport)? = nil) {
    self.fixture = fixture
    self.transport = transport ?? DesktopWorkerBridge(resources: resources)
  }
  func applyPreview() {
    guard fixture else { return }
    snapshot = try? DesktopWorkerSnapshot(
      .object([
        "installed": .bool(true), "lifecycle": .string("active"),
        "activeReleaseVersion": .string("fixture.1"),
        "service": .object(["running": .bool(true), "loaded": .bool(true)]),
        "readiness": .object([
          "phase": .string("processing"), "modelReady": .bool(true), "localReady": .bool(false),
          "claimEligible": .null, "blockers": .array([.string("capacity-full")]),
        ]),
        "runtime": .object([
          "currentAttempts": .array([
            .object([
              "jobId": .string("000000000000000000000001"),
              "attemptId": .string("00000000-0000-4000-8000-000000000001"),
              "stage": .string("separating"),
              "work": .object([
                "completed": .number(24), "total": .number(40), "unit": .string("windows"),
              ]),
            ])
          ])
        ]),
      ]))
    connected = true
  }
  func show() {
    visible = true
    guard !fixture, !connected, observation == nil, canOperate?() != false else { return }
    let token = generation.advance()
    observation = Task { @MainActor [weak self] in
      guard let self else { return }
      do {
        try await transport.subscribe(
          .status, parameters: .object([:]),
          snapshot: { [weak self] payload in
            guard let self, self.generation.accepts(token), self.visible else { return }
            do {
              self.snapshot = try DesktopWorkerSnapshot(payload)
              self.connected = true
              self.failure = nil
            } catch {
              self.connected = false
              self.failure = DesktopWorkerFailure("WORKER_CONTROL_INVALID_RESPONSE")
              self.transport.closeSubscriptions()
            }
          },
          ended: { [weak self] error in
            guard let self, self.generation.accepts(token) else { return }
            self.connected = false
            self.observation = nil
            if self.visible {
              self.failure = error ?? DesktopWorkerFailure("WORKER_SUBSCRIPTION_CLOSED")
            }
          })
      } catch {
        guard generation.accepts(token) else { return }
        failure =
          error as? DesktopWorkerFailure ?? DesktopWorkerFailure("WORKER_CONTROL_START_FAILED")
        connected = false
        observation = nil
      }
    }
  }
  func hide() {
    visible = false
    _ = generation.advance()
    connected = false
    observation?.cancel()
    observation = nil
    logsObservation?.cancel()
    logsObservation = nil
    transport.closeSubscriptions()
  }
  var observing: Bool { observation != nil || logsObservation != nil }
  func suspendSubscriptions() async {
    hide()
    await transport.waitUntilSubscriptionsClose()
  }
  func resumeSubscriptionsAfterSuspension() {
    if let suspendedLogParameters {
      subscribeLogsAfterOpening(suspendedLogParameters)
    } else {
      show()
    }
  }
  func reconnect() {
    hide()
    resumeSubscriptionsAfterSuspension()
  }
  func subscribeLogs(parameters: DesktopJSON) {
    guard visible, !fixture, canOperate?() != false else { return }
    suspendedLogParameters = parameters
    subscribeLogsAfterOpening(parameters)
  }
  private func subscribeLogsAfterOpening(_ parameters: DesktopJSON) {
    guard !fixture, canOperate?() != false else { return }
    // Replace both subscriptions to fence old filters and recover atomically.
    hide()
    show()
    let token = generation.value
    logsObservation = Task { @MainActor [weak self] in
      guard let self else { return }
      do {
        try await transport.subscribe(
          .logs, parameters: parameters,
          snapshot: { [weak self] payload in
            guard let self, self.generation.accepts(token), self.visible else { return }
            self.logReport = payload
          },
          ended: { [weak self] error in
            guard let self, self.generation.accepts(token) else { return }
            self.logsObservation = nil
            if let error { self.failure = error }
          })
      } catch {
        guard generation.accepts(token) else { return }
        failure =
          error as? DesktopWorkerFailure ?? DesktopWorkerFailure("WORKER_CONTROL_START_FAILED")
        logsObservation = nil
      }
    }
  }
  func run(
    _ command: DesktopWorkerCommand, parameters: DesktopJSON = .object([:]), confirmed: Bool = false
  ) async {
    guard !fixture, !busy, canOperate?() != false else {
      failure = DesktopWorkerFailure("WORKER_OPERATION_BUSY")
      return
    }
    guard !command.requiresConfirmation(parameters) || confirmed else {
      failure = DesktopWorkerFailure("WORKER_CONFIRMATION_REQUIRED")
      return
    }
    do { _ = try DesktopWorkerRequest(command: command, parameters: parameters) } catch {
      failure = DesktopWorkerFailure("INVALID_REQUEST")
      return
    }
    busy = true
    currentCommand = command
    progress = .null
    failure = nil
    isCriticalOperation = command.isCritical(parameters)
    let token = operationGeneration.advance()
    defer {
      busy = false
      currentCommand = nil
      isCriticalOperation = false
      progress = .null
    }
    do {
      let result = try await transport.execute(command, parameters: parameters) {
        [weak self] payload in
        guard let self, self.operationGeneration.accepts(token) else { return }
        self.progress = payload
      }
      guard operationGeneration.accepts(token) else { return }
      if command == .status || (command == .adopt && parameters["apply"].bool != true) {
        snapshot = try DesktopWorkerSnapshot(result)
      }
      report = result
      reportCommand = command
    } catch {
      failure = error as? DesktopWorkerFailure ?? DesktopWorkerFailure("WORKER_OPERATION_FAILED")
    }
  }
}
