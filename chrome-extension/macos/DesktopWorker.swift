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
    case .stop, .restart:
      allowed = ["force"]
      required = []
    case .unpair:
      allowed = ["force", "expected_machine_id", "deleted_only"]
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
        "apply", "new_code", "deleted_only":
        valid = value.bool != nil
      case "label": valid = Self.text(value, maximum: 120)
      case "group_id": valid = Self.text(value, maximum: 100)
      case "enrollment_code": valid = Self.text(value, maximum: 4096)
      case "job_id":
        valid = value.string?.range(of: "^[0-9a-fA-F]{24}$", options: .regularExpression) != nil
      case "attempt_id":
        valid = value.string.map { UUID(uuidString: $0) != nil && $0.count == 36 } == true
      case "expected_machine_id":
        valid =
          value.string?.range(
            of:
              "^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-4[a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$",
            options: .regularExpression) != nil
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
    if command == .unpair, fields["expected_machine_id"] != nil || fields["deleted_only"] != nil {
      guard fields["expected_machine_id"]?.string != nil, fields["deleted_only"]?.bool == true,
        fields["force"]?.bool != true
      else { throw DesktopWorkerFailure("INVALID_REQUEST") }
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
      "The existing worker needs a compatible release. Review Worker health and updates."
    case "APP_WORKER_RECOVERY_REQUIRED":
      "Recover the interrupted app-managed worker migration before making another worker change."
    case "RUNTIME_CONSUMER_REFERENCE_INVALID":
      "A worker runtime reference could not be verified. Run Worker Doctor and recover the worker installation before preparing a different runtime."
    case "APP_RUNTIME_NOT_PREPARED", "APP_RUNTIME_INCOMPATIBLE", "WORKER_RUNTIME_UNAVAILABLE":
      "Prepare your Mac in Setup before opening Worker controls."
    case "WORKER_PERSONAL_BUSY":
      "Finish or cancel personal app or Chrome audio before running worker maintenance."
    case "NOT_INSTALLED":
      "Open Worker setup to check registration or restore a preserved installation."
    case "MAINTENANCE_RECOVERY_REQUIRED":
      "Recover the interrupted worker operation before making another change."
    case "BACKEND_UNAVAILABLE":
      "The backend connection is unavailable. Accepted work and local state remain on this Mac."
    case "WORKER_UNAUTHENTICATED":
      "The backend rejected this worker’s credentials. Review this machine in the dashboard. Account approval does not replace an existing worker."
    case "WORKER_DELETION_CONFIRMATION_REQUIRED", "WORKER_DELETION_RECOVERY_REQUIRED":
      "The deleted worker registration could not be retired safely. Check the backend connection and worker health. Models and history are preserved."
    case "INVALID_REQUEST": "Review the worker fields and filters before trying again."
    case "ENROLLMENT_REQUIRED", "WORKER_ENROLLMENT_REQUIRED":
      "Worker registration could not resume. Check administrator approval and retry registration."
    case "ENROLLMENT_FAILED":
      "Worker registration was refused or could not complete. Retry the preserved installation, or review Worker health."
    case "WORKER_REGISTRATION_NOT_ALLOWED", "WORKER_REGISTRATION_FORBIDDEN":
      "Administrator approval is required to register this Mac."
    case "WORKER_REGISTRATION_GOOGLE_REQUIRED", "GOOGLE_SIGN_IN_REQUIRED":
      "Sign in with Google to register this Mac."
    case "WORKER_LOCAL_STATE_UNSAFE":
      "The existing worker installation could not be safely inspected. Review Worker health before making changes."
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

/// Each pipe publishes bounded chunks from its own readiness callback. Foundation's async
/// byte iterator can block other pipe readers behind an open subscription on macOS.
private final class WorkerPipeReader: @unchecked Sendable {
  let stream: AsyncThrowingStream<Data, Error>
  private let continuation: AsyncThrowingStream<Data, Error>.Continuation
  private let handle: FileHandle
  private let lock = NSLock()
  private var finished = false

  init(_ handle: FileHandle) {
    self.handle = handle
    (stream, continuation) = AsyncThrowingStream.makeStream(
      bufferingPolicy: .bufferingOldest(128))
    continuation.onTermination = { [weak self] _ in self?.close() }
    handle.readabilityHandler = { [weak self] handle in self?.read(handle) }
  }
  private func read(_ handle: FileHandle) {
    lock.lock()
    guard !finished else {
      lock.unlock()
      return
    }
    var bytes = Data(count: 65_536)
    let count = bytes.withUnsafeMutableBytes { buffer in
      var count: Int
      repeat {
        count = Darwin.read(handle.fileDescriptor, buffer.baseAddress, buffer.count)
      } while count < 0 && errno == EINTR
      return count
    }
    if count < 0 {
      finished = true
      lock.unlock()
      handle.readabilityHandler = nil
      continuation.finish(throwing: DesktopWorkerFailure("WORKER_CONTROL_INVALID_RESPONSE"))
    } else {
      bytes.count = count
      if bytes.isEmpty {
        finished = true
        lock.unlock()
        handle.readabilityHandler = nil
        continuation.finish()
      } else {
        let result = continuation.yield(bytes)
        if case .dropped = result {
          finished = true
          lock.unlock()
          handle.readabilityHandler = nil
          continuation.finish(throwing: DesktopWorkerFailure("WORKER_CONTROL_OUTPUT_LIMIT"))
        } else {
          lock.unlock()
        }
      }
    }
  }
  func close() {
    lock.lock()
    let wasFinished = finished
    finished = true
    lock.unlock()
    guard !wasFinished else { return }
    handle.readabilityHandler = nil
    continuation.finish()
  }
}

@MainActor final class DesktopWorkerProcess {
  private let resources: URL?
  private let support: URL
  private let coordinator: RuntimeVerificationCoordinator
  private var task: Process?
  private var reader: Task<Void, Never>?
  private var outputReader: WorkerPipeReader?
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
      let outputReader = WorkerPipeReader(output.fileHandleForReading)
      self.outputReader = outputReader
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
          for try await bytes in outputReader.stream {
            guard self.generation.accepts(token), !Task.isCancelled else { break }
            total += bytes.count
            guard subscription || total <= 16 * 1024 * 1024 else {
              throw DesktopWorkerFailure("WORKER_CONTROL_OUTPUT_LIMIT")
            }
            for byte in bytes {
              guard pending.count < 4 * 1024 * 1024 + 1024 else {
                throw DesktopWorkerFailure("WORKER_CONTROL_OUTPUT_LIMIT")
              }
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
    outputReader?.close()
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
    outputReader?.close()
    outputReader = nil
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

/// Presence checks distinguish explicit removal from Stop without reading any credential bytes.
/// The controller remains responsible for validating, recovering and changing this installation.
enum DesktopWorkerInstallation: Sendable, Equatable {
  case fresh, interrupted, activationRecovery, unpaired, deletionRecovery
  case registered(serviceInstalled: Bool)

  static func inspect(home: URL = FileManager.default.homeDirectoryForCurrentUser) throws -> Self {
    let root = home.appendingPathComponent("Library/Application Support/MusicMuteWorker")
    func metadata(_ path: String, link: Bool = false) throws -> stat? {
      let url = root.appendingPathComponent(path)
      var current = home
      let relative = url.deletingLastPathComponent().path.dropFirst(home.path.count)
      for part in relative.split(separator: "/") {
        current.appendPathComponent(String(part))
        var info = stat()
        if lstat(current.path, &info) != 0 {
          if errno == ENOENT { return nil }
          throw DesktopWorkerFailure("WORKER_LOCAL_STATE_UNSAFE")
        }
        guard (info.st_mode & S_IFMT) == S_IFDIR, (info.st_mode & 0o022) == 0 else {
          throw DesktopWorkerFailure("WORKER_LOCAL_STATE_UNSAFE")
        }
      }
      var info = stat()
      if lstat(url.path, &info) != 0 {
        if errno == ENOENT { return nil }
        throw DesktopWorkerFailure("WORKER_LOCAL_STATE_UNSAFE")
      }
      guard info.st_uid == getuid(), link || (info.st_mode & 0o022) == 0,
        (info.st_mode & S_IFMT) == (link ? S_IFLNK : S_IFREG)
      else { throw DesktopWorkerFailure("WORKER_LOCAL_STATE_UNSAFE") }
      if link {
        let target = try FileManager.default.destinationOfSymbolicLink(atPath: url.path)
        guard
          target.range(
            of: "^releases/[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$",
            options: .regularExpression) != nil
        else { throw DesktopWorkerFailure("WORKER_LOCAL_STATE_UNSAFE") }
      } else if info.st_size < 1 || info.st_size > 4 * 1024 * 1024 {
        throw DesktopWorkerFailure("WORKER_LOCAL_STATE_UNSAFE")
      }
      return info
    }
    func deletionPhase() throws -> String? {
      let path = "state/deleted-registration.json"
      guard let info = try metadata(path) else { return nil }
      let descriptor = open(root.appendingPathComponent(path).path, O_RDONLY | O_NOFOLLOW)
      guard descriptor >= 0 else { throw DesktopWorkerFailure("WORKER_LOCAL_STATE_UNSAFE") }
      let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
      defer { try? handle.close() }
      let date = ISO8601DateFormatter()
      date.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      var opened = stat()
      guard fstat(descriptor, &opened) == 0, opened.st_dev == info.st_dev,
        opened.st_ino == info.st_ino, opened.st_size == info.st_size,
        opened.st_mode & 0o077 == 0,
        let data = try handle.read(upToCount: Int(info.st_size) + 1),
        data.count == Int(info.st_size),
        let value = try? JSONDecoder().decode(DesktopJSON.self, from: data),
        case .object(let fields) = value,
        Set(fields.keys)
          == Set(["schemaVersion", "machineId", "confirmedAt", "archiveId", "phase", "entries"]),
        value["schemaVersion"].number == 1,
        let phase = value["phase"].string, ["archiving", "complete"].contains(phase),
        let machine = value["machineId"].string, DesktopWorkerModel.machineId(machine) != nil,
        let archive = value["archiveId"].string,
        DesktopWorkerModel.machineId(archive) != nil,
        let confirmed = value["confirmedAt"].string,
        date.date(from: confirmed) != nil || ISO8601DateFormatter().date(from: confirmed) != nil,
        case .array(let entries) = value["entries"], entries.count <= 256,
        Set(entries.compactMap { $0["path"].string }).count == entries.count,
        entries.allSatisfy({ entry in
          guard case .object(let attributes) = entry,
            Set(attributes.keys) == Set(["path", "dev", "ino", "directory"]),
            let path = entry["path"].string, path.utf8.count <= 256,
            !path.hasPrefix("/"), !path.split(separator: "/").contains(".."),
            entry["directory"].bool != nil,
            let device = entry["dev"].number, let inode = entry["ino"].number
          else { return false }
          let fixed = Set([
            "state/installation.json", "state/lifecycle.json", "state/runtime-status.json",
            "state/capacity-validation.json", "state/machine-deleted.json",
            "config/restart-budget.json", "state/transactions/install", "state/unpaired.json",
          ])
          let diagnostic =
            path.range(
              of:
                "^jobs/logs/(delivery\\.json|stream-id|history\\.json|events\\.jsonl|events-[0-9]{12}\\.jsonl|spool-full\\.marker)$",
              options: .regularExpression) != nil
          return (fixed.contains(path) || diagnostic)
            && [device, inode].allSatisfy {
              $0.isFinite && $0.rounded() == $0 && $0 >= 0 && $0 <= 9_007_199_254_740_991
            }
        })
      else { throw DesktopWorkerFailure("WORKER_LOCAL_STATE_UNSAFE") }
      return phase
    }
    if try metadata("state/app-activation.json") != nil { return .activationRecovery }
    if try metadata("state/transactions/install/enrollment.credential") != nil
      || metadata("state/transactions/install/finalization.json") != nil
    {
      return .interrupted
    }
    let deleted = try deletionPhase()
    if deleted == "archiving" { return .deletionRecovery }
    let config = try metadata("config/runtime.json") != nil
    let credential = try metadata("credentials/machine.credential") != nil
    if deleted == "complete" {
      let retained = try metadata("state/installation.json") != nil
      guard !config, !credential, !retained else {
        throw DesktopWorkerFailure("WORKER_LOCAL_STATE_UNSAFE")
      }
    }
    if config && credential {
      let current = try metadata("runtime/current", link: true) != nil
      let plist = home.appendingPathComponent("Library/LaunchAgents/com.musicmute.worker.plist")
      var info = stat()
      let found = lstat(plist.path, &info) == 0
      guard found || errno == ENOENT else {
        throw DesktopWorkerFailure("WORKER_LOCAL_STATE_UNSAFE")
      }
      if found {
        guard (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(),
          (info.st_mode & 0o022) == 0
        else { throw DesktopWorkerFailure("WORKER_LOCAL_STATE_UNSAFE") }
      }
      return .registered(serviceInstalled: current && found)
    }
    if config || credential { throw DesktopWorkerFailure("WORKER_LOCAL_STATE_UNSAFE") }
    if try metadata("state/transactions/install/.enrollment-state.json") != nil
      || metadata("state/transactions/install/installation-artifacts.json") != nil
    {
      return .interrupted
    }
    if try metadata("state/unpaired.json") != nil || metadata("state/installation.json") != nil {
      return .unpaired
    }
    return .fresh
  }
}

enum DesktopWorkerRegistrationState: Equatable {
  case checking, signedOut, googleRequired, waiting, unavailable, preparing
  case registered, preserved, interrupted, unpaired, removed, setupRequired
  case authenticationRejected, deletingRegistration
}

private struct DesktopWorkerRegistrationEvent: Equatable {
  let scope: DesktopSessionScope?
  let permission: Bool?
}

private enum DesktopWorkerDeletionPhase: String {
  case unpair, recover, permission
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
  @Published private(set) var registrationState = DesktopWorkerRegistrationState.checking
  @Published private(set) var deletedRegistrationObserved = false
  private(set) weak var account: DesktopAccountModel?
  private let transport: any DesktopWorkerTransport
  private let fixture: Bool
  private var generation = DesktopWorkerGeneration()
  private var operationGeneration = DesktopWorkerGeneration()
  private var visible = false
  private var suspendedLogParameters: DesktopJSON?
  private var observation: Task<Void, Never>?
  private var logsObservation: Task<Void, Never>?
  private let inspectInstallation: @Sendable () throws -> DesktopWorkerInstallation
  private let preferences: UserDefaults
  private static let pendingUIDKey = "worker.pendingRegistrationFirebaseUID"
  private static let removedKey = "worker.automaticRegistrationRemoved"
  private static let deletionKey = "worker.deletedMachineCleanup"
  private static let deletionTargetKey = "worker.deletedMachineTarget"
  private static let deletedObservedKey = "worker.deletedMachineObserved"
  private var registrationEvent: DesktopWorkerRegistrationEvent?
  private var checkedDeletionEvent: DesktopWorkerRegistrationEvent?
  private var deletionCleanupAttempted = false
  private var authenticationRejected = false
  private var localActionInspecting = false
  private var accountObservation: AnyCancellable?
  private var registrationTask: Task<Void, Never>?
  private var registrationRequested = false
  private var attemptedScope: DesktopSessionScope?
  private var previousPermission: Bool?
  var isCriticalOperation = false
  var canOperate: (() -> Bool)?
  var canRegister: (() -> Bool)?

  init(
    resources: URL?, fixture: Bool = false, transport: (any DesktopWorkerTransport)? = nil,
    preferences: UserDefaults = .standard,
    inspectInstallation: @escaping @Sendable () throws -> DesktopWorkerInstallation = {
      try DesktopWorkerInstallation.inspect()
    }
  ) {
    self.fixture = fixture
    self.transport = transport ?? DesktopWorkerBridge(resources: resources)
    self.inspectInstallation = inspectInstallation
    self.preferences = preferences
    deletedRegistrationObserved = !fixture && preferences.bool(forKey: Self.deletedObservedKey)
  }
  func coordinateRegistration(account: DesktopAccountModel) {
    guard !fixture else { return }
    self.account = account
    accountObservation = account.objectWillChange.sink { [weak self] in
      Task { @MainActor [weak self] in self?.registrationChanged() }
    }
    registrationChanged()
  }
  /// Called by account events and Setup readiness, independent of the visible page.
  func registrationChanged() {
    guard !fixture, account != nil else { return }
    let permission = account?.workerRegistrationPermission
    let event = DesktopWorkerRegistrationEvent(scope: account?.scope, permission: permission)
    if registrationEvent != event {
      registrationEvent = event
      deletionCleanupAttempted = false
    }
    if permission == false, previousPermission != false { attemptedScope = nil }
    previousPermission = permission
    registrationRequested = true
    guard registrationTask == nil else { return }
    registrationTask = Task { @MainActor [weak self] in
      guard let self else { return }
      while self.registrationRequested {
        self.registrationRequested = false
        await self.reconcileRegistration()
      }
      self.registrationTask = nil
    }
  }
  private func reconcileRegistration() async {
    guard !busy, !localActionInspecting else { return }
    let scope = account?.scope
    do {
      if preferences.object(forKey: Self.deletionKey) != nil {
        guard deletionPhase != nil, deletionTarget != nil else {
          throw DesktopWorkerFailure("WORKER_LOCAL_STATE_UNSAFE")
        }
        if !deletionCleanupAttempted { await cleanupDeletedRegistration() }
        return
      }
      let inspect = inspectInstallation
      let local = try await Task.detached { try inspect() }.value
      guard !busy, !localActionInspecting else { return }
      switch local {
      case .registered(let installed):
        preferences.removeObject(forKey: Self.pendingUIDKey)
        registrationState =
          authenticationRejected ? .authenticationRejected : (installed ? .registered : .preserved)
        if checkedDeletionEvent != registrationEvent, canOperate?() != false {
          checkedDeletionEvent = registrationEvent
          await checkInstalledRegistration()
        }
        return
      case .interrupted, .activationRecovery:
        registrationState = .interrupted
        return
      case .unpaired:
        registrationState = .unpaired
        return
      case .deletionRecovery:
        // A controller journal must complete before a new machine can be created.
        registrationState = .deletingRegistration
        failure = DesktopWorkerFailure("WORKER_DELETION_RECOVERY_REQUIRED")
        return
      case .fresh: break
      }
      preferences.removeObject(forKey: Self.pendingUIDKey)
      guard !preferences.bool(forKey: Self.removedKey) else {
        registrationState = .removed
        return
      }
      guard account?.scope == scope else { return }
      guard let scope, let account, account.signedIn else {
        registrationState = .signedOut
        return
      }
      guard account.currentSignInProvider == "google.com" else {
        registrationState = .googleRequired
        return
      }
      guard let allowed = account.workerRegistrationPermission else {
        registrationState = .unavailable
        return
      }
      guard allowed else {
        registrationState = .waiting
        return
      }
      guard attemptedScope != scope else { return }
      guard canOperate?() != false else {
        registrationState = .unavailable
        return
      }
      guard canRegister?() != false else {
        registrationState = .setupRequired
        return
      }
      await installRegistration(scope: scope, replace: false)
    } catch {
      registrationState = .unavailable
      failure = error as? DesktopWorkerFailure ?? DesktopWorkerFailure("WORKER_LOCAL_STATE_UNSAFE")
    }
  }
  private var deletionPhase: DesktopWorkerDeletionPhase? {
    preferences.string(forKey: Self.deletionKey).flatMap(DesktopWorkerDeletionPhase.init(rawValue:))
  }
  private var deletionTarget: String? {
    preferences.string(forKey: Self.deletionTargetKey).flatMap(Self.machineId)
  }
  fileprivate nonisolated static func machineId(_ value: String) -> String? {
    guard
      value.range(
        of:
          "^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-4[a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$",
        options: .regularExpression) != nil
    else { return nil }
    return UUID(uuidString: value)?.uuidString.lowercased()
  }
  private static func isBackendDeleted(_ value: DesktopJSON) -> Bool {
    value["remote"]["available"].bool == false
      && value["remote"]["errorCode"].string == "WORKER_MACHINE_DELETED"
      && value["remote"]["httpStatus"].number == 410
      && value["machineId"].string.flatMap(machineId) != nil
  }
  private static func confirmedDeletedReceipt(_ value: DesktopJSON, target: String) -> Bool {
    value["confirmedDeletedReceipt"].bool == true
      && value["deletedMachineId"].string.flatMap(machineId) == target
      && (value["machineId"] == .null || value["machineId"].string.flatMap(machineId) == target)
  }
  private static func isDeletionNotice(_ value: DesktopJSON, machine: String?) -> Bool {
    guard value["schemaVersion"].number == 1,
      value["code"].string == "WORKER_MACHINE_DELETED", value["httpStatus"].number == 410,
      let machine, value["machineId"].string.flatMap(machineId) == machine,
      let time = value["detectedAt"].string,
      ISO8601DateFormatter().date(from: time) != nil || fractionalDate(time) != nil
    else { return false }
    return true
  }
  private func rememberDeletedRegistration(_ value: DesktopJSON) {
    let configured = value["machineId"].string.flatMap(Self.machineId)
    let retired = value["deletedMachineId"].string.flatMap(Self.machineId)
    guard let target = configured ?? retired,
      Self.isBackendDeleted(value)
        || Self.isDeletionNotice(value["deletionNotice"], machine: configured)
        || Self.confirmedDeletedReceipt(value, target: target),
      deletionTarget == nil || deletionTarget == target
    else { return }
    if preferences.object(forKey: Self.deletionKey) == nil {
      preferences.set(target, forKey: Self.deletionTargetKey)
      preferences.set(DesktopWorkerDeletionPhase.unpair.rawValue, forKey: Self.deletionKey)
      deletionCleanupAttempted = false
    }
    preferences.set(true, forKey: Self.deletedObservedKey)
    deletedRegistrationObserved = true
    registrationState = .deletingRegistration
  }
  private func receiveCheckedRegistration(_ value: DesktopJSON) {
    let remote = value["remote"]
    if Self.isBackendDeleted(value) {
      rememberDeletedRegistration(value)
    } else if remote["available"].bool == false,
      remote["errorCode"].string == "WORKER_UNAUTHENTICATED", remote["httpStatus"].number == 401
    {
      authenticationRejected = true
      registrationState = .authenticationRejected
      failure = DesktopWorkerFailure("WORKER_UNAUTHENTICATED")
    } else if remote["available"].bool == true {
      authenticationRejected = false
      if failure?.code == "WORKER_UNAUTHENTICATED" { failure = nil }
    }
    rememberDeletedRegistration(value)
  }
  private func checkInstalledRegistration() async {
    guard !busy, !localActionInspecting, canOperate?() != false else {
      checkedDeletionEvent = nil
      return
    }
    busy = true
    currentCommand = .status
    defer {
      busy = false
      currentCommand = nil
      progress = .null
      registrationChanged()
    }
    do {
      let result = try await transport.execute(
        .status, parameters: .object(["local": .bool(false)])
      ) { _ in }
      snapshot = try DesktopWorkerSnapshot(result)
      receiveCheckedRegistration(result)
    } catch {
      failure = error as? DesktopWorkerFailure ?? DesktopWorkerFailure("BACKEND_UNAVAILABLE")
    }
  }
  private func cleanupDeletedRegistration() async {
    guard !busy, !localActionInspecting, !deletionCleanupAttempted, canOperate?() != false,
      deletionPhase != nil, let target = deletionTarget
    else { return }
    deletionCleanupAttempted = true
    busy = true
    isCriticalOperation = true
    registrationState = .deletingRegistration
    let restoreSubscriptions = visible
    await suspendSubscriptions()
    let subscriptionFence = generation.value
    defer {
      busy = false
      isCriticalOperation = false
      currentCommand = nil
      progress = .null
      if restoreSubscriptions, generation.accepts(subscriptionFence) {
        resumeSubscriptionsAfterSuspension()
      }
      registrationChanged()
    }
    do {
      let inspect = inspectInstallation
      var local = try? await Task.detached(operation: { try inspect() }).value
      if local == .interrupted || local == .activationRecovery {
        throw DesktopWorkerFailure("WORKER_DELETION_RECOVERY_REQUIRED")
      }
      if deletionPhase != .permission || local != .fresh {
        currentCommand = .status
        let status = try await transport.execute(
          .status, parameters: .object(["local": .bool(false)])
        ) { _ in }
        snapshot = try DesktopWorkerSnapshot(status)
        let current =
          status["machineId"].string.flatMap(Self.machineId)
          ?? (status["confirmedDeletedReceipt"].bool == true
            ? status["deletedMachineId"].string.flatMap(Self.machineId) : nil)
        if let current, current != target {
          // An out-of-band replacement invalidates the old intent; never unpair the new machine.
          preferences.removeObject(forKey: Self.deletionKey)
          preferences.removeObject(forKey: Self.deletionTargetKey)
          preferences.removeObject(forKey: Self.deletedObservedKey)
          deletedRegistrationObserved = false
          authenticationRejected = false
          failure = nil
          return
        }
        if deletionPhase == .unpair {
          guard
            (Self.isBackendDeleted(status)
              && status["machineId"].string.flatMap(Self.machineId) == target)
              || Self.confirmedDeletedReceipt(status, target: target)
          else { throw DesktopWorkerFailure("WORKER_DELETION_CONFIRMATION_REQUIRED") }
        } else if local == nil || local == .unpaired {
          guard Self.confirmedDeletedReceipt(status, target: target) else {
            throw DesktopWorkerFailure("WORKER_DELETION_CONFIRMATION_REQUIRED")
          }
        }
      }
      if deletionPhase == .unpair {
        currentCommand = .unpair
        let result = try await transport.execute(
          .unpair,
          parameters: .object([
            "force": .bool(false), "expected_machine_id": .string(target),
            "deleted_only": .bool(true),
          ])
        ) { [weak self] in self?.progress = $0 }
        guard result["confirmed"].bool == true, result["deleted"].bool == true,
          result["machineId"].string.flatMap(Self.machineId) == target
        else {
          throw DesktopWorkerFailure("WORKER_DELETION_CONFIRMATION_REQUIRED")
        }
        preferences.set(DesktopWorkerDeletionPhase.recover.rawValue, forKey: Self.deletionKey)
      }
      if deletionPhase == .recover {
        currentCommand = .recover
        let result = try await transport.execute(.recover, parameters: .object([:])) {
          [weak self] in self?.progress = $0
        }
        guard result["deleted"].bool == true, result["registrationReset"].bool == true else {
          throw DesktopWorkerFailure("WORKER_DELETION_RECOVERY_REQUIRED")
        }
        let inspect = inspectInstallation
        guard try await Task.detached(operation: { try inspect() }).value == .fresh else {
          throw DesktopWorkerFailure("WORKER_DELETION_RECOVERY_REQUIRED")
        }
        local = .fresh
        authenticationRejected = false
        preferences.removeObject(forKey: Self.pendingUIDKey)
        preferences.removeObject(forKey: Self.removedKey)
        attemptedScope = nil
        preferences.set(DesktopWorkerDeletionPhase.permission.rawValue, forKey: Self.deletionKey)
      }
      if deletionPhase == .permission {
        guard local == .fresh else {
          throw DesktopWorkerFailure("WORKER_DELETION_RECOVERY_REQUIRED")
        }
        if let account, let scope = account.scope, account.signedIn {
          account.receiveWorkerRegistration(nil, scope: scope)
          registrationEvent = DesktopWorkerRegistrationEvent(scope: scope, permission: nil)
          let profile = try await account.api("GET", "/users/me")
          guard self.account?.scope == scope else { throw DesktopAuthFailure.sessionChanged }
          let user = try JSONDecoder().decode(DesktopUser.self, from: JSONEncoder().encode(profile))
          account.receiveWorkerRegistration(user.workerRegistrationAllowed, scope: scope)
        }
        preferences.removeObject(forKey: Self.deletionKey)
        preferences.removeObject(forKey: Self.deletionTargetKey)
      }
      failure = nil
    } catch {
      registrationState = .unavailable
      failure =
        error as? DesktopWorkerFailure
        ?? DesktopWorkerFailure(
          (error as? DesktopAuthFailure)?.code ?? "WORKER_DELETION_RECOVERY_REQUIRED")
    }
  }
  func retryRegistration() async {
    guard !fixture, !busy, !localActionInspecting, canOperate?() != false else { return }
    localActionInspecting = true
    defer {
      localActionInspecting = false
      registrationChanged()
    }
    do {
      let inspect = inspectInstallation
      let local = try await Task.detached { try inspect() }.value
      guard !busy, canOperate?() != false else { return }
      if local == .interrupted || local == .activationRecovery {
        await run(
          local == .activationRecovery ? .recover : .install,
          parameters: local == .activationRecovery ? .object([:]) : Self.installLabel,
          confirmed: true)
        registrationChanged()
      } else {
        attemptedScope = nil
        if let account, let scope = account.scope {
          // Explicit read retry; live approval updates continue through the shared socket.
          account.receiveWorkerRegistration(nil, scope: scope)
          do {
            let profile = try await account.api("GET", "/users/me")
            guard
              let decoded = try? JSONDecoder().decode(
                DesktopUser.self, from: JSONEncoder().encode(profile))
            else { throw DesktopAuthFailure.malformedResponse }
            account.receiveWorkerRegistration(decoded.workerRegistrationAllowed, scope: scope)
          } catch {
            failure = DesktopWorkerFailure(
              (error as? DesktopAuthFailure)?.code ?? "BACKEND_UNAVAILABLE")
          }
        }
        registrationChanged()
      }
    } catch {
      failure = error as? DesktopWorkerFailure ?? DesktopWorkerFailure("WORKER_LOCAL_STATE_UNSAFE")
    }
  }
  var canReplacePendingRegistration: Bool {
    registrationState == .interrupted && pendingRegistrationUID != nil
      && pendingRegistrationUID == account?.firebaseUid
      && account?.workerRegistrationPermission == true
      && account?.currentSignInProvider == "google.com"
      && ["ENROLLMENT_FAILED", "ENROLLMENT_REQUIRED", "OPERATION_FAILED"].contains(
        failure?.code ?? "")
  }
  private var pendingRegistrationUID: String? {
    guard let uid = preferences.string(forKey: Self.pendingUIDKey), !uid.isEmpty,
      uid.utf16.count <= 128,
      !uid.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 })
    else { return nil }
    return uid
  }
  func registerThisMacAgain() async {
    guard !fixture, !busy, !localActionInspecting else { return }
    preferences.removeObject(forKey: Self.removedKey)
    await retryRegistration()
  }
  func registrationRuntimeBecameReady() {
    if ["APP_RUNTIME_NOT_PREPARED", "APP_RUNTIME_INCOMPATIBLE", "WORKER_RUNTIME_UNAVAILABLE"]
      .contains(failure?.code ?? "")
    {
      attemptedScope = nil
      failure = nil
    }
    registrationChanged()
  }
  func replacePendingRegistration() async {
    guard canReplacePendingRegistration, let scope = account?.scope, !busy,
      canOperate?() != false
    else { return }
    await installRegistration(scope: scope, replace: true)
  }
  private static var installLabel: DesktopJSON {
    .object(["label": .string("MusicMute Mac")])
  }
  private func installRegistration(scope: DesktopSessionScope, replace: Bool) async {
    guard let account, !busy, !localActionInspecting, canOperate?() != false else { return }
    if !replace { attemptedScope = scope }
    busy = true
    isCriticalOperation = true
    currentCommand = .install
    registrationState = .preparing
    failure = nil
    defer {
      busy = false
      isCriticalOperation = false
      currentCommand = nil
      progress = .null
      registrationChanged()
    }
    do {
      var response = try await account.api(
        "POST", "/users/me/worker-installation", body: .object([:]))
      defer { response = .null }
      guard account.scope == scope, account.workerRegistrationPermission == true,
        account.currentSignInProvider == "google.com"
      else {
        attemptedScope = nil
        registrationState = .unavailable
        return
      }
      let inspect = inspectInstallation
      let latest = try await Task.detached { try inspect() }.value
      guard account.scope == scope, account.workerRegistrationPermission == true,
        (!replace && latest == .fresh) || (replace && latest == .interrupted)
      else {
        attemptedScope = nil
        registrationState = .unavailable
        return
      }
      do {
        guard let expiry = response["expires_at"].string,
          let date = ISO8601DateFormatter().date(from: expiry)
            ?? Self.fractionalDate(expiry), date > Date(),
          let secret = response["credential"].string,
          secret.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
        else { throw DesktopWorkerFailure("WORKER_CONTROL_INVALID_RESPONSE") }
        var parameters: DesktopJSON = .object([
          "label": .string("MusicMute Mac"), "enrollment_code": .string(secret),
        ])
        if replace, case .object(var fields) = parameters {
          fields["new_code"] = .bool(true)
          parameters = .object(fields)
        }
        defer { parameters = .null }
        response = .null
        // Once handed to the controller, sign-out never interrupts setup or the service.
        preferences.set(scope.firebaseUid, forKey: Self.pendingUIDKey)
        _ = try await transport.execute(.install, parameters: parameters) { [weak self] in
          self?.progress = $0
        }
      }
      preferences.removeObject(forKey: Self.pendingUIDKey)
      preferences.removeObject(forKey: Self.deletedObservedKey)
      deletedRegistrationObserved = false
      authenticationRejected = false
      checkedDeletionEvent = nil
      currentCommand = .start
      _ = try await transport.execute(
        .start, parameters: .object(["wait_ready": .bool(true)])
      ) { [weak self] in
        self?.progress = $0
      }
      registrationState = .registered
    } catch {
      failure =
        error as? DesktopWorkerFailure
        ?? DesktopWorkerFailure((error as? DesktopAuthFailure)?.code ?? "WORKER_OPERATION_FAILED")
      registrationState = .unavailable
    }
  }
  private static func fractionalDate(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value)
  }
  func startRegisteredWorker() async {
    guard !fixture, !busy, !localActionInspecting, canOperate?() != false else { return }
    localActionInspecting = true
    defer {
      localActionInspecting = false
      registrationChanged()
    }
    do {
      let inspect = inspectInstallation
      let local = try await Task.detached { try inspect() }.value
      guard !busy, canOperate?() != false else { return }
      guard case .registered(let installed) = local else { return }
      if !installed {
        await run(.install, parameters: Self.installLabel, confirmed: true)
        guard failure == nil else { return }
      }
      await run(.start, parameters: .object(["wait_ready": .bool(true)]))
      if failure == nil { preferences.removeObject(forKey: Self.removedKey) }
      registrationChanged()
    } catch {
      failure = error as? DesktopWorkerFailure ?? DesktopWorkerFailure("WORKER_LOCAL_STATE_UNSAFE")
    }
  }
  func applyPreview(
    registration: DesktopWorkerRegistrationState = .registered, deleted: Bool = false
  ) {
    guard fixture else { return }
    deletedRegistrationObserved = deleted
    registrationState = registration
    guard registration == .registered else {
      snapshot = nil
      connected = false
      return
    }
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
              if payload["registrationDeleted"].bool == true
                || Self.isDeletionNotice(
                  payload["deletionNotice"],
                  machine: payload["machineId"].string.flatMap(Self.machineId))
              {
                self.rememberDeletedRegistration(payload)
                self.registrationChanged()
              }
              if [
                "WORKER_SUBSCRIPTION_CLOSED", "WORKER_CONTROL_INVALID_RESPONSE",
                "WORKER_CONTROL_START_FAILED",
              ].contains(self.failure?.code ?? "") {
                self.failure = nil
              }
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
    if command == .uninstall || command == .unpair {
      // Persist the operator's removal intent before invoking a possibly interrupted command.
      preferences.set(true, forKey: Self.removedKey)
    }
    isCriticalOperation = command.isCritical(parameters)
    let token = operationGeneration.advance()
    defer {
      busy = false
      currentCommand = nil
      isCriticalOperation = false
      progress = .null
      registrationChanged()
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
      if command == .status {
        deletionCleanupAttempted = false
        if parameters["local"].bool != true { receiveCheckedRegistration(result) }
      }
      report = result
      reportCommand = command
    } catch {
      failure = error as? DesktopWorkerFailure ?? DesktopWorkerFailure("WORKER_OPERATION_FAILED")
    }
  }
}
