import Combine
import Darwin
import Foundation

@MainActor private final class FixtureUpdateChecking: NSObject, DesktopUpdateChecking {
  @objc dynamic var canCheckForUpdates = false
  var automaticallyChecksForUpdates = false {
    didSet { preferenceWrites += 1 }
  }
  var startupFails = false
  private(set) var starts = 0
  private(set) var checks = 0
  private(set) var preferenceWrites = 0
  var readinessPublisher: AnyPublisher<Bool, Never> {
    publisher(for: \.canCheckForUpdates, options: [.initial, .new]).eraseToAnyPublisher()
  }
  func startChecking() throws {
    starts += 1
    if startupFails { throw DesktopUpdateGateFailure.unsafe }
  }
  func checkForUpdates() { checks += 1 }
}

@main struct UpdaterTests {
  private static func readExactly(_ handle: FileHandle, count: Int) throws -> Data {
    var result = Data()
    while result.count < count,
      let chunk = try handle.read(upToCount: count - result.count), !chunk.isEmpty
    {
      result.append(chunk)
    }
    return result
  }

  private static func createFixtureBundle(
    at url: URL, helper: URL?, executableHelper: Bool = true,
    updateConfiguration: [String: Any] = [:]
  ) throws -> Bundle {
    let binaries = url.appendingPathComponent("Contents/MacOS", isDirectory: true)
    try FileManager.default.createDirectory(
      at: binaries, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let launcher = binaries.appendingPathComponent("Fixture")
    try Data("#!/bin/sh\nexit 0\n".utf8).write(to: launcher)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: launcher.path)
    if let helper {
      let destination = binaries.appendingPathComponent("MusicMuteInstallHelper")
      try FileManager.default.copyItem(at: helper, to: destination)
      try FileManager.default.setAttributes(
        [.posixPermissions: executableHelper ? 0o700 : 0o600], ofItemAtPath: destination.path)
    }
    var information: [String: Any] = [
      "CFBundleIdentifier": "com.musicmute.fixture.\(UUID().uuidString)",
      "CFBundleExecutable": "Fixture", "CFBundlePackageType": "APPL",
      "CFBundleVersion": "1", "CFBundleShortVersionString": "1.0.0",
    ]
    information.merge(updateConfiguration) { _, configured in configured }
    let plist = try PropertyListSerialization.data(
      fromPropertyList: information, format: .xml, options: 0)
    try plist.write(to: url.appendingPathComponent("Contents/Info.plist"))
    guard let bundle = Bundle(url: url) else {
      preconditionFailure("Synthetic update bundle did not load")
    }
    return bundle
  }

  @MainActor private static func awaitReadiness(
    _ updater: DesktopUpdater, expected: Bool
  ) async throws {
    for _ in 0..<200 {
      if updater.canCheck == expected { return }
      try await Task.sleep(for: .milliseconds(1))
    }
    preconditionFailure("KVO update readiness did not reach the published app state")
  }

