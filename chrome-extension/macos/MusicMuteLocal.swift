import AppKit
import Combine
import SwiftUI

enum Brand {
  static let background = Color(nsColor: .windowBackgroundColor)
  static let surface = Color.adaptive(light: 0xFFFFFF, dark: 0x191B21)
  static let raised = Color.adaptive(light: 0xF2F3F6, dark: 0x202229)
  static let border = Color(nsColor: .separatorColor)
  static let text = Color.primary
  static let secondary = Color.adaptive(light: 0x505A6A, dark: 0xBDC5D2)
  static let mint = Color.adaptive(light: 0x087C65, dark: 0x96E6C7)
  static let mintDark = Color.adaptive(light: 0xE1F4EE, dark: 0x123C37)
  static let amber = Color.adaptive(light: 0x8A4A00, dark: 0xFFD18B)
  static let accent = Color.accentColor
}
extension Color {
  init(hex: UInt32) {
    self.init(
      .sRGB, red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255,
      blue: Double(hex & 255) / 255, opacity: 1)
  }

  static func adaptive(light: UInt32, dark: UInt32) -> Color {
    let lightColor = NSColor(musicMuteHex: light)
    let darkColor = NSColor(musicMuteHex: dark)
    return Color(
      nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? darkColor : lightColor
      })
  }
}
extension NSColor {
  convenience init(musicMuteHex hex: UInt32) {
    let red = CGFloat((hex >> 16) & 0xFF) / 255.0
    let green = CGFloat((hex >> 8) & 0xFF) / 255.0
    let blue = CGFloat(hex & 0xFF) / 255.0
    self.init(
      srgbRed: red,
      green: green,
      blue: blue,
      alpha: 1.0)
  }
}
enum CompanionPage: String, CaseIterable {
  case overview = "Home"
  case library = "Library"
  case account = "Account"
  case worker = "Worker"
  case setup = "Setup"
  case diagnostics = "Diagnostics"
  var symbol: String {
    switch self {
    case .overview: "square.grid.2x2"
    case .library: "music.note.list"
    case .account: "person.crop.circle"
    case .worker: "server.rack"
    case .setup: "slider.horizontal.3"
    case .diagnostics: "waveform.path.ecg"
    }
  }
}
struct SetupProgress {
  var phase: String
  var percent: Double
  var label: String
}
struct VisibleFailure {
  var code: String
  var action: String
}
struct SetupStorageEstimate: Sendable {
  let downloadBytes: Int64
  let installedBytes: Int64
}
private struct SetupMetadataDocument: Decodable, Sendable {
  struct Model: Decodable, Sendable {
    let filename: String
    let bytes: Int64
    let sha256: String
  }

  let schemaVersion: Int
  let model: Model

  enum CodingKeys: String, CodingKey {
    case schemaVersion = "schema_version"
    case model
  }
}
private enum SetupStorageMetadata {
  static func load(resources: URL?) -> SetupStorageEstimate? {
    guard let resources else { return nil }
    let file = resources.appendingPathComponent("setup-metadata.json")
    guard
      let data = try? RuntimeFileSecurity.readRegularFile(
        file, maximumBytes: 4 * 1024, requireCurrentOwner: false, privatePermissions: false,
        code: "RUNTIME_MANIFEST_INVALID"),
      let metadata = try? JSONDecoder().decode(SetupMetadataDocument.self, from: data),
      metadata.schemaVersion == 1, metadata.model.bytes > 0,
      metadata.model.bytes <= 2_000_000_000,
      RuntimePath.safeRelative(metadata.model.filename),
      !metadata.model.filename.contains("/"), RuntimeDigest.valid(metadata.model.sha256),
      let runtime = try? RuntimeBootstrapDocument.load(resources: resources).document.runtime
    else { return nil }
    let (downloadBytes, downloadOverflow) = runtime.archiveBytes.addingReportingOverflow(
      metadata.model.bytes)
    let (installedBytes, installedOverflow) = runtime.installedBytes.addingReportingOverflow(
      metadata.model.bytes)
    guard !downloadOverflow, !installedOverflow else { return nil }
    return SetupStorageEstimate(
      downloadBytes: downloadBytes, installedBytes: installedBytes)
  }
}
enum ReadinessState: Equatable {
  case notChecked, checking, preparing, ready, needsSetup

  var label: String {
    switch self {
    case .notChecked: "Not checked"
    case .checking: "Checking"
    case .preparing: "Preparing"
    case .ready: "Ready"
    case .needsSetup: "Needs setup"
    }
  }
  var symbol: String {
    switch self {
    case .ready: "checkmark.circle.fill"
    case .checking, .preparing: "ellipsis.circle"
    default: "circle"
    }
  }
}
struct SetupPresentation {
  let status: CompanionStatus?
  let activeCommand: AppCommand?
  let hasFailure: Bool

  func state(_ verified: Bool?) -> ReadinessState {
    if activeCommand == .status { return .checking }
    if activeCommand == .setup { return .preparing }
    guard let verified else { return .notChecked }
    return verified ? .ready : .needsSetup
  }
  var runtime: ReadinessState { state(status?.runtimeReady) }
  var model: ReadinessState { state(status?.modelReady) }
  var chrome: ReadinessState { state(status?.extensionRegistered) }
  private func toolState(_ component: String, verified: Bool?) -> ReadinessState {
    let result = state(verified)
    guard result == .needsSetup,
      status?.components?.first(where: { $0.component == component })?.errorCode == "SETUP_REQUIRED"
    else { return result }
    return .notChecked
  }
  var downloader: ReadinessState { toolState("downloader", verified: status?.downloaderReady) }
  var javascript: ReadinessState { toolState("javascript", verified: status?.javascriptReady) }
  var tokenProvider: ReadinessState {
    toolState("token_provider", verified: status?.tokenProviderReady)
  }
  var ready: Bool {
    activeCommand != .status && activeCommand != .setup && status?.complete == true
  }
  var needsChromeRepair: Bool {
    guard activeCommand != .status, activeCommand != .setup, let status else { return false }
    return status.supported && status.runtimeReady && status.modelReady
      && !status.extensionRegistered
  }
  var needsYouTubeRepair: Bool {
    guard activeCommand != .status, activeCommand != .setup, let status else { return false }
    return status.supported && status.runtimeReady && status.modelReady
      && status.youtubeReady == false
  }
  var actionLabel: String {
    if activeCommand == .status { return "Checking readiness…" }
    if activeCommand == .setup { return "Preparing your Mac…" }
    if needsChromeRepair { return "Repair Chrome connection" }
    if needsYouTubeRepair { return "Check YouTube tools" }
    if ready { return "Check readiness" }
    return hasFailure ? "Retry setup" : "Prepare my Mac"
  }
  var completionMessage: String {
    if status?.youtubeReady == false {
      return
        "Local processing is ready. Some YouTube tools need attention; review the setup checks."
    }
    return
      "Local tools are prepared. Add the Chrome extension to finish. YouTube access is checked when you use a video."
  }
}

@MainActor final class CompanionModel: ObservableObject {
  @Published var page: CompanionPage = .overview
  @Published var status: CompanionStatus?
  @Published var report: LocalReport?
  @Published var progress: SetupProgress?
  @Published var failure: VisibleFailure? {
    didSet {
      if let failure, !fixture {
        journal?.record(.appOperationError, code: failure.code, command: currentCommand)
      }
    }
  }
  @Published var journalAvailable = true
  @Published var busy = false
  @Published var notice: String?
  @Published var lastExport: URL?
  @Published private(set) var setupStorageEstimate: SetupStorageEstimate?
  @Published private(set) var setupStorageMetadataLoaded = false
  let fixture: Bool
  let resources: URL?
  let account: DesktopAccountModel
  let workspace: DesktopWorkspace
  let updater: DesktopUpdater
  let worker: DesktopWorkerModel
  private var updaterObservation: AnyCancellable?
  private let bridge = ProcessBridge()
  private let journal: UIJournal?
  private var currentCommand: AppCommand?
  private var commandStart: Task<Void, Never>?
  var onStopped: (() -> Void)?

