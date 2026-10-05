import AppKit
import Combine
import Darwin
import Foundation

#if canImport(Sparkle)
  import Sparkle
#endif

struct DesktopUpdateConfiguration: Equatable {
  let feed: URL
  let publicKey: String
  static func read(_ values: [String: Any]) -> DesktopUpdateConfiguration? {
    guard let text = values["SUFeedURL"] as? String,
      let parts = URLComponents(string: text), parts.scheme == "https",
      let host = parts.host, !host.isEmpty, host.lowercased() != "localhost",
      !host.hasPrefix("127."), host != "::1", host != "[::1]", parts.user == nil,
      parts.password == nil,
      parts.query == nil, parts.fragment == nil, parts.port == nil, let feed = parts.url,
      let key = values["SUPublicEDKey"] as? String,
      let decoded = Data(base64Encoded: key), decoded.count == 32,
      decoded.base64EncodedString() == key
    else { return nil }
    return DesktopUpdateConfiguration(feed: feed, publicKey: key)
  }
}

enum DesktopUpdateGateFailure: Error { case busy, unsafe }

/// One permanent inode is shared with every packaged control/acquisition process.
/// Retaining the exclusive descriptor prevents new Chrome work from racing a replace.
final class DesktopUpdateInstallationLease {
  private(set) var descriptor: Int32 = -1
  init(support: URL) throws {
    let path = support.path
    guard path.hasPrefix("/"), path != "/", !path.contains("\0"),
      !path.split(separator: "/").contains("..")
    else { throw DesktopUpdateGateFailure.unsafe }
    let root = RuntimePOSIXCall.retryingInteger {
      open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
    }
    var directory = root.value
    guard root.succeeded else { throw DesktopUpdateGateFailure.unsafe }
    defer { _ = close(directory) }
    for component in path.split(separator: "/") {
      let name = String(component)
      var opened = RuntimePOSIXCall.retryingInteger {
        openat(directory, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
      }
      if !opened.succeeded && opened.error == ENOENT {
        let created = RuntimePOSIXCall.retryingInteger { mkdirat(directory, name, 0o700) }
        guard created.succeeded || created.error == EEXIST else {
          throw DesktopUpdateGateFailure.unsafe
        }
        opened = RuntimePOSIXCall.retryingInteger {
          openat(directory, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        }
      }
      guard opened.succeeded else { throw DesktopUpdateGateFailure.unsafe }
      let child = opened.value
      var info = stat()
      let inspected = RuntimePOSIXCall.retryingInteger { fstat(child, &info) }
      guard inspected.succeeded, info.st_uid == 0 || info.st_uid == getuid() else {
        _ = close(child)
        throw DesktopUpdateGateFailure.unsafe
      }
      _ = close(directory)
      directory = child
    }
    var parent = stat()
    let inspectedParent = RuntimePOSIXCall.retryingInteger { fstat(directory, &parent) }
    guard inspectedParent.succeeded, parent.st_uid == getuid(),
      parent.st_mode & 0o777 == 0o700
    else { throw DesktopUpdateGateFailure.unsafe }
    let openedFile = RuntimeUpdateLockFile.open(in: directory)
    guard openedFile.succeeded else { throw DesktopUpdateGateFailure.unsafe }
    let file = openedFile.value
    var info = stat()
    var named = stat()
    let inspectedFile = RuntimePOSIXCall.retryingInteger { fstat(file, &info) }
    let inspectedName = RuntimePOSIXCall.retryingInteger {
      fstatat(directory, "update.lock", &named, AT_SYMLINK_NOFOLLOW)
    }
    guard inspectedFile.succeeded, inspectedName.succeeded,
      info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1, info.st_uid == getuid(),
      info.st_mode & 0o777 == 0o600, info.st_dev == named.st_dev, info.st_ino == named.st_ino
    else {
      _ = close(file)
      throw DesktopUpdateGateFailure.unsafe
    }
    let locked = RuntimePOSIXCall.retryingInteger { flock(file, LOCK_EX | LOCK_NB) }
    guard locked.succeeded else {
      let busy = RuntimePOSIXCall.wouldBlock(locked.error)
      _ = close(file)
      throw busy ? DesktopUpdateGateFailure.busy : .unsafe
    }
    var namedAfterLock = stat()
    let inspectedNameAfterLock = RuntimePOSIXCall.retryingInteger {
      fstatat(directory, "update.lock", &namedAfterLock, AT_SYMLINK_NOFOLLOW)
    }
    guard inspectedNameAfterLock.succeeded,
      namedAfterLock.st_mode & S_IFMT == S_IFREG,
      info.st_dev == namedAfterLock.st_dev, info.st_ino == namedAfterLock.st_ino
    else {
      _ = RuntimePOSIXCall.retryingInteger { flock(file, LOCK_UN) }
      _ = close(file)
      throw DesktopUpdateGateFailure.unsafe
    }
    descriptor = file
  }
  deinit { if descriptor >= 0 { _ = close(descriptor) } }
}

private final class DesktopUpdaterStartup: @unchecked Sendable {
  private let lock = NSLock()
  private var acknowledged = false
  func accept(_ bytes: Data?) {
    lock.lock()
    acknowledged = bytes == Data("READY\n".utf8)
    lock.unlock()
  }
  func read(from handle: FileHandle) {
    var bytes = Data()
    do {
      while bytes.count < 6,
        let chunk = try handle.read(upToCount: 6 - bytes.count), !chunk.isEmpty
      {
        bytes.append(chunk)
      }
      accept(bytes)
    } catch { accept(nil) }
  }
  var ready: Bool {
    lock.lock()
    defer { lock.unlock() }
    return acknowledged
  }
}

@MainActor final class DesktopUpdater: NSObject, ObservableObject {
  @Published private(set) var status = "Update checks are not configured for this build."
  @Published private(set) var installationReserved = false
  @Published private(set) var canTerminateForUpdate = false
  @Published var automaticChecksEnabled = true {
    didSet {
      #if canImport(Sparkle)
        updater?.automaticallyChecksForUpdates = automaticChecksEnabled
      #endif
    }
  }
  var isApplicationBusy: () -> Bool = { false }
  private let bundle: Bundle
  private let support: URL
  private let configuration: DesktopUpdateConfiguration?
  private var lease: DesktopUpdateInstallationLease?
  private var guardian: Process?
  #if canImport(Sparkle)
    private var updater: SPUUpdater?
    private var userDriver: DesktopUpdateUserDriver?
  #endif
  var configured: Bool { configuration != nil }
  var canCheck: Bool {
    #if canImport(Sparkle)
      return updater?.canCheckForUpdates == true
    #else
      return false
    #endif
  }
  init(bundle: Bundle = .main, support: URL = LocalPaths.support, fixture: Bool = false) {
    self.bundle = bundle
    self.support = support
    configuration = fixture ? nil : DesktopUpdateConfiguration.read(bundle.infoDictionary ?? [:])
    super.init()
    guard let configuration else { return }
    #if canImport(Sparkle)
      let driver = DesktopUpdateUserDriver(bundle: bundle, owner: self)
      userDriver = driver
      let service = SPUUpdater(
        hostBundle: bundle, applicationBundle: bundle, userDriver: driver, delegate: self)
      updater = service
      do {
        try service.start()
        service.clearFeedURLFromUserDefaults()
        service.sendsSystemProfile = false
        // Downloads require a user choice so Sparkle never installs on normal quit.
        service.automaticallyDownloadsUpdates = false
        automaticChecksEnabled = service.automaticallyChecksForUpdates
        status = "Automatic update checks are ready."
        _ = configuration
      } catch {
        updater = nil
        status = "Update checks could not start. Try opening MusicMute again."
      }
    #else
      _ = configuration
      status = "The update framework is unavailable in this preview build."
    #endif
  }
  func checkForUpdates() {
    #if canImport(Sparkle)
      guard let updater else {
        status = "Update checks are not configured for this build."
        return
      }
      guard updater.canCheckForUpdates else {
        status = "An update check is already in progress."
        return
      }
      status = "Checking for updates…"
      updater.checkForUpdates()
    #else
      status = "Update checks are not configured for this build."
    #endif
  }
  func reserveInstallation() -> Bool {
    if installationReserved {
      guard guardian?.isRunning == true else {
        releaseInstallation()
        status = "The update safety helper stopped. Try checking for updates again."
        return false
      }
      return !isApplicationBusy()
    }
    guard !isApplicationBusy() else {
      status = "Finish processing and stop playback before installing an update."
      return false
    }
    do {
      let acquired = try DesktopUpdateInstallationLease(support: support)
      var identity = stat()
      guard lstat(bundle.bundleURL.path, &identity) == 0,
        identity.st_mode & S_IFMT == S_IFDIR
      else { throw DesktopUpdateGateFailure.unsafe }
      let helper = bundle.bundleURL.appendingPathComponent(
        "Contents/MacOS/MusicMuteInstallHelper")
      var helperIdentity = stat()
      guard lstat(helper.path, &helperIdentity) == 0,
        helperIdentity.st_mode & S_IFMT == S_IFREG,
        helperIdentity.st_nlink == 1,
        helperIdentity.st_uid == identity.st_uid,
        helperIdentity.st_mode & 0o111 != 0,
        helperIdentity.st_mode & 0o022 == 0
      else { throw DesktopUpdateGateFailure.unsafe }
      let process = Process()
      process.executableURL = helper
      process.arguments = [
        "update-guard", String(getpid()), bundle.bundleURL.path, String(identity.st_dev),
        String(identity.st_ino),
      ]
      process.environment = [
        "HOME": FileManager.default.homeDirectoryForCurrentUser.path, "PATH": "/usr/bin:/bin",
        "LANG": "en_US.UTF-8",
      ]
      process.standardInput = FileHandle(fileDescriptor: acquired.descriptor, closeOnDealloc: false)
      let output = Pipe()
      process.standardOutput = output
      process.standardError = FileHandle.nullDevice
      try process.run()
      let startup = DesktopUpdaterStartup()
      let semaphore = DispatchSemaphore(value: 0)
      DispatchQueue.global(qos: .userInitiated).async {
        startup.read(from: output.fileHandleForReading)
        semaphore.signal()
      }
      guard semaphore.wait(timeout: .now() + 2) == .success, startup.ready, process.isRunning else {
        RuntimeProcessRunner.stop(process)
        throw DesktopUpdateGateFailure.unsafe
      }
      lease = acquired
      guardian = process
      installationReserved = true
      status = "Installing an update. New processing is paused until MusicMute restarts."
      return true
    } catch DesktopUpdateGateFailure.busy {
      status =
        "Stop MusicMute processing and playback in Chrome, then retry installing the update."
    } catch {
      status =
        "The update could not safely pause local processing. Restart MusicMute and try again."
    }
    return false
  }
  fileprivate func releaseInstallation() {
    if let guardian { RuntimeProcessRunner.stop(guardian) }
    guardian = nil
    lease = nil
    installationReserved = false
    canTerminateForUpdate = false
  }
  #if MUSICMUTE_NATIVE_TESTS
    func releaseInstallationForTesting() { releaseInstallation() }
  #endif
  fileprivate func confirmInstallerHandoff() -> Bool {
    guard reserveInstallation(),
      NSRunningApplication.runningApplications(
        withBundleIdentifier: "org.sparkle-project.Sparkle.Updater"
      ).contains(where: { !$0.isTerminated })
    else {
      status = "The update installer is not ready. Cancel the update and try again."
      return false
    }
    canTerminateForUpdate = true
    return true
  }
}

#if canImport(Sparkle)
  extension DesktopUpdater: SPUUpdaterDelegate {
    func feedURLString(for updater: SPUUpdater) -> String? { configuration?.feed.absoluteString }
    func allowedSystemProfileKeys(for updater: SPUUpdater) -> [String]? { [] }
    func updater(
      _ updater: SPUUpdater, shouldProceedWithUpdate item: SUAppcastItem,
      updateCheck: SPUUpdateCheck
    ) throws {
      guard !item.isInformationOnlyUpdate,
        let url = item.fileURL, url.scheme == "https", url.user == nil, url.password == nil,
        url.fragment == nil, url.port == nil
      else {
        throw NSError(
          domain: "MusicMuteUpdater", code: 1,
          userInfo: [NSLocalizedDescriptionKey: "The update download address is invalid."])
      }
    }
    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
      releaseInstallation()
      status = "The update did not finish. Check your connection and try again."
    }
    func updater(
      _ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?
    ) {
      if !installationReserved {
        if let issue = error as NSError?, issue.domain == SUSparkleErrorDomain,
          issue.code == SUError.noUpdateError.rawValue
        {
          status = "MusicMute is up to date."
        } else {
          status =
            error == nil ? "Update check finished." : "The update check did not finish. Try again."
        }
      }
    }
  }