  @MainActor private static func updateAvailabilityChecks(
    temporary: URL, configuration: [String: Any]
  ) async throws {
    let validBundle = try createFixtureBundle(
      at: temporary.appendingPathComponent("ConfiguredFixture.app"), helper: nil,
      updateConfiguration: configuration)
    let unavailable = DesktopUpdater(
      bundle: validBundle, support: temporary.appendingPathComponent("unavailable"),
      checkingFactory: { _, _ in nil })
    precondition(unavailable.configured)
    precondition(!unavailable.canConfigureAutomaticChecks && !unavailable.canCheck)
    unavailable.checkForUpdates()
    precondition(unavailable.status == "Update checks are not configured for this build.")

    let inactiveService = FixtureUpdateChecking()
    let preview = DesktopUpdater(
      bundle: validBundle, support: temporary.appendingPathComponent("preview"), fixture: true,
      checkingFactory: { _, _ in inactiveService })
    precondition(
      !preview.configured && !preview.canConfigureAutomaticChecks && !preview.canCheck
        && inactiveService.starts == 0,
      "A fixture must never initialize an updater even when the bundle has valid metadata")
    preview.automaticChecksEnabled = false
    precondition(inactiveService.preferenceWrites == 0)

    let failedService = FixtureUpdateChecking()
    failedService.startupFails = true
    failedService.canCheckForUpdates = true
    let failed = DesktopUpdater(
      bundle: validBundle, support: temporary.appendingPathComponent("failed"),
      checkingFactory: { _, _ in failedService })
    precondition(
      failed.configured && failedService.starts == 1
        && !failed.canConfigureAutomaticChecks && !failed.canCheck)
    precondition(failed.status == "Update checks could not start. Try opening MusicMute again.")
    failed.automaticChecksEnabled = false
    failed.checkForUpdates()
    precondition(failedService.preferenceWrites == 0 && failedService.checks == 0)
    failedService.canCheckForUpdates = false
    failedService.canCheckForUpdates = true
    await Task.yield()
    precondition(!failed.canCheck)

    let service = FixtureUpdateChecking()
    let active = DesktopUpdater(
      bundle: validBundle, support: temporary.appendingPathComponent("working"),
      checkingFactory: { _, _ in service })
    precondition(
      active.configured && active.canConfigureAutomaticChecks && !active.canCheck
        && !active.automaticChecksEnabled && service.starts == 1 && service.preferenceWrites == 0,
      "Initialization must read the saved preference without writing a replacement default")
    var publishedReadiness: [Bool] = []
    let observation = active.$canCheck.sink { publishedReadiness.append($0) }
    active.checkForUpdates()
    precondition(service.checks == 0)
    service.canCheckForUpdates = true
    try await awaitReadiness(active, expected: true)
    active.checkForUpdates()
    precondition(service.checks == 1)
    service.canCheckForUpdates = false
    // The native guard must honor Sparkle immediately, before queued UI delivery.
    active.checkForUpdates()
    precondition(service.checks == 1 && active.status == "An update check is already in progress.")
    try await awaitReadiness(active, expected: false)
    service.canCheckForUpdates = true
    try await awaitReadiness(active, expected: true)
    precondition(publishedReadiness.suffix(3) == [true, false, true])
    active.automaticChecksEnabled = true
    precondition(service.automaticallyChecksForUpdates && service.preferenceWrites == 1)
    active.automaticChecksEnabled = true
    precondition(service.preferenceWrites == 1)
    observation.cancel()
    // Leave queued KVO delivery pending while releasing a separate owner.
    let retiringService = FixtureUpdateChecking()
    var retiring: DesktopUpdater? = DesktopUpdater(
      bundle: validBundle, support: temporary.appendingPathComponent("retiring"),
      checkingFactory: { _, _ in retiringService })
    weak var retired = retiring
    retiringService.canCheckForUpdates = true
    retiring = nil
    precondition(retired == nil, "Readiness observation must not retain the app updater")
    retiringService.canCheckForUpdates = false
    await Task.yield()
  }

  private static func runGuardianBroker(_ arguments: [String]) throws -> Int32 {
    guard arguments.count == 7 else { return 64 }
    let helper = URL(fileURLWithPath: arguments[2])
    let lock = open(arguments[3], O_RDWR | O_CLOEXEC | O_NOFOLLOW)
    guard lock >= 0, flock(lock, LOCK_EX | LOCK_NB) == 0 else { return 65 }
    let process = Process()
    process.executableURL = helper
    process.arguments = [
      "update-guard", String(getpid()), arguments[4], arguments[5], arguments[6],
    ]
    process.standardInput = FileHandle(fileDescriptor: lock, closeOnDealloc: false)
    let output = Pipe()
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    try process.run()
    guard try readExactly(output.fileHandleForReading, count: 6) == Data("READY\n".utf8),
      process.isRunning
    else { return 66 }
    try FileHandle.standardOutput.write(contentsOf: Data("READY\n".utf8))
    _ = close(STDOUT_FILENO)
    return 0
  }