  init() {
    resources = Bundle.main.resourceURL
    let arguments = ProcessInfo.processInfo.arguments
    let fixtureName: String?
    if let index = arguments.firstIndex(of: "--ui-fixture"), index + 1 < arguments.count {
      fixtureName = arguments[index + 1]
    } else {
      fixtureName = nil
    }
    fixture = fixtureName != nil
    journal = fixture ? nil : UIJournal()
    let desktopAccount = DesktopAccountModel(
      configuration: try? DesktopPublicConfiguration.load(resources: resources), journal: journal)
    account = desktopAccount
    workspace = DesktopWorkspace(account: desktopAccount, resources: resources, journal: journal)
    updater = DesktopUpdater(fixture: fixture)
    worker = DesktopWorkerModel(resources: resources, fixture: fixture)
    worker.canOperate = { [weak self] in
      guard let self else { return false }
      return !self.busy && !self.updater.installationReserved
        && !self.updater.installationPreparing
    }
    worker.canRegister = { [weak self] in self?.ready == true }
    worker.coordinateRegistration(account: desktopAccount)
    updater.prepareInstallation = { [weak self] in
      guard let self else { throw DesktopWorkerFailure("APP_OPERATION_BUSY") }
      await self.worker.suspendSubscriptions()
    }
    updater.onInstallationReleased = { [weak self] in
      guard let self, self.page == .worker else { return }
      self.worker.resumeSubscriptionsAfterSuspension()
    }
    updater.isApplicationBusy = { [weak self] in
      guard let self else { return true }
      return self.busy || self.workspace.updateBusy || self.account.authenticating
        || self.worker.busy
    }
    updaterObservation = updater.objectWillChange.sink { [weak self] in
      self?.objectWillChange.send()
    }
    if let fixtureName {
      applyFixture(fixtureName)
      setupStorageMetadataLoaded = true
    } else {
      journal?.setFailureHandler { [weak self] in
        DispatchQueue.main.async { self?.journalAvailable = false }
      }
      journal?.record(.appStarted)
      loadSetupStorageMetadata()
    }
  }
  var setupPresentation: SetupPresentation {
    SetupPresentation(
      status: status, activeCommand: busy ? currentCommand : nil, hasFailure: failure != nil)
  }
  var ready: Bool { setupPresentation.ready && !fixture }
  var displayedReady: Bool { setupPresentation.ready }
  var setupActionLabel: String { setupPresentation.actionLabel }
  var preparingSetup: Bool { currentCommand == .setup }
  var operationLabel: String {
    switch currentCommand {
    case .status: "Checking"
    case .snapshot: "Inspecting"
    case .export: "Exporting"
    default: "Preparing"
    }
  }
  private func loadSetupStorageMetadata() {
    let storageResources = resources
    Task { [weak self] in
      let estimate = await Task.detached(priority: .utility) {
        SetupStorageMetadata.load(resources: storageResources)
      }.value
      guard let self else { return }
      setupStorageEstimate = estimate
      setupStorageMetadataLoaded = true
    }
  }
  var extensionURL: URL? {
    guard let path = status?.extensionPath,
      let candidate = LocalPaths.installedExtension(path),
      FileManager.default.fileExists(atPath: candidate.path)
    else { return nil }
    return candidate
  }
  func run(_ command: AppCommand) {
    guard !fixture else {
      notice = "Preview only. No setup or processing commands run in this fixture."
      return
    }
    guard !busy, !worker.busy, !updater.installationReserved, !updater.installationPreparing else {
      return
    }
    guard let resources else {
      failure = VisibleFailure(
        code: "APP_RESOURCES_INCOMPLETE",
        action: "Install the complete MusicMute Local app, then open it again.")
      return
    }
    busy = true
    failure = nil
    notice = nil
    currentCommand = command
    if command == .status || command == .setup { status = nil }
    if command == .setup {
      page = .setup
      progress = SetupProgress(phase: "starting", percent: 0, label: "Preparing your Mac…")
    }
    commandStart = Task { @MainActor [weak self] in
      guard let self else { return }
      // Status subscriptions also own app/runtime execution leases. Release their disposable
      // controllers before Prepare or an explicit integrity check; fleet attempts stay running.
      await worker.suspendSubscriptions()
      guard !Task.isCancelled, busy, currentCommand == command else { return }
      commandStart = nil
      bridge.run(
        command, resources: resources,
        onEvent: { [weak self] event in
          DispatchQueue.main.async { self?.receive(event, command: command) }
        },
        onFinish: { [weak self] outcome in
          DispatchQueue.main.async { self?.finish(outcome, command: command) }
        })
    }
  }
  private func receive(_ event: ControlEvent, command: AppCommand) {
    switch event.type {
    case "progress":
      progress = SetupProgress(
        phase: event.phase ?? "setup", percent: event.percent ?? 0,
        label: event.label ?? "Preparing…")
    case "result":
      if let value = event.status {
        status = value
        progress = nil
        if !value.supported {
          failure = VisibleFailure(
            code: "UNSUPPORTED_PLATFORM",
            action: "This MVP requires an Apple Silicon Mac running macOS 14 or later.")
        }
      }
      if let value = event.report { report = value }
      if command == .export, let path = event.path, let file = LocalPaths.exportedReport(path) {
        lastExport = file
        notice = "Report saved locally. It contains sanitized diagnostics and no audio."
      }
      if command == .export && lastExport == nil {
        failure = VisibleFailure(
          code: "APP_EXPORT_PATH_INVALID",
          action: "The report could not be revealed safely. Retry the export.")
      }
    case "error":
      failure = VisibleFailure(
        code: displayCode(event.errorCode),
        action: event.action ?? "Retry this step. Your local files remain on your Mac.")
    default: break
    }
  }
  private func finish(_ outcome: ProcessOutcome, command: AppCommand) {
    busy = false
    switch outcome {
    case .success:
      if command == .setup && status?.complete == true {
        notice = setupPresentation.completionMessage
      }
      if (command == .status || command == .setup) && status?.runtimeReady == true
        && status?.modelReady == true
      {
        Task { [weak self] in await self?.workspace.runtimeBecameReady() }
        worker.registrationRuntimeBecameReady()
      }
    case .cancelled:
      progress = nil
      switch command {
      case .setup:
        notice = "Setup cancelled. You can resume with Prepare my Mac."
        status = nil
      case .status:
        notice = "Readiness check cancelled. Return to Setup to try again."
        status = nil
      case .snapshot:
        notice = "Diagnostics inspection cancelled. Choose Inspect local diagnostics to try again."
      case .export:
        notice = "Report export cancelled. Choose Export report to try again."
      }
    case .failed(let code):
      progress = nil
      if failure == nil {
        failure = VisibleFailure(
          code: code,
          action: "Retry the step. If it repeats, open Diagnostics and export a local report.")
      }
    }
    currentCommand = nil
    if page == .worker { worker.resumeSubscriptionsAfterSuspension() }
    onStopped?()
    onStopped = nil
  }
  func cancel() {
    if fixture {
      busy = false
      progress = nil
      return
    }
    if currentCommand == .setup {
      journal?.record(.appSetupCancelled, code: "SETUP_CANCELLED", command: .setup)
    }
    if let commandStart, let command = currentCommand {
      commandStart.cancel()
      self.commandStart = nil
      finish(.cancelled, command: command)
      return
    }
    bridge.cancel()
  }
  func openChromeStore() {
    let url = MusicMuteProductLinks.chromeWebStore.url
    guard MusicMuteProductLinks.isAllowed(url) else { return }
    openChrome(url, failureAction: "Open the MusicMute listing in Google Chrome.")
  }
  func openChromeExtensions() {
    guard let url = URL(string: "chrome://extensions") else { return }
    openChrome(url, failureAction: "Open chrome://extensions in Google Chrome.")
  }
  private func openChrome(_ url: URL, failureAction: String) {
    guard
      let chrome = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome")
    else {
      failure = VisibleFailure(
        code: "CHROME_NOT_INSTALLED", action: "Install Google Chrome, then return to these steps.")
      return
    }
    NSWorkspace.shared.open(
      [url], withApplicationAt: chrome, configuration: NSWorkspace.OpenConfiguration()
    ) { _, error in
      if error != nil {
        Task { @MainActor in
          self.failure = VisibleFailure(
            code: "CHROME_OPEN_FAILED", action: failureAction)
        }
      }
    }
  }
  func revealExtension() {
    if let url = extensionURL { NSWorkspace.shared.activateFileViewerSelecting([url]) }
  }
  func copyExtension() {
    if let url = extensionURL {
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(url.path, forType: .string)
      notice = "Extension folder path copied."
    }
  }
  func revealLogs() {
    guard FileManager.default.fileExists(atPath: LocalPaths.logs.path) else {
      notice = "No local logs yet. Prepare your Mac or use the extension first."
      return
    }
    NSWorkspace.shared.activateFileViewerSelecting([LocalPaths.logs])
  }
  func revealModelFolder() {
    guard !fixture, failure?.code == "MODEL_CACHE_INVALID" else { return }
    let folder = LocalPaths.support.appendingPathComponent("models", isDirectory: true)
    guard FileManager.default.fileExists(atPath: folder.path) else {
      notice = "The model folder is unavailable. Retry setup to check it again."
      return
    }
    NSWorkspace.shared.activateFileViewerSelecting([folder])
  }
  func revealExport() {
    if let file = lastExport, LocalPaths.exportedReport(file.path) != nil {
      NSWorkspace.shared.activateFileViewerSelecting([file])
    }
  }
  func openSetupLink(_ url: URL) {
    if LocalPaths.isSetupURL(url) {
      page = .setup
    } else if LocalPaths.isAccountURL(url) {
      page = .account
    } else if let handoff = DesktopCloudHandoff(url: url) {
      workspace.receiveCloudHandoff(handoff)
      page = .overview
    } else {
      return
    }
    NSApp.activate(ignoringOtherApps: true)
    NSApp.windows.first(where: { $0.canBecomeMain })?.makeKeyAndOrderFront(nil)
  }
  private func applyFixture(_ name: String) {
    let statusJSON = """
      {"ready":true,"platform":"darwin","arch":"arm64","version":"0.1.0","runtime_ready":true,"model_ready":true,"extension_registered":true,"extension_path":"/fixture/extension","model_bytes":66759214,"cache_bytes":28311552,"diagnostic_mode":"LOCAL_ONLY","max_duration_seconds":1200}
      """
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    status = try? decoder.decode(CompanionStatus.self, from: Data(statusJSON.utf8))
    if name == "worker" {
      page = .worker
      worker.applyPreview()
    }
    if name == "repair" {
      page = .setup
      let repairJSON = statusJSON.replacingOccurrences(
        of: "\"ready\":true", with: "\"ready\":false"
      )
      .replacingOccurrences(
        of: "\"extension_registered\":true", with: "\"extension_registered\":false")
      status = try? decoder.decode(CompanionStatus.self, from: Data(repairJSON.utf8))
    }
    if name == "setup" {
      page = .setup
      status = nil
    }
    if ["progress", "progress-overview", "progress-diagnostics"].contains(name) {
      page =
        name == "progress-overview"
        ? .overview : name == "progress-diagnostics" ? .diagnostics : .setup
      status = nil
      busy = true
      currentCommand = .setup
      progress = SetupProgress(phase: "model", percent: 62, label: "Downloading the voice model…")
    }
    if name == "error" {
      page = .setup
      status = nil
      failure = VisibleFailure(
        code: "MODEL_DOWNLOAD_INTERRUPTED",
        action: "The download was interrupted. Retry to finish preparing your Mac.")
    }
    if name == "model-error" {
      page = .setup
      status = nil
      failure = VisibleFailure(
        code: "MODEL_CACHE_INVALID",
        action:
          "Open the model folder in this app, move the damaged Kim_Vocal_2.onnx file aside, then retry setup."
      )
    }
    if name == "diagnostics" || name == "diagnostics-alerts" || name == "diagnostics-desktop" {
      page = .diagnostics
      var reportJSON = """
        {"schema_version":1,"created_at":"2026-10-02T08:10:00.000Z","availability":"available","coverage":{"incomplete_history":false,"retained_bytes":54272,"max_log_bytes":20971520,"read_only":true,"unmeasured":["gpu_memory","audio_quality","operating_system_audio_latency"]},"counts":{"job_ready":2,"job_failed":0},"peaks":{"rss_bytes":524288000,"cpu_percent":86},"jobs":[{"job_id":"00000000-0000-4000-8000-000000000001","state":"ready","elapsed_ms":18500,"stages_ms":{"download":3200,"processing":14300},"incomplete":false}],"recent_errors":[],"recent_warnings":[],"recent_events":[{"component":"companion","severity":"info","event":"job_ready","sequence":12,"session_id":"fixture","recorded_at":"2026-10-02T08:10:00.000Z"},{"component":"engine","severity":"info","event":"stage_completed","sequence":11,"session_id":"fixture","recorded_at":"2026-10-02T08:09:59.000Z"}]}
        """
      if name == "diagnostics-alerts" {
        reportJSON = reportJSON.replacingOccurrences(
          of: "\"availability\":\"available\"",
          with:
            "\"availability\":\"diagnostics_unavailable\",\"failure_code\":\"DIAGNOSTICS_UNAVAILABLE\""
        )
        .replacingOccurrences(
          of: "\"incomplete_history\":false", with: "\"incomplete_history\":true"
        )
        .replacingOccurrences(
          of: "\"recent_errors\":[]",
          with:
            "\"recent_errors\":[{\"component\":\"companion\",\"severity\":\"error\",\"event\":\"job_failed\",\"code\":\"EACCES\",\"sequence\":1,\"session_id\":\"fixture\"}]"
        )
        .replacingOccurrences(
          of: "\"recent_warnings\":[]",
          with:
            "\"recent_warnings\":[{\"component\":\"engine\",\"severity\":\"warning\",\"event\":\"performance_alert\",\"code\":\"RESOURCE_RSS_GROWTH\",\"sequence\":2,\"session_id\":\"fixture\"}]"
        )
      }
      if name == "diagnostics-desktop" {
        reportJSON.removeLast()
        reportJSON += """
          ,"app_desktop_diagnostics":{"availability":"available","coverage":{"incomplete_history":false},"counts":{"job_ready":1,"job_failed":1},"peaks":{"rss_bytes":268435456,"cpu_percent":42},"recent_errors":[{"component":"companion","severity":"error","event":"job_failed","code":"TOOL_TIMEOUT","sequence":1,"session_id":"fixture","recorded_at":"2026-10-02T08:08:00.000Z"}],"recent_warnings":[{"component":"engine","severity":"warning","event":"performance_alert","code":"RESOURCE_RSS_GROWTH","sequence":2,"session_id":"fixture","recorded_at":"2026-10-02T08:08:01.000Z"}],"recent_events":[{"component":"companion","severity":"info","event":"job_ready","sequence":3,"session_id":"fixture","recorded_at":"2026-10-02T08:10:00.000Z"}]}}
          """
      }
      report = try? decoder.decode(LocalReport.self, from: Data(reportJSON.utf8))
    }
  }
}

