import AppKit
import ServiceManagement
import SwiftUI
import UniformTypeIdentifiers

private enum WorkerSection: String, CaseIterable {
  case overview = "Overview"
  case setup = "Worker setup"
  case jobs = "Jobs and logs"
  case health = "Health and support"
  case storage = "Worker storage"
  case performance = "Worker performance"
  case updates = "Worker updates"
  case advanced = "Advanced worker actions"
}

struct DesktopWorkerView: View {
  @ObservedObject var worker: DesktopWorkerModel
  let prepare: () -> Void
  let openAccount: () -> Void
  @State private var section = WorkerSection.overview
  @State private var force = false
  @State private var purge = false
  @State private var jobID = ""
  @State private var errorCode = ""
  @State private var since = "24h"
  @State private var limit = 20
  @State private var logLines = 100
  @State private var logKind = "events"
  @State private var logLevel = "all"
  @State private var attemptID = ""
  @State private var fullDoctor = false
  @State private var workers = 1
  @State private var recipe = "kim-vocals-v2"
  @State private var warmupRuns = 1
  @State private var runs = 3
  @State private var groupSize = 2
  @State private var inputPath = ""
  @State private var candidateEngine = ""
  @State private var reportPath = ""
  @State private var audioDirectory = ""
  @State private var baselinePath = ""
  @State private var requestedExportPath: String?
  @State private var pending: WorkerAction?

  init(
    worker: DesktopWorkerModel, prepare: @escaping () -> Void,
    initialSection: String? = nil, openAccount: @escaping () -> Void = {}
  ) {
    self.worker = worker
    self.prepare = prepare
    self.openAccount = openAccount
    _section = State(
      initialValue: initialSection.flatMap(WorkerSection.init(rawValue:)) ?? .overview)
  }