  /// Keep Sparkle's standard UI while reserving the shared gate before any install
  /// preparation. Dismiss at the ready stage cancels rather than installs on quit.
  @MainActor private final class DesktopUpdateUserDriver: NSObject, SPUUserDriver {
    private let standard: SPUStandardUserDriver
    private weak var owner: DesktopUpdater?
    init(bundle: Bundle, owner: DesktopUpdater) {
      standard = SPUStandardUserDriver(hostBundle: bundle, delegate: nil)
      self.owner = owner
    }
    func show(
      _ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void
    ) { standard.show(request, reply: reply) }
    func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {
      standard.showUserInitiatedUpdateCheck(cancellation: cancellation)
    }
    func showUpdateFound(
      with appcastItem: SUAppcastItem, state: SPUUserUpdateState,
      reply: @escaping (SPUUserUpdateChoice) -> Void
    ) {
      standard.showUpdateFound(with: appcastItem, state: state) { [weak self] choice in
        guard choice == .install else {
          reply(choice)
          return
        }
        let safe =
          state.stage == .installing
          ? self?.owner?.confirmInstallerHandoff() == true
          : self?.owner?.reserveInstallation() == true
        guard safe else {
          reply(state.stage == .installing ? .skip : .dismiss)
          return
        }
        reply(.install)
      }
    }
    func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {
      standard.showUpdateReleaseNotes(with: downloadData)
    }
    func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) {
      standard.showUpdateReleaseNotesFailedToDownloadWithError(error)
    }
    func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) {
      standard.showUpdateNotFoundWithError(error, acknowledgement: acknowledgement)
    }
    func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) {
      owner?.releaseInstallation()
      standard.showUpdaterError(error, acknowledgement: acknowledgement)
    }
    func showDownloadInitiated(cancellation: @escaping () -> Void) {
      standard.showDownloadInitiated(cancellation: cancellation)
    }
    func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {
      standard.showDownloadDidReceiveExpectedContentLength(expectedContentLength)
    }
    func showDownloadDidReceiveData(ofLength length: UInt64) {
      standard.showDownloadDidReceiveData(ofLength: length)
    }
    func showDownloadDidStartExtractingUpdate() { standard.showDownloadDidStartExtractingUpdate() }
    func showExtractionReceivedProgress(_ progress: Double) {
      standard.showExtractionReceivedProgress(progress)
    }
    func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
      standard.showReady(toInstallAndRelaunch: { [weak self] choice in
        guard choice == .install, self?.owner?.confirmInstallerHandoff() == true else {
          reply(.skip)
          return
        }
        reply(.install)
      })
    }
    func showInstallingUpdate(
      withApplicationTerminated applicationTerminated: Bool,
      retryTerminatingApplication: @escaping () -> Void
    ) {
      standard.showInstallingUpdate(
        withApplicationTerminated: applicationTerminated,
        retryTerminatingApplication: retryTerminatingApplication)
    }
    func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void)
    { standard.showUpdateInstalledAndRelaunched(relaunched, acknowledgement: acknowledgement) }
    func dismissUpdateInstallation() {
      owner?.releaseInstallation()
      standard.dismissUpdateInstallation()
    }
    func showUpdateInFocus() { standard.showUpdateInFocus() }
  }
#endif