@MainActor final class CompanionDelegate: NSObject, NSApplicationDelegate {
  weak var model: CompanionModel?
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if let model, model.worker.busy {
      let alert = NSAlert()
      alert.messageText = String(localized: "Worker operation in progress")
      alert.informativeText = String(
        localized:
          "Wait until the worker operation finishes before quitting. The background worker and accepted jobs continue independently of the app."
      )
      alert.addButton(withTitle: String(localized: "Keep working"))
      alert.runModal()
      return .terminateCancel
    }
    if let model,
      (model.updater.installationReserved || model.updater.installationPreparing)
        && !model.updater.canTerminateForUpdate
    {
      model.notice =
        "Cancel the update download or wait until it is ready to install before quitting."
      return .terminateCancel
    }
    if let model, model.workspace.processing, !model.fixture {
      let alert = NSAlert()
      alert.messageText = "Cancel audio preparation and quit?"
      alert.informativeText =
        "Voice preparation is still running. Saved voices and pending account uploads remain on this Mac for recovery."
      alert.addButton(withTitle: "Keep preparing")
      alert.addButton(withTitle: "Cancel and quit")
      guard alert.runModal() == .alertSecondButtonReturn else { return .terminateCancel }
      model.workspace.shutdown()
    }
    guard let model, model.busy, !model.fixture else { return .terminateNow }
    let alert = NSAlert()
    alert.messageText =
      model.preparingSetup ? "Cancel setup and quit?" : "Cancel current operation and quit?"
    alert.informativeText =
      model.preparingSetup
      ? "MusicMute is preparing your Mac. You can retry setup when you open the app again."
      : "MusicMute is \(model.operationLabel.lowercased()). You can retry this operation when you open the app again."
    alert.addButton(withTitle: model.preparingSetup ? "Keep preparing" : "Keep working")
    alert.addButton(withTitle: "Cancel and quit")
    guard alert.runModal() == .alertSecondButtonReturn else { return .terminateCancel }
    model.onStopped = { sender.reply(toApplicationShouldTerminate: true) }
    model.cancel()
    return .terminateLater
  }
  func applicationWillTerminate(_ notification: Notification) {
    model?.worker.hide()
    model?.workspace.shutdown()
  }
}