  private struct WorkerAction: Identifiable {
    let id = UUID()
    let command: DesktopWorkerCommand
    let parameters: DesktopJSON
    let title: String
    let detail: String
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      statusCard
      if worker.registrationState != .registered, section != .setup { registrationCard }
      if let failure = worker.failure {
        VStack(alignment: .leading, spacing: 8) {
          Label("Worker needs attention", systemImage: "exclamationmark.triangle").desktopFont(
            .headline)
          Text(LocalizedStringKey(failure.guidance)).fixedSize(horizontal: false, vertical: true)
          Text(failure.code).desktopFont(.caption, design: .monospaced).textSelection(.enabled)
          HStack {
            Button("Reconnect worker status") { worker.reconnect() }.disabled(worker.busy)
            Button("Open Setup", action: prepare)
          }
        }.workerCard().accessibilityIdentifier("worker_failure")
      }
      if worker.busy {
        VStack(alignment: .leading, spacing: 8) {
          HStack {
            ProgressView().controlSize(.small)
            Text("Worker operation in progress").desktopFont(.headline)
          }
          if let stage = worker.progress["stage"].string,
            DesktopWorkerSnapshot.safeIdentifier(stage)
          {
            Text(LocalizedStringKey(DesktopWorkerReport.label(stage))).foregroundStyle(
              Brand.secondary)
          }
          if let index = worker.progress["index"].number, index >= 0, index < 100 {
            Text("Run \(Int(index))").desktopFont(.caption)
          }
          Text(
            "Keep the app open until this operation finishes. Backend jobs continue independently."
          )
          .desktopFont(.caption).foregroundStyle(Brand.secondary)
        }.workerCard().accessibilityIdentifier("worker_operation")
      }
      Picker("Worker section", selection: $section) {
        ForEach(WorkerSection.allCases, id: \.self) {
          Text(LocalizedStringKey($0.rawValue)).tag($0)
        }
      }.pickerStyle(.menu).accessibilityIdentifier("worker_section")
      Group {
        switch section {
        case .overview: overview
        case .setup: setup
        case .jobs: jobs
        case .health: health
        case .storage: storage
        case .performance: performance
        case .updates: updates
        case .advanced: advanced
        }
      }.disabled(worker.busy)
      if worker.reportCommand != nil {
        WorkerReportView(value: worker.report, title: "Worker operation result")
        if worker.reportCommand == .diagnostics, let path = worker.report["path"].string,
          path == requestedExportPath, path.hasPrefix("/"),
          FileManager.default.fileExists(atPath: path)
        {
          Button("Show diagnostic bundle in Finder") {
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
          }
        }
      }
    }
    .task { worker.show() }
    .onDisappear { worker.hide() }
    .alert(item: $pending) { action in
      Alert(
        title: Text(LocalizedStringKey(action.title)),
        message: Text(LocalizedStringKey(action.detail)),
        primaryButton: .destructive(Text("Confirm worker action")) {
          run(action.command, action.parameters, confirmed: true)
        }, secondaryButton: .cancel())
    }
  }
  private var statusCard: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        Label("Background worker", systemImage: "server.rack").desktopFont(.headline)
        Spacer()
        Label(
          worker.connected ? "Live local status" : "Local status disconnected",
          systemImage: worker.connected
            ? "dot.radiowaves.left.and.right" : "antenna.radiowaves.left.and.right.slash"
        )
        .desktopFont(.caption).foregroundStyle(worker.connected ? Brand.mint : Brand.secondary)
      }
      Text(
        "An enabled worker starts at login and processes backend jobs when this window and app are closed. Your Mac must be awake and your macOS user logged in."
      )
      .desktopFont(.callout).foregroundStyle(Brand.secondary).fixedSize(
        horizontal: false, vertical: true)
      Text(
        "macOS controls background permissions and may show a notice or ask you to enable MusicMute in Login Items & Extensions. Audio jobs do not require individual approval."
      )
      .desktopFont(.caption).foregroundStyle(Brand.secondary).fixedSize(
        horizontal: false, vertical: true)
      Button("Open macOS background settings") { SMAppService.openSystemSettingsLoginItems() }
        .accessibilityIdentifier("worker_background_settings")
      if let snapshot = worker.snapshot, worker.connected {
        Grid(alignment: .leading, horizontalSpacing: 28, verticalSpacing: 10) {
          summaryRow("Installation", snapshot.installed ? "Installed worker" : "Not installed")
          summaryRow("Service", snapshot.running ? "Running" : "Stopped")
          summaryRow("Phase", DesktopWorkerReport.label(snapshot.phase))
          summaryRow(
            "Local intent", DesktopWorkerReport.label(snapshot.raw["lifecycle"].string ?? "unknown")
          )
          summaryRow(
            "Active release", snapshot.raw["activeReleaseVersion"].string ?? "Not available")
          summaryRow(
            "Model ready", snapshot.raw["readiness"]["modelReady"].bool == true ? "Yes" : "No")
          summaryRow("Active jobs", String(snapshot.jobs.count))
          summaryRow(
            "Backend eligibility",
            snapshot.raw["readiness"]["claimEligible"].bool.map { $0 ? "Yes" : "No" }
              ?? "Not checked")
        }.accessibilityIdentifier("worker_status_summary")
        if !snapshot.blockers.isEmpty {
          Text("Readiness blockers").desktopFont(.subheadline, weight: .semibold)
          ForEach(snapshot.blockers, id: \.self) {
            Label(LocalizedStringKey(DesktopWorkerReport.label($0)), systemImage: "info.circle")
              .desktopFont(.caption).foregroundStyle(Brand.amber)
          }
        }
        if snapshot.raw["runtime"]["cachedPolicy"] != .null {
          WorkerReportView(
            value: snapshot.raw["runtime"]["cachedPolicy"], title: "Last observed backend policy")
          Text(
            "Cached policy is the last observed state, not proof of a current backend connection."
          )
          .desktopFont(.caption).foregroundStyle(Brand.secondary)
        }
      } else {
        Text(
          "Worker status is read from this Mac. Registration and local service controls stay separate from your voice library."
        )
        .foregroundStyle(Brand.secondary)
      }
    }.workerCard()
  }
  private func summaryRow(_ title: String, _ value: String) -> some View {
    GridRow {
      Text(LocalizedStringKey(title)).foregroundStyle(Brand.secondary)
      Text(LocalizedStringKey(value)).textSelection(.enabled)
    }
  }
  private var overview: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Worker controls").desktopFont(.headline)
      HStack {
        Button("Start worker") { Task { await worker.startRegisteredWorker() } }
          .disabled(
            worker.registrationState != .registered && worker.registrationState != .preserved
          )
          .accessibilityIdentifier("worker_start_app_action")
        action("Pause new jobs", .pause)
        action("Drain accepted jobs", .drain)
        action("Resume worker", .resume)
      }
      HStack {
        action("Stop worker", .stop)
        action("Restart worker", .restart)
        action("Check backend connection", .status)
        action("Show worker versions", .versions)
      }
      Text(
        "Pause and drain preserve accepted jobs. Stop Worker is separate from quitting the app. Resume changes local intent; backend pause and capacity rules remain authoritative."
      )
      .desktopFont(.caption).foregroundStyle(Brand.secondary).fixedSize(
        horizontal: false, vertical: true)
      Text(
        "Stop ends the service now. Its login item remains installed and can start again at your next macOS login. Pause prevents new jobs and remains in effect across logins."
      )
      .desktopFont(.caption).foregroundStyle(Brand.secondary).fixedSize(
        horizontal: false, vertical: true)
      if let snapshot = worker.snapshot, worker.connected {
        ForEach(Array(snapshot.jobs.enumerated()), id: \.offset) { _, job in
          VStack(alignment: .leading, spacing: 8) {
            Label("Processing job", systemImage: "waveform").desktopFont(
              .subheadline, weight: .semibold)
            Text(job["jobId"].string ?? "Not available").desktopFont(.caption, design: .monospaced)
              .textSelection(
                .enabled)
            Text(LocalizedStringKey(DesktopWorkerReport.label(job["stage"].string ?? "unknown")))
            if let completed = job["work"]["completed"].number,
              let total = job["work"]["total"].number, completed >= 0, total > 0, completed <= total
            {
              ProgressView(value: completed, total: total)
              Text("\(Int(completed)) / \(Int(total))").desktopFont(
                .caption, monospacedDigits: true)
            }
            WorkerReportView(value: job, title: "Job progress")
          }.workerCard()
        }
      }
    }.workerCard()
  }
  private var setup: some View {
    registrationCard
  }
  private var registrationCard: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Machine registration").desktopFont(.headline)
      Text(
        "This worker keeps running after you sign out or close MusicMute Local. You can stop it on this Mac, or an administrator can disable it from Workers."
      )
      .desktopFont(.callout).foregroundStyle(Brand.secondary).fixedSize(
        horizontal: false, vertical: true)
      if worker.deletedRegistrationObserved, worker.registrationState != .deletingRegistration {
        Text(
          "The previous worker was deleted in the dashboard. Models and history are preserved. This Mac will register again after fresh administrator approval."
        )
        .desktopFont(.callout).foregroundStyle(Brand.secondary).fixedSize(
          horizontal: false, vertical: true)
      }
      switch worker.registrationState {
      case .checking:
        ProgressView("Checking this Mac’s worker installation…")
      case .signedOut:
        Text("Sign in with Google. An administrator must approve first registration of this Mac.")
        Button {
          Task { await worker.account?.signInGoogle() }
        } label: {
          GoogleSignInLabel("Continue with Google")
        }
        .buttonStyle(.bordered).disabled(worker.account?.googleConfigured != true)
        .accessibilityIdentifier("worker_google_sign_in")
      case .googleRequired:
        Text("Sign in with Google to register this Mac.")
        Button("Open Account", action: openAccount)
      case .waiting:
        Label("Waiting for administrator approval.", systemImage: "clock")
        Text("Keep MusicMute Local open and connected. Approval automatically registers this Mac.")
          .desktopFont(.caption).foregroundStyle(Brand.secondary)
      case .unavailable:
        Label("Could not check worker registration permission", systemImage: "wifi.exclamationmark")
        Button("Retry") { Task { await worker.retryRegistration() } }
          .disabled(worker.busy).accessibilityIdentifier("worker_registration_retry")
      case .preparing:
        ProgressView("Registering this Mac and preparing its worker…")
      case .registered:
        Label(
          "This Mac has an installed worker. Account changes do not replace its registration.",
          systemImage: "checkmark.circle")
      case .authenticationRejected:
        Label(
          "The backend rejected this worker’s credentials.", systemImage: "exclamationmark.shield")
        Text(
          "Review this machine in the dashboard. Account approval does not replace an existing worker."
        )
        .desktopFont(.caption).foregroundStyle(Brand.secondary)
        action("Check backend connection", .status)
      case .deletingRegistration:
        ProgressView("Retiring the deleted worker registration…")
        Text(
          "Models and worker history will be kept. New registration waits for current administrator approval."
        )
        .desktopFont(.caption).foregroundStyle(Brand.secondary)
      case .preserved:
        Text(
          "Registration is preserved. The worker service is uninstalled. Choose Start worker to restore it."
        )
      case .interrupted:
        Text("Worker setup was interrupted. Retry uses its existing recovery state.")
        Button("Retry worker setup") { Task { await worker.retryRegistration() } }
          .disabled(worker.busy).accessibilityIdentifier("worker_setup_retry")
        if worker.canReplacePendingRegistration {
          Button("Retry worker registration") {
            Task { await worker.replacePendingRegistration() }
          }.disabled(worker.busy)
        }
      case .unpaired:
        Text(
          "This Mac’s worker registration was revoked locally. Review Worker health before setting up another worker."
        )
      case .removed:
        Text(
          "The worker was removed on this Mac. Automatic registration remains off until you choose to register again."
        )
        Button("Register this Mac again") { Task { await worker.registerThisMacAgain() } }
          .accessibilityIdentifier("worker_register_again")
      case .setupRequired:
        Text("Prepare this Mac before registering its worker.")
        Button("Open Setup", action: prepare)
      }
    }.workerCard().accessibilityIdentifier("worker_registration")
  }
  private var jobs: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Investigate worker jobs").desktopFont(.headline)
      HStack {
        TextField("Job ID", text: $jobID).textFieldStyle(.roundedBorder)
        action("Inspect job", .job, .object(["job_id": .string(jobID)]), disabled: !validJobID)
      }
      HStack {
        TextField("Error code", text: $errorCode).textFieldStyle(.roundedBorder)
        action(
          "Explain error", .explain, filtered(["code": .string(errorCode)]),
          disabled: !DesktopWorkerFailure.safeCode(errorCode))
      }
      filterControls
      Stepper("Report entries: \(limit)", value: $limit, in: 1...100)
      HStack {
        action(
          "Show recent errors", .errors, filtered(["limit": .number(Double(limit))]),
          disabled: !validSince)
        action(
          "Show job performance", .perf,
          filtered(["last": .number(Double(limit)), "recipe": .string(recipe)]),
          disabled: !validSince)
      }
      Picker("Recipe", selection: $recipe) { recipeOptions }
      Divider()
      Text("Live local logs").desktopFont(.headline)
      Stepper("Log lines: \(logLines)", value: $logLines, in: 1...1000)
      HStack {
        Picker("Log kind", selection: $logKind) {
          Text("All logs").tag("all")
          Text("Events").tag("events")
          Text("Errors").tag("errors")
        }
        Picker("Log level", selection: $logLevel) {
          Text("All levels").tag("all")
          Text("Info").tag("info")
          Text("Warning").tag("warning")
          Text("Error").tag("error")
        }
      }
      TextField("Optional attempt ID", text: $attemptID).textFieldStyle(.roundedBorder)
      Text("Time, attempt and level filters require Events or Errors.").desktopFont(.caption)
        .foregroundStyle(Brand.secondary)
      HStack {
        action("Read retained logs", .logs, logParameters, disabled: !validLogs)
        Button("Follow filtered logs") { worker.subscribeLogs(parameters: logParameters) }.disabled(
          !validLogs)
        action("Clear retained logs", .logs, .object(["clear": .bool(true)]))
      }
      if worker.logReport != .null {
        WorkerReportView(value: worker.logReport, title: "Live worker logs")
      }
    }.workerCard()
  }
  private var health: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Worker health and safe support export").desktopFont(.headline)
      Toggle("Run full integrity checks", isOn: $fullDoctor)
      action("Run Worker Doctor", .doctor, .object(["full": .bool(fullDoctor)]))
      Text(
        "Quick checks inspect readiness. Full checks also verify the managed worker installation. Support bundles exclude credentials, configuration secrets and media."
      )
      .desktopFont(.caption).foregroundStyle(Brand.secondary)
      TextField("Optional diagnostic job ID", text: $jobID).textFieldStyle(.roundedBorder)
      filterControls
      Button("Export worker diagnostics…") {
        guard let path = saveFile(extension: "zip", name: "MusicMute-worker-diagnostics.zip") else {
          return
        }
        requestedExportPath = path
        var fields: [String: DesktopJSON] = ["output": .string(path)]
        if !jobID.isEmpty { fields["job_id"] = .string(jobID) }
        request(.diagnostics, filtered(fields))
      }.disabled(!validSince || (!jobID.isEmpty && !validJobID))
    }.workerCard()
  }
  private var storage: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Managed worker storage").desktopFont(.headline)
      Text(
        "Preview identifies removable scratch, logs and unused releases. Safe cleanup drains and stops the worker, preserves active attempts and verified recovery releases, and restores its previous operating intent."
      )
      .foregroundStyle(Brand.secondary)
      HStack {
        action("Preview worker cleanup", .cleanup)
        action("Apply safe worker cleanup", .cleanup, .object(["apply": .bool(true)]))
      }
    }.workerCard()
  }
  private var performance: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Qualified worker capacity").desktopFont(.headline)
      Picker("Parallel workers", selection: $workers) {
        Text("One worker").tag(1)
        Text("Two workers").tag(2)
      }
      .pickerStyle(.segmented)
      Text(
        "Two workers require a successful capacity qualification for this Mac and release. These operations safely pause fleet claims and restore previous intent after completion."
      )
      .desktopFont(.caption).foregroundStyle(Brand.secondary)
      HStack {
        action(
          "Benchmark and qualify capacity", .benchmark,
          .object(["workers": .number(Double(workers))]))
        action(
          "Apply qualified capacity", .capacity, .object(["workers": .number(Double(workers))]))
      }
      Divider()
      Text("File benchmark").desktopFont(.headline)
      pathRow("Input audio", $inputPath, directory: false)
      Picker("Recipe", selection: $recipe) { recipeOptions }
      Stepper("Warm-up runs: \(warmupRuns)", value: $warmupRuns, in: 0...2)
      Stepper("Measured runs: \(runs)", value: $runs, in: 3...10)
      Picker("Windows per inference", selection: $groupSize) {
        Text("1").tag(1)
        Text("2").tag(2)
        Text("4").tag(4)
      }
      pathRow("Optional candidate engine", $candidateEngine, directory: true)
      pathRow("Optional baseline report", $baselinePath, directory: false)
      pathRow("Optional audio output folder", $audioDirectory, directory: true)
      HStack {
        Text("Benchmark report").foregroundStyle(Brand.secondary)
        Text(reportPath.isEmpty ? String(localized: "Not selected") : reportPath).desktopFont(
          .caption
        )
        .textSelection(.enabled)
        Spacer()
        Button("Choose report…") {
          reportPath =
            saveFile(extension: "json", name: "MusicMute-worker-benchmark.json") ?? reportPath
        }
        if !reportPath.isEmpty { Button("Clear") { reportPath = "" } }
      }
      Button("Run file benchmark") {
        var fields: [String: DesktopJSON] = [
          "input": .string(inputPath), "recipe": .string(recipe),
          "warmup_runs": .number(Double(warmupRuns)), "runs": .number(Double(runs)),
          "group_size": .number(Double(groupSize)),
        ]
        for (key, path) in [
          ("candidate_engine", candidateEngine), ("baseline_report", baselinePath),
          ("save_audio_dir", audioDirectory), ("report", reportPath),
        ] where !path.isEmpty { fields[key] = .string(path) }
        request(.benchmarkFile, .object(fields))
      }.disabled(inputPath.isEmpty || worker.registrationState != .registered)
        .accessibilityIdentifier("worker_benchmark_file")
    }.workerCard()
  }
  private var updates: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Signed worker updates and recovery").desktopFont(.headline)
      Text(
        "The app and worker service have separate release lifecycles. Worker updates finish accepted work, verify the signed release and qualification, retain recovery state, then restore previous intent. An app update must not interrupt the worker's accepted jobs."
      )
      .foregroundStyle(Brand.secondary)
      HStack {
        action(
          "Check app-managed worker update", .update,
          .object(["source": .string("app"), "check": .bool(true)]))
        action("Install app-managed worker update", .update, .object(["source": .string("app")]))
        action("Recover interrupted installation", .recover)
      }
      if let update = worker.snapshot?.raw["update"], update != .null {
        WorkerReportView(value: update, title: "Worker update state")
      }
    }.workerCard()
  }
  private var advanced: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Advanced worker actions").desktopFont(.headline)
      Text(
        "Force operations may interrupt accepted jobs. Use them only after reviewing the worker's state and health checks."
      )
      .foregroundStyle(Brand.amber)
      Toggle("Force the selected operation", isOn: $force)
      HStack {
        action("Stop worker", .stop, .object(["force": .bool(force)]))
        action("Restart worker", .restart, .object(["force": .bool(force)]))
        action(
          "Force worker update", .update, .object(["source": .string("app"), "force": .bool(true)]))
      }
      Divider()
      Text("Signed catalog worker releases").desktopFont(.headline)
      Text(
        "Catalog updates use the worker's signed release channel and may download additional processing tools. Choose this when you need a standalone worker release."
      )
      .desktopFont(.caption).foregroundStyle(Brand.secondary)
      HStack {
        action(
          "Check signed catalog update", .update,
          .object(["source": .string("catalog"), "check": .bool(true)]))
        action(
          "Install signed catalog worker update", .update,
          .object(["source": .string("catalog"), "force": .bool(force)]))
      }
      Divider()
      Text("Disconnect this worker").desktopFont(.headline)
      Text(
        "Revocation disconnects this machine from the backend. Uninstall removes the worker service and preserves worker data unless purge is separately selected. Personal app and Chrome data are separate."
      )
      .foregroundStyle(Brand.secondary)
      action("Revoke this Mac’s worker registration", .unpair, .object(["force": .bool(force)]))
      Toggle("Permanently purge worker data during uninstall", isOn: $purge)
      action(
        purge ? "Uninstall and purge worker data" : "Uninstall worker service", .uninstall,
        .object(["purge": .bool(purge)]))
    }.workerCard()
  }
  private var recipeOptions: some View {
    Group {
      Text("Kim vocals · full timeline").tag("kim-vocals-v2")
      Text("Kim vocals · trimmed").tag("kim-vocals-v2-trim")
    }
  }
  private var filterControls: some View {
    TextField("Since (for example 1h or 7d; blank means all retained)", text: $since)
      .textFieldStyle(.roundedBorder)
  }
  private var validJobID: Bool {
    jobID.range(of: "^[0-9A-Fa-f]{24}$", options: .regularExpression) != nil
  }
  private var validSince: Bool { since.isEmpty || DesktopWorkerRequest.validSince(since) }
  private var validLogs: Bool {
    validSince && (attemptID.isEmpty || UUID(uuidString: attemptID) != nil)
      && (logKind != "all" || (since.isEmpty && attemptID.isEmpty && logLevel == "all"))
  }
  private func filtered(_ fields: [String: DesktopJSON]) -> DesktopJSON {
    var fields = fields
    if !since.isEmpty { fields["since"] = .string(since) }
    return .object(fields)
  }
  private var logParameters: DesktopJSON {
    var fields: [String: DesktopJSON] = ["lines": .number(Double(logLines))]
    if logKind != "all" { fields[logKind] = .bool(true) }
    if logLevel != "all" { fields["level"] = .string(logLevel) }
    if !attemptID.isEmpty { fields["attempt_id"] = .string(attemptID) }
    return filtered(fields)
  }
  private func action(
    _ title: String, _ command: DesktopWorkerCommand,
    _ parameters: DesktopJSON = .object([:]), disabled: Bool = false
  ) -> some View {
    Button(LocalizedStringKey(title)) { request(command, parameters) }
      .disabled(disabled || !allows(command)).accessibilityIdentifier(
        "worker_\(command.rawValue)_\(parameters["source"].string ?? "app")_\(parameters["apply"].bool == true ? "apply" : parameters["check"].bool == true ? "check" : "action")"
      )
  }
  private func allows(_ command: DesktopWorkerCommand) -> Bool {
    switch command {
    case .stop, .restart, .pause, .drain, .resume, .update, .capacity, .benchmark, .benchmarkFile,
      .unpair, .cleanup:
      return worker.registrationState == .registered
    case .uninstall:
      return [.registered, .preserved, .unpaired].contains(worker.registrationState)
    case .recover:
      return [.interrupted, .preserved].contains(worker.registrationState)
    default: return true
    }
  }
  private func request(_ command: DesktopWorkerCommand, _ parameters: DesktopJSON) {
    if command.requiresConfirmation(parameters) {
      pending = WorkerAction(
        command: command, parameters: parameters,
        title: confirmationTitle(command, parameters),
        detail: confirmationDetail(command, parameters))
    } else {
      run(command, parameters)
    }
  }
  private func run(
    _ command: DesktopWorkerCommand, _ parameters: DesktopJSON, confirmed: Bool = false
  ) {
    Task { await worker.run(command, parameters: parameters, confirmed: confirmed) }
  }
  private func confirmationTitle(_ command: DesktopWorkerCommand, _ parameters: DesktopJSON)
    -> String
  {
    if command == .uninstall && parameters["purge"].bool == true {
      return "Permanently delete worker data?"
    }
    if command == .unpair { return "Revoke this machine’s worker registration?" }
    if command == .update && parameters["source"].string == "catalog" {
      return "Install signed catalog worker release?"
    }
    return "Confirm worker operation?"
  }
  private func confirmationDetail(_ command: DesktopWorkerCommand, _ parameters: DesktopJSON)
    -> String
  {
    switch command {
    case .uninstall:
      parameters["purge"].bool == true
        ? "This permanently removes the worker's credentials, logs, configuration, runtimes and models. Personal MusicMute Local data stays separate. This cannot be undone."
        : "This removes the worker's login service. Worker data and recovery material remain available for reinstalling."
    case .unpair:
      "This revokes the worker's backend registration. Confirm only if you want this Mac to stop participating in the fleet."
    case .recover:
      "This restores a preserved worker installation using its existing machine identity and credentials."
    case .benchmark, .benchmarkFile, .capacity, .cleanup:
      "Accepted jobs finish first. The service is temporarily stopped for this operation, then its previous operating intent is restored."
    case .logs:
      "This clears retained worker logs. Existing diagnostic history will no longer be available."
    case .update:
      parameters["source"].string == "catalog"
        ? parameters["force"].bool == true
          ? "Force catalog update may interrupt accepted jobs. Additional tools may be downloaded. Signed release validation, qualification and rollback still protect the existing identity and operating intent; personal app data stays separate."
          : "Accepted jobs finish before installing the signed standalone worker runtime. Additional tools may be downloaded. Qualification and rollback protect the existing identity and operating intent; personal app data stays separate."
        : parameters["force"].bool == true
          ? "Force update may interrupt accepted jobs. The update still requires signed release validation and preserves recovery state."
          : "Accepted jobs finish before installing a verified signed worker release. Previous operating intent and recovery state are preserved."
    default:
      "This force operation may interrupt accepted backend jobs. Review current jobs before confirming."
    }
  }
  private func pathRow(_ title: String, _ path: Binding<String>, directory: Bool) -> some View {
    HStack {
      Text(LocalizedStringKey(title)).foregroundStyle(Brand.secondary)
      Text(path.wrappedValue.isEmpty ? String(localized: "Not selected") : path.wrappedValue)
        .desktopFont(.caption).lineLimit(2).textSelection(.enabled)
      Spacer()
      Button("Choose…") {
        let panel = NSOpenPanel()
        panel.canChooseFiles = !directory
        panel.canChooseDirectories = directory
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url { path.wrappedValue = url.path }
      }
      if !path.wrappedValue.isEmpty { Button("Clear") { path.wrappedValue = "" } }
    }.accessibilityElement(children: .contain)
  }
  private func saveFile(extension suffix: String, name: String) -> String? {
    let panel = NSSavePanel()
    panel.allowedContentTypes = [UTType(filenameExtension: suffix) ?? .data]
    panel.nameFieldStringValue = name
    return panel.runModal() == .OK ? panel.url?.path : nil
  }
}

