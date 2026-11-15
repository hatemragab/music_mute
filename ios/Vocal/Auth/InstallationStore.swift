import Foundation
import UIKit

actor InstallationStore {
  private struct StoredState: Codable {
    var report: InstallationReport
    var successfulBootstrapUID: String?
  }

  private let file: URL
  private var cached: StoredState?

  init(file: URL) {
    self.file = file
  }

  static func applicationStore() -> InstallationStore {
    let support = FileManager.default.urls(
      for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Vocal/Auth", isDirectory: true)
    try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    var mutableSupport = support
    try? mutableSupport.setResourceValues(values)
    return InstallationStore(file: support.appendingPathComponent("installation.json"))
  }

  @MainActor static func currentMetadata(bundle: Bundle = .main, device: UIDevice? = nil) throws
    -> InstallationMetadata
  {
    let device = device ?? .current
    guard
      let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
      (1...32).contains(version.count),
      let buildString = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
      let build = Int(buildString), (1...Int(Int32.max)).contains(build)
    else { throw AuthFailure.configuration }
    let os = device.systemVersion
    let model = device.model
    guard (1...64).contains(os.count), (1...100).contains(model.count) else {
      throw AuthFailure.configuration
    }
    return InstallationMetadata(
      platform: "ios", appVersion: version, buildNumber: build, metadataRevision: 1,
      osVersion: os, deviceModel: model)
  }

  func report(currentMetadata: InstallationMetadata) throws -> InstallationReport {
    var state = try loadOrCreate(metadata: currentMetadata)
    if !state.report.metadata.matches(currentMetadata) {
      guard state.report.metadataRevision < 9_007_199_254_740_991 else {
        throw AuthFailure.configuration
      }
      state.report = InstallationReport(
        installationId: state.report.installationId,
        platform: currentMetadata.platform,
        appVersion: currentMetadata.appVersion,
        buildNumber: currentMetadata.buildNumber,
        metadataRevision: state.report.metadataRevision + 1,
        osVersion: currentMetadata.osVersion,
        deviceModel: currentMetadata.deviceModel)
      try persist(state)
    }
    return state.report
  }

  func reconcile(serverDevice: RegisteredDevice) throws -> InstallationReport {
    guard var state = try loaded(), state.report.installationId == serverDevice.installationId
    else {
      throw AuthFailure.deviceConflict
    }
    guard serverDevice.metadataRevision < 9_007_199_254_740_991 else {
      throw AuthFailure.deviceConflict
    }
    state.report = InstallationReport(
      installationId: state.report.installationId,
      platform: state.report.platform,
      appVersion: state.report.appVersion,
      buildNumber: state.report.buildNumber,
      metadataRevision: max(state.report.metadataRevision, serverDevice.metadataRevision) + 1,
      osVersion: state.report.osVersion,
      deviceModel: state.report.deviceModel)
    try persist(state)
    return state.report
  }

  func successfulBootstrapUID() throws -> String? {
    try loaded()?.successfulBootstrapUID
  }

  func markSuccessfulBootstrap(uid: String) throws {
    guard var state = try loaded() else { throw AuthFailure.configuration }
    state.successfulBootstrapUID = uid
    try persist(state)
  }

  func clearSuccessfulBootstrap() throws {
    guard var state = try loaded() else { return }
    state.successfulBootstrapUID = nil
    try persist(state)
  }

  private func loadOrCreate(metadata: InstallationMetadata) throws -> StoredState {
    if let state = try loaded() { return state }
    let report = InstallationReport(
      installationId: UUID().uuidString.lowercased(), platform: metadata.platform,
      appVersion: metadata.appVersion, buildNumber: metadata.buildNumber, metadataRevision: 1,
      osVersion: metadata.osVersion, deviceModel: metadata.deviceModel)
    let state = StoredState(report: report, successfulBootstrapUID: nil)
    try persist(state)
    return state
  }

  private func loaded() throws -> StoredState? {
    if let cached { return cached }
    guard FileManager.default.fileExists(atPath: file.path) else { return nil }
    do {
      let state = try JSONDecoder().decode(StoredState.self, from: Data(contentsOf: file))
      guard
        UUID(uuidString: state.report.installationId)?.uuidString.lowercased()
          == state.report.installationId,
        state.report.platform == "ios",
        (1...9_007_199_254_740_991).contains(state.report.metadataRevision)
      else { throw AuthFailure.configuration }
      cached = state
      return state
    } catch let failure as AuthFailure {
      throw failure
    } catch {
      throw AuthFailure.configuration
    }
  }

  private func persist(_ state: StoredState) throws {
    do {
      try FileManager.default.createDirectory(
        at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
      let data = try JSONEncoder().encode(state)
      try data.write(to: file, options: [.atomic, .completeFileProtection])
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      var mutableFile = file
      try mutableFile.setResourceValues(values)
      cached = state
    } catch {
      throw AuthFailure.configuration
    }
  }
}

extension InstallationMetadata {
  fileprivate func matches(_ other: InstallationMetadata) -> Bool {
    platform == other.platform && appVersion == other.appVersion && buildNumber == other.buildNumber
      && osVersion == other.osVersion && deviceModel == other.deviceModel
  }
}