#if !MUSICMUTE_NATIVE_TESTS
  private final class TerminalPreparationState: @unchecked Sendable {
    private let lock = NSLock()
    private var finalStatus: CompanionStatus?
    private var failure: String?
    private var lastPercent = -1

    func receive(_ event: ControlEvent) -> (output: String?, error: String?) {
      lock.lock()
      defer { lock.unlock() }
      if event.type == "progress", let percent = event.percent, let label = event.label {
        let rounded = Int(percent.rounded(.down))
        guard rounded != lastPercent else { return (nil, nil) }
        lastPercent = rounded
        return ("[\(rounded)%] \(label)\n", nil)
      }
      if event.type == "result", let status = event.status {
        finalStatus = status
        return (nil, nil)
      }
      if event.type == "error" {
        let code = event.errorCode ?? "RUNTIME_INSTALL_FAILED"
        failure = code
        let action = event.action ?? "Retry preparation from the MusicMute app."
        return (nil, "MusicMute preparation failed: \(code)\n\(action)\n")
      }
      return (nil, nil)
    }

    func snapshot() -> (status: CompanionStatus?, failure: String?) {
      lock.lock()
      defer { lock.unlock() }
      return (finalStatus, failure)
    }
  }

  private final class TerminalPreparationSignals: @unchecked Sendable {
    private let interrupt: any DispatchSourceSignal
    private let terminate: any DispatchSourceSignal

    init(bridge: ProcessBridge) {
      Darwin.signal(SIGINT, SIG_IGN)
      Darwin.signal(SIGTERM, SIG_IGN)
      interrupt = DispatchSource.makeSignalSource(
        signal: SIGINT, queue: DispatchQueue.global(qos: .userInitiated))
      terminate = DispatchSource.makeSignalSource(
        signal: SIGTERM, queue: DispatchQueue.global(qos: .userInitiated))
      interrupt.setEventHandler { [weak bridge] in bridge?.cancel() }
      terminate.setEventHandler { [weak bridge] in bridge?.cancel() }
      interrupt.activate()
      terminate.activate()
    }

    func cancel() {
      interrupt.cancel()
      terminate.cancel()
    }
  }

  private enum TerminalPreparation {
    static func run(resources: URL?) async -> Int32 {
      guard let resources else {
        FileHandle.standardError.write(
          Data("MusicMute preparation failed: APP_RESOURCES_INCOMPLETE\n".utf8))
        return 1
      }
      return await withCheckedContinuation { continuation in
        let bridge = ProcessBridge()
        let state = TerminalPreparationState()
        let signals = TerminalPreparationSignals(bridge: bridge)
        bridge.run(
          .setup, resources: resources,
          onEvent: { event in
            let message = state.receive(event)
            if let output = message.output {
              FileHandle.standardOutput.write(Data(output.utf8))
            }
            if let error = message.error { FileHandle.standardError.write(Data(error.utf8)) }
          },
          onFinish: { outcome in
            signals.cancel()
            let snapshot = state.snapshot()
            switch outcome {
            case .success where snapshot.status?.complete == true:
              FileHandle.standardOutput.write(
                Data("MusicMute Local is prepared and ready.\n".utf8))
              continuation.resume(returning: 0)
            case .cancelled:
              FileHandle.standardError.write(Data("MusicMute preparation cancelled.\n".utf8))
              continuation.resume(returning: 130)
            case .failed(let code):
              if snapshot.failure == nil {
                FileHandle.standardError.write(
                  Data("MusicMute preparation failed: \(code)\n".utf8))
              }
              continuation.resume(returning: 1)
            default:
              FileHandle.standardError.write(
                Data("MusicMute preparation finished, but readiness is incomplete.\n".utf8))
              continuation.resume(returning: 1)
            }
          })
      }
    }
  }

  private enum TerminalNativeHost {
    static func run(arguments: [String], resources: URL?) -> Int32 {
      guard let resources else {
        writeFailure("APP_RESOURCES_INCOMPLETE")
        return 1
      }
      do {
        _ = try NativeHostLauncher.execute(arguments: arguments, resources: resources)
        // A successful exec never returns to the app process.
        writeFailure("LOCAL_COMPANION_START_FAILED")
      } catch let failure as RuntimeBootstrapFailure {
        writeFailure(failure.errorCode)
      } catch {
        writeFailure("LOCAL_COMPANION_START_FAILED")
      }
      return 1
    }

    private static func writeFailure(_ code: String) {
      FileHandle.standardError.write(Data("MusicMute native host failed: \(code)\n".utf8))
    }
  }

  @main enum MusicMuteLocalEntryPoint {
    @MainActor static func main() async {
      let arguments = Array(CommandLine.arguments.dropFirst())
      if arguments == ["--browser-processing-bridge"] {
        await BrowserProcessingBridge.run(expectedArguments: ["--browser-processing-bridge"])
      } else if arguments == ["--check-runtime"] {
        let started = ProcessInfo.processInfo.systemUptime
        var result: [String: Any] = [:]
        do {
          let configuredRoot = ProcessInfo.processInfo.environment["MUSICMUTE_LOCAL_ROOT"]
          if let configuredRoot,
            !configuredRoot.hasPrefix("/") || configuredRoot.contains("\0")
          {
            throw RuntimeBootstrapFailure.code("RUNTIME_ACTIVE_INVALID")
          }
          let support =
            configuredRoot.map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? LocalPaths.support
          guard let resources = Bundle.main.resourceURL,
            (try RuntimeVerificationCoordinator.shared.inspectRuntime(
              resources: resources, support: support)) != nil
          else { throw RuntimeBootstrapFailure.code("APP_RUNTIME_NOT_PREPARED") }
          result["ready"] = true
        } catch let failure as RuntimeBootstrapFailure {
          result = ["ready": false, "error_code": failure.errorCode]
        } catch {
          result = ["ready": false, "error_code": "RUNTIME_ARCHIVE_INVALID"]
        }
        result["duration_ms"] = (ProcessInfo.processInfo.systemUptime - started) * 1000
        if let data = try? JSONSerialization.data(withJSONObject: result) {
          FileHandle.standardOutput.write(data + Data([10]))
        }
        Darwin.exit(0)
      } else if arguments == ["--prepare"] {
        let status = await TerminalPreparation.run(resources: Bundle.main.resourceURL)
        Darwin.exit(status)
      } else if arguments.first == "--native-host" {
        let status = TerminalNativeHost.run(
          arguments: Array(arguments.dropFirst()), resources: Bundle.main.resourceURL)
        Darwin.exit(status)
      } else if InstalledAppGate.relinquishUninstalledCopy() {
        Darwin.exit(0)
      } else {
        MusicMuteLocalApp.main()
      }
    }
  }

  private enum InstalledAppGate {
    private static let registrar =
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

    static func relinquishUninstalledCopy() -> Bool {
      let current = Bundle.main.bundleURL
      guard current.pathExtension == "app" else { return false }
      if InstalledAppLocation.isInstalledCopy(current) {
        run(registrar, ["-f", current.path])
        return false
      }
      run(registrar, ["-u", current.path])
      if let installed = InstalledAppLocation.preferredInstalledCopy() {
        run(registrar, ["-f", installed.path])
        var arguments = ["-a", installed.path]
        if let link = CommandLine.arguments.dropFirst().first(where: {
          $0.hasPrefix("musicmute-local:")
        }) {
          arguments.append(link)
        }
        run("/usr/bin/open", arguments)
      }
      return true
    }

    private static func run(_ executable: String, _ arguments: [String]) {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: executable)
      process.arguments = arguments
      guard (try? process.run()) != nil else { return }
      process.waitUntilExit()
    }
  }
  struct MusicMuteLocalApp: App {
    @NSApplicationDelegateAdaptor(CompanionDelegate.self) private var delegate
    @StateObject private var model = CompanionModel()
    @StateObject private var visualPreferences = DesktopVisualPreferences()
    init() {
      DesktopTypography.registerFont(resources: Bundle.main.resourceURL)
    }
    var body: some Scene {
      WindowGroup("MusicMute Local", id: "main") {
        CompanionView(model: model)
          .preferredColorScheme(visualPreferences.appearance.colorScheme)
          .tint(visualPreferences.accent.color)
          .accentColor(visualPreferences.accent.color)
          .desktopTextSize(visualPreferences.textSize)
          .environment(\.locale, Locale(identifier: resolvedLanguage))
          .environment(\.layoutDirection, resolvedLanguage == "ar" ? .rightToLeft : .leftToRight)
          .frame(minWidth: 840, minHeight: 660)
          .onOpenURL { model.openSetupLink($0) }
          .task {
            delegate.model = model
            if !model.fixture && model.status == nil && !model.busy { model.run(.status) }
            if !model.fixture {
              await model.account.loadPublicPolicy()
              await model.account.restore()
              await model.workspace.start()
              await model.workspace.syncAccount()
            }
          }
      }
      .defaultSize(width: 1240, height: 860)
      .windowToolbarStyle(.unified)
      .commands {
        CommandGroup(after: .appInfo) {
          Button("Check for Updates…") { model.updater.checkForUpdates() }
            .disabled(!model.updater.canCheck || model.fixture)
        }
        CommandGroup(replacing: .newItem) {
          Button("New Voice") { model.page = .overview }
            .keyboardShortcut(
              DesktopAppShortcut.newVoice.key,
              modifiers: DesktopAppShortcut.newVoice.modifiers)
        }
        CommandMenu("Navigate") {
          Button("Home") { model.page = .overview }
            .keyboardShortcut(
              DesktopAppShortcut.home.key, modifiers: DesktopAppShortcut.home.modifiers)
          Button("Library") { model.page = .library }
            .keyboardShortcut(
              DesktopAppShortcut.library.key, modifiers: DesktopAppShortcut.library.modifiers)
          Button("Account") { model.page = .account }
            .keyboardShortcut(
              DesktopAppShortcut.account.key, modifiers: DesktopAppShortcut.account.modifiers)
          Divider()
          Button("Setup") { model.page = .setup }
            .keyboardShortcut(
              DesktopAppShortcut.setup.key, modifiers: DesktopAppShortcut.setup.modifiers)
          Button("Diagnostics") { model.page = .diagnostics }
            .keyboardShortcut(
              DesktopAppShortcut.diagnostics.key,
              modifiers: DesktopAppShortcut.diagnostics.modifiers)
        }
        CommandMenu("Playback") {
          Button {
            model.workspace.togglePlayback()
          } label: {
            Text(LocalizedStringKey(model.workspace.playing ? "Pause" : "Play"))
          }
          .keyboardShortcut(
            DesktopAppShortcut.playPause.key,
            modifiers: DesktopAppShortcut.playPause.modifiers
          )
          .disabled(model.workspace.currentTrack == nil)
          Button("Next Voice") { Task { await model.workspace.next() } }
            .keyboardShortcut(
              DesktopAppShortcut.nextVoice.key,
              modifiers: DesktopAppShortcut.nextVoice.modifiers
            )
            .disabled(!model.workspace.canControlPlayback)
          Divider()
          Button("Back 10 Seconds") {
            model.workspace.seek(model.workspace.position - 10)
          }
          .keyboardShortcut(
            DesktopAppShortcut.seekBackward.key,
            modifiers: DesktopAppShortcut.seekBackward.modifiers
          )
          .disabled(model.workspace.currentTrack == nil)
          Button("Forward 10 Seconds") {
            model.workspace.seek(model.workspace.position + 10)
          }
          .keyboardShortcut(
            DesktopAppShortcut.seekForward.key,
            modifiers: DesktopAppShortcut.seekForward.modifiers
          )
          .disabled(model.workspace.currentTrack == nil)
          Divider()
          Button {
            model.workspace.toggleMute()
          } label: {
            Text(LocalizedStringKey(model.workspace.muted ? "Unmute" : "Mute"))
          }
          .keyboardShortcut(
            DesktopAppShortcut.toggleMute.key,
            modifiers: DesktopAppShortcut.toggleMute.modifiers
          )
          .disabled(model.workspace.currentTrack == nil)
          Button("Increase Volume") { model.workspace.adjustVolume(by: 0.05) }
            .keyboardShortcut(
              DesktopAppShortcut.volumeUp.key,
              modifiers: DesktopAppShortcut.volumeUp.modifiers
            )
            .disabled(
              model.workspace.currentTrack == nil
                || (!model.workspace.muted && model.workspace.volume >= 1))
          Button("Decrease Volume") { model.workspace.adjustVolume(by: -0.05) }
            .keyboardShortcut(
              DesktopAppShortcut.volumeDown.key,
              modifiers: DesktopAppShortcut.volumeDown.modifiers
            )
            .disabled(
              model.workspace.currentTrack == nil
                || model.workspace.volume <= 0)
          Divider()
          Button("Switch Voice and Original") {
            Task { await model.workspace.compareOriginal() }
          }
          .keyboardShortcut(
            DesktopAppShortcut.switchVersion.key,
            modifiers: DesktopAppShortcut.switchVersion.modifiers
          )
          .disabled(
            !model.workspace.canCompareOriginal || model.workspace.preparingOriginal)
          Button("Toggle Favorite Current Voice") {
            if let track = model.workspace.currentTrack { model.workspace.favorite(track) }
          }
          .keyboardShortcut(
            DesktopAppShortcut.favorite.key,
            modifiers: DesktopAppShortcut.favorite.modifiers
          )
          .disabled(model.workspace.currentTrack == nil)
          Divider()
          Button("Stop") { model.workspace.stop() }
            .keyboardShortcut(
              DesktopAppShortcut.stop.key, modifiers: DesktopAppShortcut.stop.modifiers
            )
            .disabled(model.workspace.currentTrack == nil)
        }
        CommandGroup(after: .toolbar) {
          Divider()
          Button("Make Text Larger") {
            visualPreferences.textSize = visualPreferences.textSize.increased()
          }
          .keyboardShortcut(
            DesktopAppShortcut.textLarger.key,
            modifiers: DesktopAppShortcut.textLarger.modifiers
          )
          .disabled(visualPreferences.textSize == DesktopTextSizePreference.allCases.last)
          Button("Make Text Smaller") {
            visualPreferences.textSize = visualPreferences.textSize.decreased()
          }
          .keyboardShortcut(
            DesktopAppShortcut.textSmaller.key,
            modifiers: DesktopAppShortcut.textSmaller.modifiers
          )
          .disabled(visualPreferences.textSize == .compact)
          Button("Reset Text Size") { visualPreferences.textSize = .system }
            .keyboardShortcut(
              DesktopAppShortcut.textStandard.key,
              modifiers: DesktopAppShortcut.textStandard.modifiers
            )
            .disabled(visualPreferences.textSize == .system)
          Divider()
          Button("Check Mac Readiness") { model.run(.status) }
            .keyboardShortcut(
              DesktopAppShortcut.checkReadiness.key,
              modifiers: DesktopAppShortcut.checkReadiness.modifiers
            )
            .disabled(model.busy)
        }
      }

      Settings {
        DesktopPreferencesView(
          workspace: model.workspace, visualPreferences: visualPreferences,
          updater: model.updater, isPreview: model.fixture,
          openAccount: {
            model.page = .account
            NSApp.activate(ignoringOtherApps: true)
            let settingsWindow = NSApp.keyWindow
            NSApp.windows.first(where: { $0.canBecomeMain && $0 !== settingsWindow })?
              .makeKeyAndOrderFront(nil)
          }
        )
        .preferredColorScheme(visualPreferences.appearance.colorScheme)
        .tint(visualPreferences.accent.color)
        .accentColor(visualPreferences.accent.color)
        .desktopTextSize(visualPreferences.textSize)
        .environment(\.locale, Locale(identifier: resolvedLanguage))
        .environment(\.layoutDirection, resolvedLanguage == "ar" ? .rightToLeft : .leftToRight)
      }
      .defaultSize(width: 700, height: 660)
    }
    private var resolvedLanguage: String {
      if visualPreferences.language != .system {
        return visualPreferences.language.rawValue
      }
      return Locale.preferredLanguages.first?.hasPrefix("ar") == true ? "ar" : "en"
    }
  }