struct DesktopWorkerReport {
  struct Row: Identifiable, Equatable {
    let id: String
    let label: String
    let value: String
  }
  struct Projection: Equatable {
    let rows: [Row]
    let truncated: Bool
  }
  private static let fieldLabels: [String: String] = [
    "legacyclirequiresupdate": "Older global CLI needs an update",
    "supportclipath": "Current support CLI path",
    "capacityrequalificationrequired": "Capacity Requalification Required",
    "jobid": "Job ID", "attemptid": "Attempt ID", "workerid": "Worker ID",
    "machineid": "Machine ID",
    "groupid": "Group ID", "pid": "Process ID", "processid": "Process ID",
    "rssbytes": "Resident memory bytes",
    "cpupct": "CPU percent", "cpupercent": "CPU percent", "gpumemorybytes": "GPU memory bytes",
    "stderr": "Log errors", "stdout": "Log output", "recordedat": "Recorded at",
    "schemaversion": "Schema version", "activeattempts": "Active attempts",
    "currentattempts": "Current attempts",
    "activereleaseversion": "Active release", "readiness": "Readiness", "modelready": "Model ready",
    "localready": "Locally ready", "claimeligible": "Backend eligibility",
    "claimsallowed": "Claims allowed",
    "lastseenat": "Last seen", "policyrevision": "Policy revision", "cachedpolicy": "Cached policy",
    "cachedpolicyagems": "Cached policy age (ms)", "heartbeatagems": "Heartbeat age (ms)",
    "stageelapsedms": "Stage elapsed (ms)", "lastprogressagems": "Progress age (ms)",
    "elapsedms": "Elapsed (ms)", "durationms": "Duration (ms)", "updatedat": "Updated at",
    "createdat": "Created at", "checkedat": "Checked at", "sessionid": "Session ID",
    "childstate": "Engine state",
    "lastsuccessfuljob": "Last successful job", "lastfailedjob": "Last failed job",
    "progressstale": "Progress stale",
    "releaseversion": "Release version", "runtimeversion": "Runtime version",
    "modelsha256": "Model SHA-256",
    "dryrun": "Preview only", "managedroot": "Managed folder", "reclaimedbytes": "Reclaimed bytes",
    "totalbytes": "Total bytes", "inputbytes": "Input bytes", "outputbytes": "Output bytes",
    "workers": "Workers", "recipeid": "Recipe ID", "wallms": "Wall time (ms)",
    "separationms": "Separation (ms)", "modelloadms": "Model loading (ms)",
    "realtimeratio": "Real-time ratio",
    "warmupruns": "Warm-up runs", "measuredruns": "Measured runs",
    "groupsize": "Windows per inference",
    "inputdurationseconds": "Input duration (seconds)",
    "outputdurationseconds": "Output duration (seconds)",
  ]
  static func label(_ field: String) -> String {
    let normalized = field.lowercased().replacingOccurrences(of: "_", with: "")
    if let label = fieldLabels[normalized] { return label }
    let spaced = field.replacingOccurrences(
      of: "([a-z0-9])([A-Z])", with: "$1 $2", options: .regularExpression
    )
    .replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
    return spaced.prefix(128).capitalized
  }
  static func localizedLabel(
    _ label: String, locale: Locale, resources: URL? = Bundle.main.resourceURL
  ) -> String {
    let language = locale.language.languageCode?.identifier == "ar" ? "ar" : "en"
    let localizedBundle =
      resources.flatMap { Bundle(url: $0.appendingPathComponent("\(language).lproj")) } ?? .main
    return label.components(separatedBy: " · ").map {
      localizedBundle.localizedString(forKey: $0, value: $0, table: "Localizable")
    }.joined(separator: " · ")
  }
  static func valueLabel(_ value: String) -> String {
    let states: Set<String> = [
      "active", "paused", "draining", "stopped", "running", "ready", "loading", "warming",
      "recovering", "processing", "failed", "unknown", "separating", "downloading", "uploading",
      "encoding", "validating", "preparing", "restoring", "windows", "seconds", "bytes",
    ]
    return states.contains(value) ? label(value) : value
  }
  static func rows(_ value: DesktopJSON) -> [Row] { projection(value).rows }
  static func projection(_ value: DesktopJSON) -> Projection {
    var result: [Row] = []
    var truncated = false
    func collect(_ value: DesktopJSON, prefix: String, depth: Int) {
      guard depth <= 8, result.count < 1000 else {
        truncated = true
        return
      }
      switch value {
      case .object(let fields):
        for key in fields.keys.sorted() {
          let forbidden = [
            "credential", "password", "secret", "token", "authorization", "enrollment",
            "privatekey", "sourceurl", "mediaurl",
          ]
          guard !forbidden.contains(where: key.lowercased().contains) else { continue }
          if key == "stdout" || key == "stderr", let text = fields[key]?.string {
            let lines = text.split(separator: "\n")
            if lines.count > 1000 { truncated = true }
            for (index, line) in lines.prefix(1000).enumerated() {
              guard result.count < 1000 else {
                truncated = true
                break
              }
              if line.count > 1000 { truncated = true }
              result.append(
                Row(
                  id: "\(result.count)-\(key)", label: "\(label(key)) · #\(index + 1)",
                  value: String(line.filter { !$0.isASCIIControl }.prefix(1000))))
            }
          } else {
            collect(
              fields[key] ?? .null,
              prefix: prefix.isEmpty ? label(key) : "\(prefix) · \(label(key))", depth: depth + 1)
          }
        }
      case .array(let items):
        if items.count > 1000 { truncated = true }
        for (index, item) in items.prefix(1000).enumerated() {
          collect(item, prefix: "\(prefix) · #\(index + 1)", depth: depth + 1)
        }
      default:
        let text: String
        switch value {
        case .string(let string):
          if string.count > 500 { truncated = true }
          text = String(string.filter { !$0.isNewline && !$0.isASCIIControl }.prefix(500))
        case .number(let number):
          text =
            number.rounded() == number && abs(number) < 9_007_199_254_740_992
            ? String(format: "%.0f", number) : String(format: "%.3f", number)
        case .bool(let flag): text = flag ? "Yes" : "No"
        default: text = "Not available"
        }
        result.append(Row(id: "\(result.count)-\(prefix)", label: prefix, value: text))
      }
    }
    collect(value, prefix: "", depth: 0)
    return Projection(rows: result, truncated: truncated)
  }
}

