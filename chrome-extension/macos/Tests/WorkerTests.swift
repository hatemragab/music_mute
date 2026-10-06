import AppKit
import Foundation
import SwiftUI

@MainActor private final class WorkerFixtureTransport: DesktopWorkerTransport {
  struct Call {
    let command: DesktopWorkerCommand
    let parameters: DesktopJSON
  }
  var calls: [Call] = []
  var subscribers: [(DesktopJSON) -> Void] = []
  var endings: [(DesktopWorkerFailure?) -> Void] = []
  var closes = 0
  var result = DesktopJSON.object(["status": .string("ok")])
  var error: DesktopWorkerFailure?
  var gate: CheckedContinuation<Void, Never>?
  var hold = false
  func execute(
    _ command: DesktopWorkerCommand, parameters: DesktopJSON,
    progress: @escaping (DesktopJSON) -> Void
  ) async throws -> DesktopJSON {
    calls.append(Call(command: command, parameters: parameters))
    progress(.object(["stage": .string("draining")]))
    if hold { await withCheckedContinuation { gate = $0 } }
    if let error { throw error }
    return result
  }
  func subscribe(
    _ command: DesktopWorkerCommand, parameters: DesktopJSON,
    snapshot: @escaping (DesktopJSON) -> Void,
    ended: @escaping (DesktopWorkerFailure?) -> Void
  ) async throws {
    calls.append(Call(command: command, parameters: parameters))
    if let error { throw error }
    subscribers.append(snapshot)
    endings.append(ended)
  }
  func closeSubscriptions() { closes += 1 }
  func waitUntilSubscriptionsClose() async {}
}