#endif

private struct CompanionView: View {
  @AppStorage(DesktopPreferenceKey.restoreLastPage) private var restoreLastPage = true
  @AppStorage(DesktopPreferenceKey.lastPage) private var lastPage = CompanionPage.overview.rawValue
  @ObservedObject var model: CompanionModel
  @Environment(\.layoutDirection) private var layoutDirection
  @Environment(\.locale) private var locale
  @FocusState private var navigationFocused: Bool
  var body: some View {
    NavigationSplitView {
      sidebar.environment(\.layoutDirection, layoutDirection)
    } detail: {
      detail
    }
    .navigationSplitViewStyle(.balanced)
    // Keep the native column geometry stable; each column still lays out Arabic right to left.
    .environment(\.layoutDirection, .leftToRight)
    .background(Brand.background)
    .disabled(model.updater.installationReserved || model.updater.installationPreparing)
    .foregroundStyle(Brand.text)
    .onAppear {
      if !model.fixture, restoreLastPage, let page = CompanionPage(rawValue: lastPage) {
        model.page = page
      }
      DispatchQueue.main.async { navigationFocused = true }
    }
    .onChange(of: model.page) { _, page in
      if !model.fixture { lastPage = page.rawValue }
      if page == .library, !model.fixture {
        Task { await model.workspace.libraryBecameVisible() }
      }
    }
  }
  private var sidebar: some View {
    ScrollViewReader { scrollProxy in
      List(
        selection: Binding(
          get: { model.page },
          set: { page in
            model.page = page
            if page == .diagnostics && model.report == nil && !model.busy {
              model.run(.snapshot)
            }
          })
      ) {
        Section {
          HStack(spacing: 12) {
            VocalMark().frame(width: 42, height: 42).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
              Text("MusicMute").desktopFont(.headline)
              Text("ON THIS MAC").desktopFont(.caption2, weight: .semibold)
                .tracking(layoutDirection == .rightToLeft ? 0 : 1.4)
                .foregroundStyle(Brand.mint)
            }
          }
          .padding(.top, 12)
          .padding(.bottom, 8)
          .id("musicmute-sidebar-top")
          .accessibilityElement(children: .combine)
        }
        Section("MusicMute") {
          ForEach([CompanionPage.overview, .library, .account, .worker], id: \.self) { page in
            Label(LocalizedStringKey(page.rawValue), systemImage: page.symbol)
              .desktopFont(.body, weight: .medium)
              .padding(.vertical, 5)
              .tag(page)
              .id(page)
              .accessibilityIdentifier("nav_\(page.rawValue.lowercased())")
          }
          SettingsLink {
            Label("Settings", systemImage: "gearshape")
              .desktopFont(.body, weight: .medium)
              .padding(.vertical, 5)
              .frame(maxWidth: .infinity, alignment: .leading)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityIdentifier("nav_settings")
        }
        Section("Support") {
          ForEach([CompanionPage.setup, .diagnostics], id: \.self) { page in
            Label(LocalizedStringKey(page.rawValue), systemImage: page.symbol)
              .desktopFont(.body, weight: .medium)
              .padding(.vertical, 5)
              .tag(page)
              .id(page)
              .accessibilityIdentifier("nav_\(page.rawValue.lowercased())")
          }
        }
        Section {
          VStack(alignment: .leading, spacing: 10) {
            Label("Private by design", systemImage: "lock.shield").desktopFont(
              .caption, weight: .semibold
            )
            .foregroundStyle(Brand.mint)
            Text(
              "Local processing by default. Account media syncs online. Diagnostics stay on your Mac."
            ).desktopFont(.caption).foregroundStyle(Brand.secondary)
              .lineLimit(nil)
              .frame(maxWidth: .infinity, alignment: .leading)
              .fixedSize(horizontal: false, vertical: true)
            Text("macOS · Apple Silicon · v\(model.status?.version ?? "0.1.0")")
              .desktopFont(.caption2).foregroundStyle(Brand.secondary).padding(.top, 4)
          }
          .padding(.vertical, 8)
        }
      }
      .listStyle(.sidebar)
      .focused($navigationFocused)
      .defaultScrollAnchor(.top)
      .task {
        await Task.yield()
        scrollProxy.scrollTo("musicmute-sidebar-top", anchor: .top)
      }
    }
    .background(.regularMaterial)
    .navigationSplitViewColumnWidth(min: 230, ideal: 270, max: 330)
  }
  private var detail: some View {
    VStack(spacing: 0) {
      if model.busy {
        HStack(spacing: 12) {
          ProgressView().controlSize(.small)
          Text(LocalizedStringKey(model.operationLabel)).desktopFont(.callout, weight: .medium)
          if let progress = model.progress {
            Text(LocalizedStringKey(progress.label)).desktopFont(.caption).foregroundStyle(
              Brand.secondary
            ).lineLimit(2)
          }
          Spacer()
          Button("Cancel") { model.cancel() }.buttonStyle(.bordered)
            .keyboardShortcut(.cancelAction)
            .accessibilityIdentifier("operation_cancel")
        }
        .environment(\.layoutDirection, layoutDirection)
        .padding(.horizontal, 24).padding(.vertical, 10)
        .background(.bar)
      }
      ScrollViewReader { scrollProxy in
        ScrollView {
          VStack(alignment: .leading, spacing: 24) {
            Color.clear.frame(height: 1).id(detailTopID).accessibilityHidden(true)
            if model.page != .library {
              header
            }
            if model.fixture {
              Label("SYNTHETIC UI PREVIEW • No setup commands run", systemImage: "testtube.2")
                .desktopFont(.caption, weight: .semibold).foregroundStyle(Brand.amber)
            }
            if !model.journalAvailable {
              Label(
                "App diagnostics are unavailable. Setup can continue, but this app session cannot write its local journal.",
                systemImage: "exclamationmark.shield"
              ).desktopFont(.caption).foregroundStyle(Brand.amber)
            }
            if let error = model.failure { failureCard(error) }
            if let notice = model.notice {
              Label(LocalizedStringKey(notice), systemImage: "info.circle").desktopFont(.callout)
                .foregroundStyle(
                  Brand.secondary
                ).textSelection(.enabled)
            }
            switch model.page {
            case .overview:
              DesktopHomeView(workspace: model.workspace, account: model.account) {
                model.page = .account
              }
              overview
            case .library: DesktopLibraryView(workspace: model.workspace)
            case .account: DesktopAccountView(account: model.account, workspace: model.workspace)
            case .worker:
              DesktopWorkerView(
                worker: model.worker, prepare: { model.page = .setup },
                openAccount: { model.page = .account })
            case .setup: setup
            case .diagnostics: diagnostics
            }
          }
          .environment(\.layoutDirection, layoutDirection)
          .padding(.horizontal, 30).padding(.bottom, 24).padding(.top, 12)
          .frame(maxWidth: 1040, alignment: .leading)
          .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .defaultScrollAnchor(.top)
        .background(Brand.background)
        .task(id: model.page) {
          await Task.yield()
          scrollProxy.scrollTo(detailTopID, anchor: .top)
        }
      }
      DesktopMiniPlayer(workspace: model.workspace)
        .environment(\.layoutDirection, layoutDirection)
    }
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Button {
          model.run(.status)
        } label: {
          Label {
            Text(LocalizedStringKey(readinessLabel))
          } icon: {
            Image(systemName: readinessSymbol)
          }
        }
        .disabled(model.busy)
        .help("Check whether the local runtime, model, and Chrome connection are ready")
        .accessibilityIdentifier("toolbar_readiness")
      }
    }
  }
  private var detailTopID: String { "musicmute-detail-\(model.page.rawValue)" }
  private var readinessLabel: String {
    if model.busy { return model.operationLabel }
    if model.status == nil { return "Not checked" }
    return model.displayedReady ? "Mac ready" : "Setup needed"
  }
  private var readinessSymbol: String {
    if model.busy { return "hourglass" }
    return model.displayedReady ? "checkmark.circle.fill" : "exclamationmark.circle"
  }
  private var header: some View {
    VStack(alignment: .leading, spacing: 7) {
      Text(LocalizedStringKey(eyebrow)).desktopFont(.caption2, weight: .semibold)
        .foregroundStyle(Brand.mint)
      Text(LocalizedStringKey(model.page.rawValue)).desktopFont(.largeTitle, weight: .semibold)
      Text(LocalizedStringKey(subtitle)).desktopFont(.body).foregroundStyle(Brand.secondary)
    }
    .padding(.top, 4)
    .accessibilityElement(children: .combine)
  }
  private var eyebrow: String {
    switch model.page {
    case .overview: "CREATE VOICE-ONLY AUDIO"
    case .library: "YOUR VOICE LIBRARY"
    case .account: "MUSICMUTE ACCOUNT"
    case .worker: "INDEPENDENT BACKGROUND PROCESSING"
    case .setup: "LOCAL COMPANION"
    case .diagnostics: "LOCAL DIAGNOSTICS"
    }
  }
  private var subtitle: String {
    switch model.page {
    case .overview: "Keep the voice. Enjoy the original video."
    case .library: "Your account results and saved voice-only audio."
    case .account: "Your account, sign-in methods and connected devices."
    case .worker: "Manage this Mac’s independent background worker."
    case .setup: "Prepare once, then control MusicMute inside YouTube."
    case .diagnostics: "Understand a run with safe evidence stored locally."
    }
  }
  private var overview: some View {
    VStack(alignment: .leading, spacing: 24) {
      HStack(spacing: 22) {
        VocalMark().frame(width: 72, height: 72).accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 16) {
          Label(
            model.displayedReady ? "LOCAL ENGINE READY" : "LOCAL ENGINE SETUP",
            systemImage: model.displayedReady ? "checkmark.circle.fill" : "gearshape.2"
          )
          .desktopFont(.caption, weight: .semibold).foregroundStyle(
            model.displayedReady ? Brand.mint : Brand.amber)
          Text(
            model.displayedReady
              ? "Your Mac is ready for voice-only audio."
              : "Prepare MusicMute once to process privately on this Mac."
          ).desktopFont(.title2, weight: .semibold)
          Text(
            "Use the importer above for links and audio files, or add the Chrome extension for synchronized YouTube playback."
          ).desktopFont(.body).foregroundStyle(Brand.secondary).fixedSize(
            horizontal: false, vertical: true)
          Button {
            model.page = .setup
          } label: {
            Text(LocalizedStringKey(model.displayedReady ? "Set Up Chrome…" : "Review setup…"))
          }.buttonStyle(.borderedProminent).controlSize(.large).disabled(model.busy)
            .accessibilityIdentifier(
              "overview_primary")
        }.frame(maxWidth: .infinity, alignment: .leading)
      }.padding(28).background(
        LinearGradient(
          colors: [Brand.mintDark.opacity(0.58), Brand.surface], startPoint: .topLeading,
          endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 24)
      ).overlay(RoundedRectangle(cornerRadius: 24).stroke(Brand.mint.opacity(0.12)))
      HStack(spacing: 14) {
        localizedMetric("Processing", value: "On this Mac", symbol: "desktopcomputer")
        localizedMetric(
          "Video length",
          value: LocalizedStringKey(
            "Up to \((model.status?.maxDurationSeconds ?? DesktopMediaLimits.maxDurationSeconds) / 60) min"
          ), symbol: "clock")
        localizedMetric(
          "Account", value: "Not needed", symbol: "person.crop.circle.badge.checkmark")
      }
      VStack(alignment: .leading, spacing: 18) {
        Text("Chrome playback in three steps").desktopFont(.headline)
        numberedStep(1, "Choose a video", "Click MusicMute beside the YouTube player controls.")
        numberedStep(
          2, "Prepare the voice track", "The video pauses while your Mac removes background music.")
        numberedStep(
          3, "Watch and listen together",
          "The video resumes with vocals that follow pause, seek and speed.")
      }.card()
      Label(
        "Internet is needed to acquire the audio. Voice processing and diagnostics stay local.",
        systemImage: "lock.circle"
      ).desktopFont(.caption).foregroundStyle(Brand.secondary)
    }
  }
  private var setup: some View {
    VStack(alignment: .leading, spacing: 22) {
      VStack(alignment: .leading, spacing: 20) {
        HStack {
          Text("1. Prepare your Mac").desktopFont(.title3, weight: .semibold)
          Spacer()
          if model.displayedReady {
            Label("Ready", systemImage: "checkmark.circle.fill").foregroundStyle(Brand.mint)
              .desktopFont(.caption, weight: .semibold)
          }
        }
        Text(
          "Install the verified voice model and connect the local companion to Chrome. No account or administrator password is needed."
        ).desktopFont(.callout).foregroundStyle(Brand.secondary)
        VStack(spacing: 14) {
          // Tool subcomponents still participate in setup and explicit checks; the checklist only
          // presents the three user-facing readiness outcomes.
          readinessRow(
            "Processing runtime",
            detail: "Kept on this Mac · verified during Prepare or Check again",
            state: model.setupPresentation.runtime)
          readinessRow(
            "Kim Vocal 2 model",
            detail: model.setupPresentation.model == .ready
              ? LocalizedStringKey(
                "Installed · \(localizedBytesLabel(model.status?.modelBytes ?? 0))")
              : "Downloads once, then stays on your Mac", state: model.setupPresentation.model)
          readinessRow(
            "Chrome connection",
            detail: model.setupPresentation.chrome == .ready
              ? "Registered for your user account" : "Connects this app to Chrome",
            state: model.setupPresentation.chrome)
        }
        Text(
          "These checks prepare local tools. YouTube may still refuse a request or limit access. Cached voices and local files remain usable."
        ).desktopFont(.caption).foregroundStyle(Brand.secondary)
        Text(
          "After setup, Chrome starts the companion automatically. The MusicMute window can be closed while the extension processes."
        ).desktopFont(.caption).foregroundStyle(Brand.secondary)
        VStack(alignment: .leading, spacing: 8) {
          Label("Where MusicMute keeps its files", systemImage: "internaldrive")
            .desktopFont(.caption, weight: .semibold)
          Text(
            "The app stays where you installed it. This running copy is at:"
          ).desktopFont(.caption).foregroundStyle(Brand.secondary).fixedSize(
            horizontal: false, vertical: true)
          Text(Bundle.main.bundleURL.path)
            .desktopFont(.caption, design: .monospaced).textSelection(.enabled)
            .environment(\.layoutDirection, .leftToRight)
          Text("Managed processing data is stored per user at:")
            .desktopFont(.caption).foregroundStyle(Brand.secondary)
          Text(LocalPaths.support.path)
            .desktopFont(.caption, design: .monospaced).textSelection(.enabled)
            .environment(\.layoutDirection, .leftToRight)
          Text(
            "Processing tools are kept in runtime/releases and the voice model is kept in models. They stay outside the app so compatible app updates can reuse them."
          ).desktopFont(.caption).foregroundStyle(Brand.secondary).fixedSize(
            horizontal: false, vertical: true)
          Text(storageEstimate).desktopFont(.caption).foregroundStyle(Brand.secondary).fixedSize(
            horizontal: false, vertical: true)
          Text(
            "Each app build requests one pinned runtime. An already prepared match is reused; otherwise Prepare downloads and verifies it before an atomic switch. Runtime files are never mixed. Running different app versions side by side is unsupported, and the last prepared copy controls Chrome."
          ).desktopFont(.caption).foregroundStyle(Brand.secondary).fixedSize(
            horizontal: false, vertical: true)
          Text(
            "Other Python, Node, FFmpeg, Deno or downloader versions installed elsewhere are left unchanged and ignored. MusicMute runs only its pinned, verified copies; if managed files are changed, setup stops and guides you through repair."
          ).desktopFont(.caption).foregroundStyle(Brand.secondary).fixedSize(
            horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Brand.raised, in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("setup_storage_location")
        if let progress = model.progress {
          VStack(alignment: .leading, spacing: 12) {
            HStack {
              Text(LocalizedStringKey(progress.label)).desktopFont(.callout, weight: .medium)
              Spacer()
              Text("\(Int(progress.percent))%").desktopFont(.caption, monospacedDigits: true)
                .foregroundStyle(Brand.mint)
            }
            ProgressView(value: progress.percent, total: 100).tint(Brand.mint)
              .accessibilityLabel(Text(LocalizedStringKey(progress.label)))
              .accessibilityValue(
                "\(progress.phase.replacingOccurrences(of: "_", with: " ")), \(Int(progress.percent)) percent"
              )
            Text("Keep this app open while setup completes.").desktopFont(.caption).foregroundStyle(
              Brand.secondary)
          }.padding(18).background(Brand.raised, in: RoundedRectangle(cornerRadius: 14))
            .accessibilityIdentifier("setup_progress")
        }
        HStack(spacing: 12) {
          Button(LocalizedStringKey(model.setupActionLabel)) {
            model.run(
              model.displayedReady && !model.setupPresentation.needsYouTubeRepair ? .status : .setup
            )
          }
          .buttonStyle(.borderedProminent).controlSize(.large).keyboardShortcut(.defaultAction)
          .disabled(model.busy).accessibilityIdentifier("setup_primary")
        }
      }.card()
      VStack(alignment: .leading, spacing: 20) {
        Text("2. Add the Chrome extension").desktopFont(.title3, weight: .semibold)
        numberedStep(
          1, "Open Chrome Web Store",
          "Open the MusicMute listing and choose Add to Chrome when it is available.")
        numberedStep(
          2, "Refresh your YouTube video",
          "The mint MusicMute icon appears beside the player controls.")
        Button("Open Chrome Web Store", systemImage: "arrow.up.right.square") {
          model.openChromeStore()
        }.buttonStyle(.borderedProminent).controlSize(.large)
          .disabled(!model.displayedReady || model.busy)
          .accessibilityIdentifier("open_chrome_store")
        Text(
          "If the listing is awaiting review, use the development steps below for testing."
        ).desktopFont(.caption).foregroundStyle(Brand.secondary).fixedSize(
          horizontal: false, vertical: true)
        DisclosureGroup("Development installation") {
          VStack(alignment: .leading, spacing: 16) {
            numberedStep(
              1, "Open Chrome extensions", "Enable Developer mode in the upper-right corner.")
            numberedStep(
              2, "Choose Load unpacked", "Select the MusicMute extension folder shown by this app.")
            numberedStep(
              3, "Refresh your YouTube video",
              "The mint MusicMute icon appears beside the player controls.")
            HStack(spacing: 10) {
              Button("Open Chrome extensions", systemImage: "arrow.up.right.square") {
                model.openChromeExtensions()
              }.buttonStyle(.bordered).controlSize(.large)
                .disabled(!model.displayedReady || model.busy)
                .accessibilityIdentifier("open_chrome")
              Button("Reveal folder", systemImage: "folder") { model.revealExtension() }
                .buttonStyle(.bordered).controlSize(.large).disabled(model.extensionURL == nil)
              Button("Copy path", systemImage: "doc.on.doc") { model.copyExtension() }
                .buttonStyle(.bordered).controlSize(.large).disabled(model.extensionURL == nil)
            }
            Text("Prepare copies the extension into MusicMute's Application Support folder.")
              .desktopFont(.caption).foregroundStyle(Brand.secondary)
            Label(
              "After an app update, prepare your Mac if prompted, then click Reload for MusicMute in Chrome and refresh YouTube. The extension folder stays in the same location when you move or replace the app.",
              systemImage: "folder.badge.gearshape"
            ).desktopFont(.caption).foregroundStyle(Brand.secondary).fixedSize(
              horizontal: false, vertical: true)
          }.padding(.top, 12)
        }.desktopFont(.callout).accessibilityIdentifier("chrome_development_installation")
      }.card()
    }
  }

  private var storageEstimate: LocalizedStringKey {
    guard model.setupStorageMetadataLoaded else { return "Calculating setup sizes…" }
    guard let estimate = model.setupStorageEstimate else {
      return
        "Size details are unavailable in this copy. Keep at least 2.5 GB free for preparation."
    }
    return LocalizedStringKey(
      "First preparation downloads about \(localizedBytesLabel(estimate.downloadBytes)) and keeps about \(localizedBytesLabel(estimate.installedBytes)). Keep at least 2.5 GB free while setup runs."
    )
  }
  private var diagnostics: some View {
    VStack(alignment: .leading, spacing: 22) {
      HStack(spacing: 10) {
        Button("Inspect local diagnostics", systemImage: "arrow.clockwise") { model.run(.snapshot) }
          .buttonStyle(.borderedProminent).controlSize(.large).disabled(model.busy)
          .accessibilityIdentifier(
            "diagnostics_inspect")
        Button("Export report", systemImage: "square.and.arrow.up") {
          model.lastExport = nil
          model.run(.export)
        }.buttonStyle(.bordered).controlSize(.large).disabled(model.busy).accessibilityIdentifier(
          "diagnostics_export")
        Button("Reveal logs", systemImage: "folder") { model.revealLogs() }
          .buttonStyle(.bordered).controlSize(.large)
        if model.lastExport != nil {
          Button("Show report") { model.revealExport() }.buttonStyle(.bordered).controlSize(.large)
        }
      }
      if let report = model.report {
        HStack(spacing: 14) {
          metric(
            "Processing errors", value: "\(report.errors.count)", symbol: "exclamationmark.circle")
          metric(
            "Processing warnings", value: "\(report.warnings.count)",
            symbol: "exclamationmark.triangle"
          )
          metric(
            "Sampled peak RSS", value: measuredBytesLabel(report.peaks?["rss_bytes"]),
            symbol: "memorychip")
        }
        VStack(alignment: .leading, spacing: 12) {
          HStack {
            Label(
              report.availability == "available"
                ? "Local evidence available" : "Diagnostics need attention",
              systemImage: report.availability == "available"
                ? "checkmark.shield" : "exclamationmark.shield"
            ).foregroundStyle(report.availability == "available" ? Brand.mint : Brand.amber)
            Spacer()
            Text(bytesLabel(report.coverage?.retainedBytes ?? 0)).desktopFont(.caption)
              .foregroundStyle(
                Brand.secondary)
          }
          Text(
            report.availability != "available" || report.coverage?.incompleteHistory == true
              ? "This is a bounded summary. Some older events or measurements are unavailable; export the retained detail to investigate."
              : "No gaps are reported in the retained evidence. This does not prove all behavior or audio quality."
          ).desktopFont(.caption).foregroundStyle(Brand.secondary)
          if report.availability == "diagnostics_unavailable" {
            Text("Recording unavailable · \(displayCode(report.failureCode))")
              .desktopFont(.caption2, design: .monospaced).foregroundStyle(Brand.amber)
          }
          Text(
            "Memory growth is an observation, not proof of a leak. Speaker-to-screen timing and audio quality still need listening checks."
          ).desktopFont(.caption).foregroundStyle(Brand.secondary)
          if let identity = report.identity {
            VStack(alignment: .leading, spacing: 5) {
              Text(identity.recorderLabel)
              Text(
                "\(identity.inventoryLabel) · Expected model \(identity.expectedModelSha256.prefix(12))"
              )
              Text(
                "Retained events keep their own identifiers in the exported report. Expected model is not verification of a run."
              )
            }.desktopFont(.caption).foregroundStyle(Brand.secondary)
              .textSelection(.enabled).accessibilityIdentifier("diagnostics_identity")
          }
        }.card()
        if !report.errors.isEmpty || !report.warnings.isEmpty {
          VStack(alignment: .leading, spacing: 16) {
            Text("Retained processing alerts").desktopFont(.headline)
            Text(
              "Recent errors and warnings remain visible after newer activity. Export for retained detail."
            )
            .desktopFont(.caption).foregroundStyle(Brand.secondary)
            if !report.errors.isEmpty {
              Text("Errors").desktopFont(.caption, weight: .semibold).foregroundStyle(Brand.amber)
              ForEach(Array(report.errors.suffix(8).reversed().enumerated()), id: \.offset) {
                _, event in
                eventRow(event)
              }
            }
            if !report.warnings.isEmpty {
              Text("Warnings").desktopFont(.caption, weight: .semibold).foregroundStyle(Brand.amber)
              ForEach(Array(report.warnings.suffix(8).reversed().enumerated()), id: \.offset) {
                _, event in
                eventRow(event)
              }
            }
          }.card().accessibilityIdentifier("processing_alerts")
        }
        if let appEvents = report.appUiEvents {
          VStack(alignment: .leading, spacing: 16) {
            HStack {
              Text("Companion app journal").desktopFont(.headline)
              Spacer()
              Text(
                report.appUiCoverage?.available == false || !model.journalAvailable
                  ? "Unavailable" : "Local only"
              ).desktopFont(.caption).foregroundStyle(
                report.appUiCoverage?.available == false || !model.journalAvailable
                  ? Brand.amber : Brand.mint)
            }
            if report.appUiCoverage?.historyTruncated == true
              || (report.appUiCoverage?.malformedRecords ?? 0) > 0
            {
              Text(
                "Older or incomplete app events are not shown. The export includes the safe retained evidence."
              ).desktopFont(.caption).foregroundStyle(Brand.secondary)
            }
            if appEvents.isEmpty {
              Text("No retained app events are available.").desktopFont(.callout).foregroundStyle(
                Brand.secondary)
            }
            ForEach(Array(appEvents.suffix(8).reversed().enumerated()), id: \.offset) { _, event in
              HStack(alignment: .top, spacing: 12) {
                Image(
                  systemName: event.event == "app_operation_error"
                    ? "exclamationmark.circle" : "checkmark.circle"
                ).foregroundStyle(event.event == "app_operation_error" ? Brand.amber : Brand.mint)
                VStack(alignment: .leading, spacing: 5) {
                  Text(
                    displayCode(event.event).replacingOccurrences(of: "_", with: " ").capitalized
                  ).desktopFont(.callout, weight: .medium)
                  Text("\(displayCode(event.command)) · \(displayCode(event.code))").desktopFont(
                    .caption2, design: .monospaced
                  ).foregroundStyle(Brand.secondary)
                }
                Spacer()
                if event.at.count >= 19 {
                  Text(String(event.at.dropFirst(11).prefix(8))).desktopFont(
                    .caption2, design: .monospaced
                  ).foregroundStyle(Brand.secondary)
                }
              }
            }
          }.card()
        }
        if let desktopEvidence = report.appDesktopDiagnostics {
          desktopEvidenceView(desktopEvidence)
        }
        if let setupEvidence = report.appSetupDiagnostics {
          VStack(alignment: .leading, spacing: 16) {
            HStack {
              Text("App setup evidence").desktopFont(.headline)
              Spacer()
              Text(setupEvidence.availability == "available" ? "Available" : "Incomplete")
                .desktopFont(.caption).foregroundStyle(
                  setupEvidence.availability == "available" ? Brand.mint : Brand.amber)
            }
            if setupEvidence.coverage?.incompleteHistory == true {
              Text("Some setup history is outside the retained evidence.").desktopFont(.caption)
                .foregroundStyle(Brand.secondary)
            }
            if !setupEvidence.errors.isEmpty || !setupEvidence.warnings.isEmpty {
              Text("Retained setup alerts remain visible after a successful retry.")
                .desktopFont(.caption).foregroundStyle(Brand.secondary)
              if !setupEvidence.errors.isEmpty {
                Text("Errors (\(setupEvidence.errors.count))").desktopFont(
                  .caption, weight: .semibold
                )
                .foregroundStyle(Brand.amber)
                ForEach(Array(setupEvidence.errors.enumerated()), id: \.offset) { _, event in
                  eventRow(event)
                }
              }
              if !setupEvidence.warnings.isEmpty {
                Text("Warnings (\(setupEvidence.warnings.count))").desktopFont(
                  .caption, weight: .semibold
                )
                .foregroundStyle(Brand.amber)
                ForEach(Array(setupEvidence.warnings.enumerated()), id: \.offset) { _, event in
                  eventRow(event)
                }
              }
            }
            if !setupEvidence.events.isEmpty {
              Text("Recent setup activity").desktopFont(.caption, weight: .semibold)
                .foregroundStyle(Brand.secondary)
              ForEach(Array(setupEvidence.events.enumerated()), id: \.offset) { _, event in
                eventRow(event)
              }
            }
          }.card().accessibilityIdentifier("setup_evidence")
        }
        if let job = report.jobs?.last {
          VStack(alignment: .leading, spacing: 16) {
            HStack {
              Text("Latest preparation").desktopFont(.headline)
              Spacer()
              Text(displayCode(job.state).capitalized).desktopFont(.caption, weight: .medium)
                .foregroundStyle(job.state == "ready" ? Brand.mint : Brand.amber)
            }
            HStack {
              Text("Observed total").foregroundStyle(Brand.secondary)
              Spacer()
              Text(durationLabel(job.elapsedMs)).monospacedDigit()
            }
            ForEach(Array((job.stagesMs ?? [:]).keys.sorted()), id: \.self) { key in
              HStack {
                Text(
                  safeIdentifier(key)
                    ? key.replacingOccurrences(of: "_", with: " ").capitalized : "Stage"
                ).foregroundStyle(Brand.secondary)
                Spacer()
                Text(durationLabel(job.stagesMs?[key])).monospacedDigit()
              }
            }
          }.desktopFont(.callout).card()
        }
        VStack(alignment: .leading, spacing: 18) {
          Text("Recent events").desktopFont(.headline)
          if report.events.isEmpty {
            Text("No retained events yet. Use MusicMute on a short video, then inspect again.")
              .desktopFont(.callout).foregroundStyle(Brand.secondary)
          }
          ForEach(Array(report.events.prefix(20).enumerated()), id: \.offset) { _, event in
            eventRow(event)
          }
        }.card()
      } else {
        VStack(alignment: .leading, spacing: 16) {
          Image(systemName: "waveform.path.ecg").desktopFont(.largeTitle).foregroundStyle(
            Brand.mint)
          Text("A clear view of each run").desktopFont(.title3, weight: .semibold)
          Text(
            "Inspect errors, stage timings and sampled resource use. Export a safe local report when a problem needs a closer look."
          ).desktopFont(.callout).foregroundStyle(Brand.secondary)
        }.frame(maxWidth: .infinity, alignment: .leading).card()
      }
      Label(
        "Local only. No audio, source URLs, cookies or credentials are included in reports.",
        systemImage: "lock.shield"
      ).desktopFont(.caption).foregroundStyle(Brand.secondary)
    }
  }
  private func failureCard(_ error: VisibleFailure) -> some View {
    HStack(alignment: .top, spacing: 14) {
      Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Brand.amber).desktopFont(
        .title3)
      VStack(alignment: .leading, spacing: 8) {
        Text("A step needs attention").desktopFont(.headline)
        Text(LocalizedStringKey(error.action)).desktopFont(.callout).foregroundStyle(
          Brand.secondary)
        Text(displayCode(error.code)).desktopFont(.caption, design: .monospaced).foregroundStyle(
          Brand.amber
        ).textSelection(.enabled)
        if error.code == "MODEL_CACHE_INVALID" {
          Button("Show model folder", systemImage: "folder") { model.revealModelFolder() }
            .buttonStyle(.bordered).accessibilityIdentifier("show_model_folder")
        }
      }
      Spacer()
    }.padding(20).background(Brand.amber.opacity(0.06), in: RoundedRectangle(cornerRadius: 16))
      .overlay(RoundedRectangle(cornerRadius: 16).stroke(Brand.amber.opacity(0.22)))
      .accessibilityIdentifier("failure_card")
  }
  private func readinessRow(
    _ title: LocalizedStringKey, detail: LocalizedStringKey, state: ReadinessState
  ) -> some View {
    HStack(spacing: 12) {
      Image(systemName: state.symbol).foregroundStyle(
        state == .ready ? Brand.mint : Brand.secondary.opacity(0.6))
      VStack(alignment: .leading, spacing: 4) {
        Text(title).desktopFont(.callout, weight: .medium)
        Text(detail).desktopFont(.caption).foregroundStyle(Brand.secondary)
      }
      Spacer()
      Text(LocalizedStringKey(state.label)).desktopFont(.caption, weight: .medium).foregroundStyle(
        state == .ready ? Brand.mint : Brand.secondary)
    }.accessibilityElement(children: .combine)
      .accessibilityValue(Text(LocalizedStringKey(state.label)))
  }
  private func numberedStep(
    _ number: Int, _ title: LocalizedStringKey, _ detail: LocalizedStringKey
  ) -> some View {
    HStack(alignment: .top, spacing: 14) {
      Text("\(number)").desktopFont(.caption, weight: .semibold, monospacedDigits: true)
        .foregroundStyle(Brand.mint).frame(width: 28, height: 28).background(
          Brand.mint.opacity(0.08), in: Circle())
      VStack(alignment: .leading, spacing: 5) {
        Text(title).desktopFont(.callout, weight: .medium)
        Text(detail).desktopFont(.caption).foregroundStyle(Brand.secondary).fixedSize(
          horizontal: false, vertical: true)
      }
    }
  }
  private func metric(_ title: LocalizedStringKey, value: String, symbol: String) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Image(systemName: symbol).foregroundStyle(Brand.mint)
        Spacer()
      }
      Text(value).desktopFont(.title2, weight: .semibold)
      Text(title).desktopFont(.caption).foregroundStyle(Brand.secondary)
    }.frame(maxWidth: .infinity, alignment: .leading).card(padding: 18)
  }
  private func localizedMetric(
    _ title: LocalizedStringKey, value: LocalizedStringKey, symbol: String
  ) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Image(systemName: symbol).foregroundStyle(Brand.mint)
        Spacer()
      }
      Text(value).desktopFont(.title2, weight: .semibold)
      Text(title).desktopFont(.caption).foregroundStyle(Brand.secondary)
    }.frame(maxWidth: .infinity, alignment: .leading).card(padding: 18)
  }
  private func localizedBytesLabel(_ value: Int64) -> String {
    max(0, value).formatted(.byteCount(style: .file).locale(locale))
  }
  private func desktopEvidenceView(_ report: AppSetupReport) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        Text("Desktop processing and playback").desktopFont(.headline)
        Spacer()
        Text(report.availability == "available" ? "Available" : "Incomplete").desktopFont(.caption)
          .foregroundStyle(report.availability == "available" ? Brand.mint : Brand.amber)
      }
      if report.coverage?.incompleteHistory == true {
        Text("Some desktop history is outside the retained evidence.").desktopFont(.caption)
          .foregroundStyle(Brand.secondary)
      }
      ForEach(Array((report.counts ?? [:]).keys.sorted().prefix(8)), id: \.self) { key in
        HStack {
          Text(displayCode(key).replacingOccurrences(of: "_", with: " ").capitalized)
            .foregroundStyle(Brand.secondary)
          Spacer()
          Text("\(report.counts?[key] ?? 0)").monospacedDigit()
        }.desktopFont(.caption)
      }
      ForEach(Array((report.peaks ?? [:]).keys.sorted().prefix(8)), id: \.self) { key in
        HStack {
          Text(displayCode(key).replacingOccurrences(of: "_", with: " ").capitalized)
            .foregroundStyle(Brand.secondary)
          Spacer()
          Text(diagnosticPeakLabel(key, value: report.peaks?[key])).monospacedDigit()
        }.desktopFont(.caption)
      }
      if !report.errors.isEmpty || !report.warnings.isEmpty {
        Text("Retained desktop alerts remain visible after a successful retry.")
          .desktopFont(.caption).foregroundStyle(Brand.secondary)
      }
      if !report.errors.isEmpty {
        Text("Errors").desktopFont(.caption, weight: .semibold).foregroundStyle(Brand.amber)
        ForEach(Array(report.errors.enumerated()), id: \.offset) { _, event in eventRow(event) }
      }
      if !report.warnings.isEmpty {
        Text("Warnings").desktopFont(.caption, weight: .semibold).foregroundStyle(Brand.amber)
        ForEach(Array(report.warnings.enumerated()), id: \.offset) { _, event in eventRow(event) }
      }
      Text("Recent desktop activity").desktopFont(.caption, weight: .semibold)
        .foregroundStyle(Brand.secondary)
      if report.events.isEmpty {
        Text("No retained desktop activity is available.").desktopFont(.callout)
          .foregroundStyle(Brand.secondary)
      }
      ForEach(Array(report.events.enumerated()), id: \.offset) { _, event in eventRow(event) }
    }.card().accessibilityIdentifier("desktop_evidence")
  }
  private func diagnosticPeakLabel(_ key: String, value: Double?) -> String {
    guard let value, value.isFinite, value >= 0 else { return "Not sampled" }
    if key.hasSuffix("_bytes") { return measuredBytesLabel(value) }
    if key.hasSuffix("_ms") { return durationLabel(value) }
    if key.hasSuffix("_percent") { return String(format: "%.1f%%", value) }
    return String(format: "%.3g", value)
  }
  private func eventRow(_ event: ReportEvent) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Image(
        systemName: event.severity == "error"
          ? "xmark.circle"
          : event.severity == "warning" ? "exclamationmark.triangle" : "checkmark.circle"
      ).foregroundStyle(event.severity == "info" ? Brand.mint : Brand.amber)
        .accessibilityLabel(
          event.severity == "error" ? "Error" : event.severity == "warning" ? "Warning" : "Event")
      VStack(alignment: .leading, spacing: 5) {
        Text(event.displayName).desktopFont(.callout, weight: .medium)
        HStack {
          Text(event.displayComponent).foregroundStyle(Brand.secondary)
          if let code = event.displayErrorCode { Text(code).foregroundStyle(Brand.amber) }
        }.desktopFont(.caption2, design: .monospaced)
      }
      Spacer()
      if let time = event.displayTime {
        Text(time).desktopFont(.caption2, monospacedDigits: true)
          .foregroundStyle(Brand.secondary)
      }
    }
  }
}

