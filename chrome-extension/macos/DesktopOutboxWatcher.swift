import Darwin
import Foundation

/// Watches bounded private receipt directories. It never reads media or polls an HTTP endpoint.
@MainActor final class DesktopOutboxWatcher {
  private let root: URL
  private let uid: String
  private let onPending: () -> Void
  private var sources: [String: DispatchSourceFileSystemObject] = [:]
  private var debounce: Task<Void, Never>?
  private var seen = Set<String>()
  private var active = false
  init(root: URL, uid: String, onPending: @escaping () -> Void) {
    self.root = root
    self.uid = uid
    self.onPending = onPending
  }
  func start() throws {
    guard !active else { return }
    try DesktopPrivateDirectory.prepare(root)
    active = true
    do { try scan() } catch {
      stop()
      throw error
    }
  }
  private func scan() throws {
    guard active else { return }
    try DesktopPrivateDirectory.validate(root)
    let manager = FileManager.default
    var directories = [root]
    let owners = try manager.contentsOfDirectory(
      at: root, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]
    ).prefix(256)
    for owner in owners where DiagnosticIdentity.validDigest(owner.lastPathComponent) {
      if directories.count >= 512 { break }
      guard (try? DesktopPrivateDirectory.validate(owner)) != nil else { continue }
      let properties = try owner.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
      guard properties.isDirectory == true, properties.isSymbolicLink != true else { continue }
      directories.append(owner)
      let receipts = try manager.contentsOfDirectory(
        at: owner, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]
      ).prefix(256)
      for receipt in receipts where UUID(uuidString: receipt.lastPathComponent) != nil {
        if directories.count >= 512 { break }
        guard (try? DesktopPrivateDirectory.validate(receipt)) != nil else { continue }
        let properties = try receipt.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        if properties.isDirectory == true && properties.isSymbolicLink != true {
          directories.append(receipt)
        }
      }
    }
    let paths = Set(directories.map(\.path))
    for (path, source) in sources where !paths.contains(path) {
      source.cancel()
      sources[path] = nil
    }
    var newPending = false
    var pendingIDs = Set<String>()
    for directory in directories {
      let values = try directory.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey])
      let attributes = try manager.attributesOfItem(atPath: directory.path)
      guard values.isSymbolicLink != true, values.isDirectory == true,
        (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == geteuid()
      else { continue }
      if sources[directory.path] == nil {
        let descriptor = open(directory.path, O_EVTONLY | O_NOFOLLOW)
        guard descriptor >= 0 else { continue }
        let source = DispatchSource.makeFileSystemObjectSource(
          fileDescriptor: descriptor, eventMask: [.write, .rename, .delete], queue: .main)
        source.setEventHandler { [weak self] in Task { @MainActor in self?.changed() } }
        source.setCancelHandler { _ = close(descriptor) }
        sources[directory.path] = source
        source.resume()
      }
      guard UUID(uuidString: directory.lastPathComponent) != nil else { continue }
      let record = directory.appendingPathComponent("record.json")
      guard
        let data = privateRecord(record),
        let value = try? JSONDecoder().decode(DesktopJSON.self, from: data),
        value["version"].number == 1, value["owner"]["uid"].string == uid,
        value["state"].string == "pending", let id = value["request_id"].string,
        UUID(uuidString: id) != nil
      else { continue }
      pendingIDs.insert(id)
      if !seen.contains(id) { newPending = true }
    }
    seen = pendingIDs
    if newPending { onPending() }
  }
  private func privateRecord(_ url: URL) -> Data? {
    let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else { return nil }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    defer { try? handle.close() }
    var attributes = stat()
    guard fstat(descriptor, &attributes) == 0, attributes.st_mode & S_IFMT == S_IFREG,
      attributes.st_uid == geteuid(), attributes.st_size > 0, attributes.st_size <= 16_384,
      let data = try? handle.read(upToCount: 16_385), !data.isEmpty, data.count <= 16_384
    else { return nil }
    return data
  }
  private func changed() {
    guard active else { return }
    debounce?.cancel()
    debounce = Task { @MainActor in
      do {
        try await Task.sleep(for: .milliseconds(300))
        try scan()
      } catch {}
    }
  }
  func stop() {
    active = false
    debounce?.cancel()
    debounce = nil
    for source in sources.values { source.cancel() }
    sources = [:]
    seen = []
  }
}