@main struct WorkerTests {
  private static let fixture = DesktopJSON.object([
    "schemaVersion": .number(2), "installed": .bool(true), "healthy": .bool(true),
    "lifecycle": .string("active"), "activeReleaseVersion": .string("fixture.1"),
    "service": .object(["running": .bool(true), "loaded": .bool(true)]),
    "runtime": .object(["currentAttempts": .array([]), "childState": .string("ready")]),
    "readiness": .object([
      "phase": .string("ready"), "blockers": .array([]),
      "modelReady": .bool(true), "localReady": .bool(true), "claimEligible": .null,
    ]),
  ])
  private static func frame(_ type: String, id: String, payload: DesktopJSON = fixture) throws
    -> Data
  {
    try JSONEncoder().encode(
      DesktopJSON.object([
        "protocol_version": .number(1), "request_id": .string(id), "type": .string(type),
        "payload": payload,
      ]))
  }
  private static func rejects(_ body: () throws -> Void) {
    do {
      try body()
      preconditionFailure("Unsafe worker input accepted")
    } catch is DesktopWorkerFailure {} catch { preconditionFailure("Unexpected worker error type") }
  }
  @MainActor private static func processChecks() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "musicmute-worker-native-\(UUID())")
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(
      at: root.appendingPathComponent("runtime/runtime/node/bin"), withIntermediateDirectories: true
    )
    try FileManager.default.createDirectory(
      at: root.appendingPathComponent("worker"), withIntermediateDirectories: true)
    try Data("fixture".utf8).write(to: root.appendingPathComponent("worker/controller.js"))
    let node = root.appendingPathComponent("runtime/runtime/node/bin/node")
    let prefix = #"""
      #!/bin/sh
      IFS= read -r envelope
      id=$(printf '%s' "$envelope" | /usr/bin/sed -nE 's/.*"request_id":"([^"]+)".*/\1/p')
      """#
    func script(_ tail: String) throws {
      try Data((prefix + "\n" + tail + "\n").utf8).write(to: node)
      try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: node.path)
    }
    let result =
      #"printf '{"protocol_version":1,"request_id":"%s","type":"RESULT","payload":{"version":"fixture"}}\n' "$id""#
    let bridge = DesktopWorkerBridge(
      resources: root, support: root.appendingPathComponent("support"))
    try script(result)
    let cancelledProcess = DesktopWorkerProcess(
      resources: root, support: root.appendingPathComponent("cancelled-support"))
    let cancelledOpen = Task { @MainActor in
      try await cancelledProcess.open(
        command: .status, parameters: .object([:]), subscription: true,
        onFrame: { _ in preconditionFailure("Cancelled startup produced a frame") }, onEnd: { _ in }
      )
    }
    cancelledOpen.cancel()
    do {
      try await cancelledOpen.value
      preconditionFailure("Cancelled startup was accepted")
    } catch let failure as DesktopWorkerFailure {
      precondition(failure.code == "WORKER_OPERATION_CANCELLED")
    }
    await cancelledProcess.waitUntilClosed()
    precondition(!cancelledProcess.running)
    let success = try await bridge.execute(.versions, parameters: .object([:]), progress: { _ in })
    precondition(success["version"].string == "fixture")
    for tail in [
      result + "\nexit 1", result + "\n" + result,
      #"printf '{"protocol_version":1,"request_id":"foreign","type":"RESULT","payload":{}}\n'"#,
    ] {
      try script(tail)
      do {
        _ = try await bridge.execute(.versions, parameters: .object([:]), progress: { _ in })
        preconditionFailure("Invalid disposable controller result accepted")
      } catch is DesktopWorkerFailure {}
    }
    let payload = String(data: try JSONEncoder().encode(fixture), encoding: .utf8)!
    try script(
      "printf '{\"protocol_version\":1,\"request_id\":\"%s\",\"type\":\"SNAPSHOT\",\"payload\":\(payload)}\\n' \"$id\"\nwhile IFS= read -r line; do :; done"
    )
    var snapshots = 0
    var closed = false
    try await bridge.subscribe(
      .status, parameters: .object([:]),
      snapshot: { value in
        precondition(value == fixture)
        snapshots += 1
      },
      ended: { failure in
        precondition(failure == nil)
        closed = true
      })
    let deadline = ContinuousClock.now.advanced(by: .seconds(3))
    while snapshots == 0 && ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(10))
    }
    precondition(snapshots == 1 && !closed)
    bridge.closeSubscriptions()
    await bridge.waitUntilSubscriptionsClose()
    precondition(closed)
  }
  @MainActor private static func renderUI(at destination: URL) throws {
    guard destination.isFileURL, destination.path.hasPrefix("/"), destination.path != "/" else {
      throw DesktopWorkerFailure("INVALID_REQUEST")
    }
    _ = NSApplication.shared
    NSApp.setActivationPolicy(.prohibited)
    try FileManager.default.createDirectory(
      at: destination, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    for language in ["en", "ar"] {
      for (section, name) in [
        ("Overview", "overview"), ("Worker setup", "setup"), ("Jobs and logs", "jobs"),
        ("Health and support", "health"), ("Worker storage", "storage"),
        ("Worker performance", "performance"), ("Worker updates", "updates"),
        ("Advanced worker actions", "advanced"),
      ] {
        let model = DesktopWorkerModel(resources: nil, fixture: true)
        model.applyPreview()
        let preview = DesktopWorkerView(worker: model, prepare: {}, initialSection: section)
          .environment(\.locale, Locale(identifier: language))
          .environment(\.layoutDirection, language == "ar" ? .rightToLeft : .leftToRight)
          .padding(24).frame(width: 1000, height: 1800, alignment: .topLeading).background(
            Brand.background
          )
          .tint(Brand.mint).accentColor(Brand.mint)
        let hosting = NSHostingView(rootView: preview)
        hosting.appearance = NSAppearance(named: .darkAqua)
        hosting.frame = NSRect(x: 0, y: 0, width: 1000, height: 1800)
        hosting.layoutSubtreeIfNeeded()
        guard let bitmap = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else {
          throw DesktopWorkerFailure("WORKER_UI_RENDER_FAILED")
        }
        hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
        guard let bytes = bitmap.representation(using: .png, properties: [:]), bytes.count > 10_000
        else {
          throw DesktopWorkerFailure("WORKER_UI_RENDER_FAILED")
        }
        try bytes.write(to: destination.appendingPathComponent("worker-\(language)-\(name).png"))
      }
    }
    print(
      "Rendered isolated Worker fixtures to \(destination.path); no app launched or service state changed"
    )
  }
  @MainActor static func main() async throws {
    if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--render-worker-ui" {
      try renderUI(at: URL(fileURLWithPath: CommandLine.arguments[2]))
      return
    }
    let id = UUID().uuidString.lowercased()
    let parsed = try DesktopWorkerFrame.decode(frame("SNAPSHOT", id: id), requestID: id)
    precondition(parsed.kind == .snapshot && parsed.payload == fixture)
    let initialSnapshot = try DesktopWorkerSnapshot(fixture)
    precondition(initialSnapshot.installed)
    rejects {
      _ = try DesktopWorkerFrame.decode(frame("SNAPSHOT", id: UUID().uuidString), requestID: id)
    }
    rejects { _ = try DesktopWorkerFrame.decode(frame("unknown", id: id), requestID: id) }
    rejects {
      _ = try DesktopWorkerFrame.decode(frame("RESULT", id: id, payload: .array([])), requestID: id)
    }
    rejects {
      _ = try DesktopWorkerFrame.decode(Data(repeating: 32, count: 4_195_329), requestID: id)
    }
    rejects {
      _ = try DesktopWorkerFrame.decode(Data("{\"protocol_version\":1".utf8), requestID: id)
    }
    rejects { _ = try DesktopWorkerSnapshot(.object(["installed": .bool(true)])) }
    let safeError = try JSONEncoder().encode(
      DesktopJSON.object([
        "protocol_version": .number(1), "request_id": .string(id), "type": .string("ERROR"),
        "error_code": .string("BACKEND_UNAVAILABLE"),
      ]))
    let decodedError = try DesktopWorkerFrame.decode(safeError, requestID: id)
    precondition(decodedError.errorCode == "BACKEND_UNAVAILABLE")
    let unsafeError = try JSONEncoder().encode(
      DesktopJSON.object([
        "protocol_version": .number(1), "request_id": .string(id), "type": .string("ERROR"),
        "error_code": .string("private token https://secret.example/?password=hidden"),
      ]))
    rejects { _ = try DesktopWorkerFrame.decode(unsafeError, requestID: id) }
    precondition(DesktopWorkerFailure("private credential").code == "WORKER_OPERATION_FAILED")
    var fence = DesktopWorkerGeneration()
    let old = fence.advance()
    let current = fence.advance()
    precondition(!fence.accepts(old) && fence.accepts(current))
    precondition(DesktopWorkerCommand.allCases.count == 25)
    precondition(DesktopWorkerCommand.install.requiresConfirmation(.object([:])))
    precondition(DesktopWorkerCommand.adopt.requiresConfirmation(.object(["apply": .bool(true)])))
    precondition(DesktopWorkerCommand.adopt.isCritical(.object(["apply": .bool(true)])))
    precondition(!DesktopWorkerCommand.adopt.isCritical(.object([:])))
    precondition(!DesktopWorkerCommand.update.requiresConfirmation(.object(["check": .bool(true)])))
    precondition(DesktopWorkerCommand.cleanup.requiresConfirmation(.object(["apply": .bool(true)])))
    precondition(!DesktopWorkerCommand.cleanup.isCritical(.object([:])))
    precondition(DesktopWorkerCommand.uninstall.isCritical(.object(["purge": .bool(true)])))
    let projected = DesktopWorkerReport.rows(
      .object([
        "credential": .string("hidden-one"), "refreshToken": .string("hidden-two"),
        "nested": .object(["password": .string("hidden-three"), "stage": .string("separating")]),
      ]))
    precondition(projected.count == 1 && projected[0].value == "separating")
    let bounded = DesktopWorkerReport.rows(.array((0..<2000).map { .number(Double($0)) }))
    precondition(bounded.count == 1000)
    precondition(
      DesktopWorkerReport.projection(.array((0..<2000).map { .number(Double($0)) })).truncated)
    _ = try DesktopWorkerRequest(
      command: .install, parameters: .object(["label": .string(String(repeating: "م", count: 120))])
    )
    precondition(DesktopWorkerReport.label("jobId") == "Job ID")
    let resources = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("Resources")
    precondition(
      DesktopWorkerReport.localizedLabel(
        "Job ID · Stage", locale: Locale(identifier: "ar"), resources: resources)
        == "معرّف المهمة · المرحلة")
    precondition(!DesktopWorkerReport.projection(.object(["stage": .string("ready")])).truncated)

    rejects {
      _ = try DesktopWorkerRequest(
        command: .start, parameters: .object(["shell": .string("arbitrary")]))
    }
    rejects {
      _ = try DesktopWorkerRequest(command: .capacity, parameters: .object(["workers": .number(3)]))
    }
    rejects {
      _ = try DesktopWorkerRequest(
        command: .benchmarkFile, parameters: .object(["input": .string("relative/song.mp3")]))
    }
    rejects {
      _ = try DesktopWorkerRequest(command: .logs, parameters: .object(["since": .string("1h")]))
    }
    rejects {
      _ = try DesktopWorkerRequest(
        command: .logs, parameters: .object(["clear": .bool(true)]), subscription: true)
    }
    rejects {
      _ = try DesktopWorkerRequest(
        command: .update, parameters: .object(["check": .bool(true), "force": .bool(true)]))
    }
    rejects {
      _ = try DesktopWorkerRequest(
        command: .install, parameters: .object(["label": .string("bad\nlabel")]))
    }
    _ = try DesktopWorkerRequest(
      command: .update, parameters: .object(["source": .string("catalog"), "check": .bool(true)]))
    rejects {
      _ = try DesktopWorkerRequest(
        command: .update, parameters: .object(["source": .string("unknown")]))
    }
    _ = try DesktopWorkerRequest(
      command: .install,
      parameters: .object(["label": .string("Mac"), "group_id": .string("existing-group")]))
    _ = try DesktopWorkerRequest(
      command: .logs, parameters: .object(["events": .bool(true), "since": .string("30d")]),
      subscription: true)
    _ = try DesktopWorkerRequest(
      command: .benchmarkFile,
      parameters: .object([
        "input": .string("/tmp/synthetic.mp3"), "runs": .number(3), "group_size": .number(2),
      ]))
    precondition(!DesktopWorkerRequest.validSince("31d") && DesktopWorkerRequest.validSince("1s"))
    let transport = WorkerFixtureTransport()
    let model = DesktopWorkerModel(resources: nil, transport: transport)
    model.show()
    await Task.yield()
    await Task.yield()
    precondition(transport.subscribers.count == 1)
    transport.subscribers[0](fixture)
    precondition(model.connected && model.snapshot?.phase == "ready")
    model.hide()
    precondition(!model.connected && transport.closes == 1)
    transport.subscribers[0](fixture)
    precondition(!model.connected)  // Late predecessor frames cannot reconnect the UI.
    model.show()
    await Task.yield()
    await Task.yield()
    transport.endings[0](DesktopWorkerFailure("SUBSCRIPTION_FAILED"))
    precondition(model.failure == nil)
    transport.subscribers[1](fixture)
    precondition(model.connected)
    await model.run(.cleanup, parameters: .object(["apply": .bool(true)]))
    precondition(model.failure?.code == "WORKER_CONFIRMATION_REQUIRED")
    precondition(!transport.calls.contains { $0.command == .cleanup })
    await model.run(.cleanup, parameters: .object(["apply": .bool(true)]), confirmed: true)
    precondition(
      transport.calls.last?.command == .cleanup
        && transport.calls.last?.parameters["apply"].bool == true)
    precondition(model.reportCommand == .cleanup && !model.busy)
    for force in [false, true] {
      let parameters = DesktopJSON.object(["source": .string("catalog"), "force": .bool(force)])
      let beforeConfirmation = transport.calls.count
      await model.run(.update, parameters: parameters)
      precondition(
        transport.calls.count == beforeConfirmation
          && model.failure?.code == "WORKER_CONFIRMATION_REQUIRED")
      await model.run(.update, parameters: parameters, confirmed: true)
      precondition(
        transport.calls.last?.command == .update
          && transport.calls.last?.parameters == parameters
          && model.reportCommand == .update && !model.busy)
    }
    transport.error = DesktopWorkerFailure("BACKEND_UNAVAILABLE")
    await model.run(.status)
    precondition(model.failure?.code == "BACKEND_UNAVAILABLE" && !model.busy)
    transport.error = nil
    let beforeInvalid = transport.calls.count
    await model.run(.job, parameters: .object(["job_id": .string("invalid")]))
    precondition(transport.calls.count == beforeInvalid && model.failure?.code == "INVALID_REQUEST")
    model.canOperate = { false }
    await model.run(.start)
    precondition(model.failure?.code == "WORKER_OPERATION_BUSY")
    model.canOperate = { true }
    transport.hold = true
    let operation = Task { await model.run(.drain) }
    await Task.yield()
    await Task.yield()
    precondition(model.busy && model.isCriticalOperation && model.currentCommand == .drain)
    let count = transport.calls.count
    await model.run(.start)
    // A reentrant action cannot replace a critical operation.
    precondition(transport.calls.count == count)
    model.hide()
    // GUI disconnect never cancels the command/service.
    precondition(model.busy && model.isCriticalOperation)
    transport.gate?.resume()
    transport.gate = nil
    await operation.value
    precondition(!model.busy && !model.isCriticalOperation)
    let preview = DesktopWorkerModel(resources: nil, fixture: true, transport: transport)
    preview.show()
    await preview.run(.start)
    precondition(transport.calls.count == count)
    let unavailable = DesktopWorkerProcess(resources: nil)
    do {
      try await unavailable.open(
        command: .status, parameters: .object([:]), subscription: true,
        onFrame: { _ in preconditionFailure("Missing runtime launched controller") },
        onEnd: { _ in })
      preconditionFailure("Missing resources accepted")
    } catch let failure as DesktopWorkerFailure {
      precondition(failure.code == "WORKER_RUNTIME_UNAVAILABLE" && !unavailable.running)
    }
    try await processChecks()
    print(
      "Worker native protocol/model fixtures passed: decoding, bounds, safe errors, confirmation, generation fencing, missing runtime and independent subscription shutdown"
    )
  }
}
