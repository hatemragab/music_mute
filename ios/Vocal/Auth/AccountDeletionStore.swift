import Foundation

struct AccountDeletionReceipt: Codable, Equatable, Sendable {
  let requestId: String
  let status: String
  let recoverUntil: Date?

  init(requestId: String, status: String, recoverUntil: Date? = nil) {
    self.requestId = requestId
    self.status = status
    self.recoverUntil = recoverUntil
  }
}

/// No credentials or source media: this journal survives an interrupted acceptance or local purge.
actor AccountDeletionStore {
  struct Pending: Codable, Equatable {
    let uid: String
    var receipt: AccountDeletionReceipt?
    var needsReauthentication: Bool? = nil
    var localOnly: Bool? = nil
  }
  private let root: URL
  init(
    root: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Vocal/AccountDeletion", isDirectory: true)
  ) { self.root = root }

  func allPending() throws -> [Pending] {
    guard FileManager.default.fileExists(atPath: root.path) else { return [] }
    return try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
      .filter { $0.pathExtension == "json" }
      .map { try JSONDecoder().decode(Pending.self, from: Data(contentsOf: $0)) }
  }

  func clear(_ uid: String) throws {
    if FileManager.default.fileExists(atPath: path(uid).path) {
      try FileManager.default.removeItem(at: path(uid))
    }
  }

  func pending(_ uid: String) throws -> Pending? {
    let file = path(uid)
    guard FileManager.default.fileExists(atPath: file.path) else { return nil }
    let value = try JSONDecoder().decode(Pending.self, from: Data(contentsOf: file))
    guard value.uid == uid else { throw ProcessingStoreFailure.corruptStore }
    return value
  }

  func save(_ pending: Pending) throws {
    var pending = pending
    if let existing = try self.pending(pending.uid) {
      if let receipt = existing.receipt {
        pending.receipt = receipt
        pending.needsReauthentication = nil
        pending.localOnly = nil
      } else if existing.localOnly != true, existing.needsReauthentication != true,
        pending.localOnly == true
      {
        pending = existing
      }
    }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    var excluded = root
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try excluded.setResourceValues(values)
    try JSONEncoder().encode(pending).write(to: path(pending.uid), options: .atomic)
  }

  private func path(_ uid: String) -> URL {
    root.appendingPathComponent(ProcessingStore.ownerDirectoryName(uid) + ".json")
  }
}

func accountResourceURL(_ key: String, bundle: Bundle = .main) -> URL? {
  guard let raw = bundle.object(forInfoDictionaryKey: key) as? String,
    let url = URL(string: raw), url.scheme == "https", url.host?.isEmpty == false,
    url.user == nil, url.password == nil, url.fragment == nil
  else { return nil }
  return url
}