  private static func expectGuardianRefusal(
    helper: URL, arguments: [String], input: Any
  ) throws {
    let process = Process()
    process.executableURL = helper
    process.arguments = arguments
    process.standardInput = input
    let output = Pipe()
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    let bytes = try output.fileHandleForReading.readToEnd() ?? Data()
    precondition(process.terminationStatus != 0 && bytes.isEmpty)
  }

  @MainActor static func main() async throws {
    let arguments = CommandLine.arguments
    if arguments.count > 1, arguments[1] == "--guardian-broker" {
      Darwin.exit(try runGuardianBroker(arguments))
    }
    let key = Data(repeating: 7, count: 32).base64EncodedString()
    let configuration: [String: Any] = [
      "SUFeedURL": "https://updates.example.com/mac/appcast.xml", "SUPublicEDKey": key,
    ]
    precondition(DesktopUpdateConfiguration.read(configuration)?.publicKey == key)
    precondition(DesktopUpdateConfiguration.read([:]) == nil)
    for address in [
      "http://updates.example.com/feed", "https://localhost/feed", "https://127.0.0.1/feed",
      "https://[::1]/feed", "https://user:password@example.com/feed",
      "https://example.com/feed?token=private", "https://example.com/feed#fragment",
      "https://example.com:8443/feed",
    ] {
      precondition(
        DesktopUpdateConfiguration.read(["SUFeedURL": address, "SUPublicEDKey": key]) == nil)
    }
    precondition(
      DesktopUpdateConfiguration.read([
        "SUFeedURL": "https://example.com/feed", "SUPublicEDKey": "invalid",
      ]) == nil)
    precondition(
      DesktopUpdateConfiguration.read([
        "SUFeedURL": "https://example.com/feed",
        "SUPublicEDKey": Data(repeating: 0, count: 31).base64EncodedString(),
      ]) == nil)
    let updater = DesktopUpdater(fixture: true)
    precondition(
      !updater.configured && !updater.canCheck && !updater.canConfigureAutomaticChecks
        && !updater.installationReserved)
    updater.checkForUpdates()
    precondition(updater.status == "Update checks are not configured for this build.")
    updater.isApplicationBusy = { true }
    precondition(!updater.reserveInstallation() && !updater.installationReserved)
    precondition(
      updater.status == "Finish processing and stop playback before installing an update.")
    let resolvedTemporary = realpath(FileManager.default.temporaryDirectory.path, nil)!
    defer { free(resolvedTemporary) }
    let temporary = URL(fileURLWithPath: String(cString: resolvedTemporary)).appendingPathComponent(
      "musicmute-updater-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: temporary, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: temporary) }
    try await updateAvailabilityChecks(temporary: temporary, configuration: configuration)
    let support = temporary.appendingPathComponent("support", isDirectory: true)
    var lease: DesktopUpdateInstallationLease? = try DesktopUpdateInstallationLease(
      support: support)
    let file = open(support.appendingPathComponent("update.lock").path, O_RDWR | O_NOFOLLOW)
    precondition(file >= 0)
    defer { _ = close(file) }
    precondition(flock(file, LOCK_SH | LOCK_NB) != 0 && errno == EWOULDBLOCK)
    precondition(lease?.descriptor != nil)
    lease = nil
    precondition(flock(file, LOCK_SH | LOCK_NB) == 0)
    do {
      _ = try DesktopUpdateInstallationLease(support: support)
      preconditionFailure("A running helper must prevent installation")
    } catch DesktopUpdateGateFailure.busy {}
    precondition(flock(file, LOCK_UN) == 0)
    lease = try DesktopUpdateInstallationLease(support: support)
    lease = nil
    let foreign = temporary.appendingPathComponent("foreign")
    try Data("unchanged".utf8).write(to: foreign)
    let unsafe = temporary.appendingPathComponent("unsafe", isDirectory: true)
    try FileManager.default.createDirectory(
      at: unsafe, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    try FileManager.default.createSymbolicLink(
      at: unsafe.appendingPathComponent("update.lock"), withDestinationURL: foreign)
    do {
      _ = try DesktopUpdateInstallationLease(support: unsafe)
      preconditionFailure("Symlink lock must be rejected")
    } catch DesktopUpdateGateFailure.unsafe {}
    let unchanged = try Data(contentsOf: foreign)
    precondition(unchanged == Data("unchanged".utf8))

    guard
      let helperPath = ProcessInfo.processInfo.environment[
        "MUSICMUTE_INSTALL_HELPER_TEST_PATH"]
    else { preconditionFailure("Compiled install helper fixture is missing") }
    let helper = URL(fileURLWithPath: helperPath)
    let thinApp = temporary.appendingPathComponent("ThinFixture.app", isDirectory: true)
    let thinBundle = try createFixtureBundle(at: thinApp, helper: helper)
    let thinSupport = temporary.appendingPathComponent("thin-support", isDirectory: true)
    let thinUpdater = DesktopUpdater(bundle: thinBundle, support: thinSupport, fixture: true)
    precondition(
      thinUpdater.reserveInstallation() && thinUpdater.installationReserved,
      "A thin app without any external runtime must reserve an update")
    precondition(
      !FileManager.default.fileExists(
        atPath: thinApp.appendingPathComponent("Contents/Resources/runtime-bootstrap.json").path))
    let thinProbe = open(
      thinSupport.appendingPathComponent("update.lock").path, O_RDWR | O_CLOEXEC | O_NOFOLLOW)
    precondition(thinProbe >= 0)
    precondition(flock(thinProbe, LOCK_SH | LOCK_NB) != 0 && errno == EWOULDBLOCK)
    thinUpdater.releaseInstallationForTesting()
    var released = false
    for _ in 0..<300 {
      if flock(thinProbe, LOCK_SH | LOCK_NB) == 0 {
        released = true
        _ = flock(thinProbe, LOCK_UN)
        break
      }
      usleep(10_000)
    }
    precondition(released)
    _ = close(thinProbe)

    // A UI controller owns this same shared lease until its process actually exits.
    // Reservation must await its suspension rather than repeatedly failing the exclusive flock.
    let arbitrationSupport = temporary.appendingPathComponent("arbitration-support")
    var executionLease: RuntimeUpdateExecutionTestLease? = try RuntimeUpdateExecutionTestLease(
      support: arbitrationSupport)
    let arbitration = DesktopUpdater(bundle: thinBundle, support: arbitrationSupport, fixture: true)
    var preparationStarted = false
    var preparationWait: CheckedContinuation<Void, Never>?
    var resumes = 0
    arbitration.prepareInstallation = {
      preparationStarted = true
      await withCheckedContinuation { preparationWait = $0 }
      executionLease = nil
    }
    arbitration.onInstallationReleased = { resumes += 1 }
    let reservation = Task { @MainActor in await arbitration.prepareAndReserveInstallation() }
    while !preparationStarted { await Task.yield() }
    precondition(
      arbitration.installationPreparing && !arbitration.installationReserved
        && executionLease != nil)
    let coalesced = Task { @MainActor in await arbitration.prepareAndReserveInstallation() }
    await Task.yield()
    preparationWait?.resume()
    preparationWait = nil
    let firstReserved = await reservation.value
    let secondReserved = await coalesced.value
    precondition(
      firstReserved && secondReserved && arbitration.installationReserved
        && !arbitration.installationPreparing)
    arbitration.releaseInstallationForTesting()
    precondition(resumes == 1)

    let cancelled = DesktopUpdater(
      bundle: thinBundle, support: temporary.appendingPathComponent("cancelled-support"),
      fixture: true)
    var cancelledStarted = false
    var cancelledWait: CheckedContinuation<Void, Never>?
    var cancelledResumes = 0
    cancelled.prepareInstallation = {
      cancelledStarted = true
      await withCheckedContinuation { cancelledWait = $0 }
    }
    cancelled.onInstallationReleased = { cancelledResumes += 1 }
    let pending = Task { @MainActor in await cancelled.prepareAndReserveInstallation() }
    while !cancelledStarted { await Task.yield() }
    cancelled.releaseInstallationForTesting()
    cancelledWait?.resume()
    cancelledWait = nil
    let cancelledReserved = await pending.value
    precondition(
      !cancelledReserved && !cancelled.installationReserved && !cancelled.installationPreparing
        && cancelledResumes == 1)

    let failing = DesktopUpdater(
      bundle: thinBundle, support: temporary.appendingPathComponent("failing-support"),
      fixture: true)
    var failureResumes = 0
    failing.prepareInstallation = { throw DesktopUpdateGateFailure.unsafe }
    failing.onInstallationReleased = { failureResumes += 1 }
    let failureReserved = await failing.prepareAndReserveInstallation()
    precondition(
      !failureReserved && !failing.installationPreparing && !failing.installationReserved
        && failureResumes == 1)

    let missingApp = temporary.appendingPathComponent("MissingHelper.app", isDirectory: true)
    let missingBundle = try createFixtureBundle(at: missingApp, helper: nil)
    precondition(
      !DesktopUpdater(
        bundle: missingBundle,
        support: temporary.appendingPathComponent("missing-support"), fixture: true
      ).reserveInstallation())
    let invalidApp = temporary.appendingPathComponent("InvalidHelper.app", isDirectory: true)
    let invalidBundle = try createFixtureBundle(
      at: invalidApp, helper: helper, executableHelper: false)
    precondition(
      !DesktopUpdater(
        bundle: invalidBundle,
        support: temporary.appendingPathComponent("invalid-support"), fixture: true
      ).reserveInstallation())

    var thinIdentity = stat()
    precondition(lstat(thinApp.path, &thinIdentity) == 0)
    let leaseInput = open(
      thinSupport.appendingPathComponent("update.lock").path,
      O_RDWR | O_CLOEXEC | O_NOFOLLOW)
    precondition(leaseInput >= 0)
    defer { _ = close(leaseInput) }
    try expectGuardianRefusal(
      helper: helper,
      arguments: [
        "update-guard", String(getpid()), thinApp.path, String(thinIdentity.st_dev),
        String(thinIdentity.st_ino + 1),
      ], input: FileHandle(fileDescriptor: leaseInput, closeOnDealloc: false))
    let nonregular = Pipe()
    try expectGuardianRefusal(
      helper: helper,
      arguments: [
        "update-guard", String(getpid()), thinApp.path, String(thinIdentity.st_dev),
        String(thinIdentity.st_ino),
      ], input: nonregular)

    let lifecycleApp = temporary.appendingPathComponent("LifecycleFixture.app", isDirectory: true)
    let lifecycleBundle = try createFixtureBundle(at: lifecycleApp, helper: helper)
    let lifecycleBundleURL = lifecycleBundle.bundleURL
    let lifecycleSupport = temporary.appendingPathComponent("lifecycle-support", isDirectory: true)
    do {
      let lifecycleLease = try DesktopUpdateInstallationLease(support: lifecycleSupport)
      precondition(lifecycleLease.descriptor >= 0)
    }
    var lifecycleIdentity = stat()
    precondition(lstat(lifecycleBundleURL.path, &lifecycleIdentity) == 0)
    let broker = Process()
    broker.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    broker.arguments = [
      "--guardian-broker", helper.path,
      lifecycleSupport.appendingPathComponent("update.lock").path, lifecycleBundleURL.path,
      String(lifecycleIdentity.st_dev), String(lifecycleIdentity.st_ino),
    ]
    let brokerOutput = Pipe()
    broker.standardOutput = brokerOutput
    broker.standardError = FileHandle.nullDevice
    try broker.run()
    let brokerReady = try readExactly(brokerOutput.fileHandleForReading, count: 6)
    precondition(brokerReady == Data("READY\n".utf8))
    broker.waitUntilExit()
    precondition(broker.terminationStatus == 0)
    let lifecycleProbe = open(
      lifecycleSupport.appendingPathComponent("update.lock").path,
      O_RDWR | O_CLOEXEC | O_NOFOLLOW)
    precondition(lifecycleProbe >= 0)
    precondition(flock(lifecycleProbe, LOCK_SH | LOCK_NB) != 0 && errno == EWOULDBLOCK)
    usleep(300_000)
    precondition(flock(lifecycleProbe, LOCK_SH | LOCK_NB) != 0 && errno == EWOULDBLOCK)
    let replacedApp = temporary.appendingPathComponent("LifecycleFixture.previous.app")
    try FileManager.default.moveItem(at: lifecycleApp, to: replacedApp)
    try FileManager.default.createDirectory(
      at: lifecycleApp, withIntermediateDirectories: false,
      attributes: [.posixPermissions: 0o700])
    var guardianReleased = false
    for _ in 0..<300 {
      if flock(lifecycleProbe, LOCK_SH | LOCK_NB) == 0 {
        guardianReleased = true
        _ = flock(lifecycleProbe, LOCK_UN)
        break
      }
      usleep(10_000)
    }
    precondition(guardianReleased)
    _ = close(lifecycleProbe)

    let quietApp = temporary.appendingPathComponent("QuietFixture.app", isDirectory: true)
    let quietBundle = try createFixtureBundle(at: quietApp, helper: helper)
    let quietBundleURL = quietBundle.bundleURL
    let quietSupport = temporary.appendingPathComponent("quiet-support", isDirectory: true)
    do {
      let quietLease = try DesktopUpdateInstallationLease(support: quietSupport)
      precondition(quietLease.descriptor >= 0)
    }
    var quietIdentity = stat()
    precondition(lstat(quietBundleURL.path, &quietIdentity) == 0)
    let quietBroker = Process()
    quietBroker.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    quietBroker.arguments = [
      "--guardian-broker", helper.path,
      quietSupport.appendingPathComponent("update.lock").path, quietBundleURL.path,
      String(quietIdentity.st_dev), String(quietIdentity.st_ino),
    ]
    let quietOutput = Pipe()
    quietBroker.standardOutput = quietOutput
    quietBroker.standardError = FileHandle.nullDevice
    try quietBroker.run()
    let quietReady = try readExactly(quietOutput.fileHandleForReading, count: 6)
    precondition(quietReady == Data("READY\n".utf8))
    quietBroker.waitUntilExit()
    precondition(quietBroker.terminationStatus == 0)
    let quietProbe = open(
      quietSupport.appendingPathComponent("update.lock").path,
      O_RDWR | O_CLOEXEC | O_NOFOLLOW)
    precondition(quietProbe >= 0)
    precondition(flock(quietProbe, LOCK_SH | LOCK_NB) != 0 && errno == EWOULDBLOCK)
    let quietStarted = ProcessInfo.processInfo.systemUptime
    var quietReleased = false
    for _ in 0..<800 {
      if flock(quietProbe, LOCK_SH | LOCK_NB) == 0 {
        quietReleased = true
        _ = flock(quietProbe, LOCK_UN)
        break
      }
      usleep(10_000)
    }
    let quietElapsed = ProcessInfo.processInfo.systemUptime - quietStarted
    precondition(quietReleased && quietElapsed >= 1.8)
    _ = close(quietProbe)
    print(
      "UpdaterTests: configuration, observable readiness, unavailable/failed startup, runtime-independent native update guardian, lifecycle, leases and symlink safety passed"
    )
  }
}