extension Character {
  fileprivate var isASCIIControl: Bool {
    unicodeScalars.contains { $0.value < 32 || $0.value == 127 }
  }
}

private struct WorkerReportView: View {
  @Environment(\.locale) private var locale
  let value: DesktopJSON
  let title: String
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(LocalizedStringKey(title)).desktopFont(.headline)
      let projection = DesktopWorkerReport.projection(value)
      if projection.truncated {
        Label(
          "Report display is limited. Narrow the filters or export diagnostics for more detail.",
          systemImage: "ellipsis.circle"
        )
        .desktopFont(.caption).foregroundStyle(Brand.amber).accessibilityIdentifier(
          "worker_report_truncated")
      }
      if projection.rows.isEmpty {
        Text("No retained records match these filters.").foregroundStyle(Brand.secondary)
      } else {
        LazyVStack(alignment: .leading, spacing: 10) {
          ForEach(projection.rows) { row in
            HStack(alignment: .top, spacing: 20) {
              Text(DesktopWorkerReport.localizedLabel(row.label, locale: locale)).desktopFont(
                .caption
              )
              .foregroundStyle(Brand.secondary)
              .frame(minWidth: 150, maxWidth: 280, alignment: .leading)
              Text(LocalizedStringKey(DesktopWorkerReport.valueLabel(row.value))).desktopFont(
                .caption
              )
              .textSelection(.enabled)
              .frame(maxWidth: .infinity, alignment: .leading)
            }.accessibilityElement(children: .combine)
            Divider()
          }
        }
      }
    }.workerCard()
  }
}
extension View {
  fileprivate func workerCard() -> some View {
    padding(16).frame(maxWidth: .infinity, alignment: .leading)
      .background(Brand.surface, in: RoundedRectangle(cornerRadius: 14))
      .overlay(RoundedRectangle(cornerRadius: 14).stroke(Brand.border, lineWidth: 1))
  }
}