private struct VocalMark: View {
  var body: some View {
    Canvas { context, size in
      let scale = min(size.width, size.height) / 108
      let heights: [CGFloat] = [10, 22, 36, 58, 36, 22, 10]
      let widths: [CGFloat] = [6, 7, 8, 12, 8, 7, 6]
      let opacities: [Double] = [0.24, 0.38, 0.56, 1, 0.56, 0.38, 0.24]
      for index in heights.indices {
        let x = CGFloat(24 + index * 10) * scale
        let height = heights[index] * scale
        var path = Path()
        path.move(to: CGPoint(x: x, y: 54 * scale - height / 2))
        path.addLine(to: CGPoint(x: x, y: 54 * scale + height / 2))
        context.stroke(
          path, with: .color(Brand.mint.opacity(opacities[index])),
          style: StrokeStyle(lineWidth: widths[index] * scale, lineCap: .round))
      }
    }.background(Brand.mintDark, in: RoundedRectangle(cornerRadius: 22)).accessibilityLabel(
      "MusicMute voice waveform")
  }
}
extension View {
  fileprivate func card(padding: CGFloat = 24) -> some View {
    self.frame(maxWidth: .infinity, alignment: .leading).padding(padding).background(
      Brand.surface, in: RoundedRectangle(cornerRadius: 20)
    ).overlay(RoundedRectangle(cornerRadius: 20).stroke(Brand.border))
  }
}
