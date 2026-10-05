import Darwin
import Foundation

enum DesktopPrivateDirectory {
  static func validate(_ url: URL) throws {
    var attributes = stat()
    guard lstat(url.path, &attributes) == 0,
      attributes.st_mode & S_IFMT == S_IFDIR, attributes.st_uid == geteuid()
    else { throw DesktopAuthFailure.service("ACCOUNT_SCOPE_UNAVAILABLE") }
  }
  static func prepare(_ url: URL) throws {
    var attributes = stat()
    if lstat(url.path, &attributes) == 0 {
      try validate(url)
      return
    }
    guard errno == ENOENT else { throw DesktopAuthFailure.service("ACCOUNT_SCOPE_UNAVAILABLE") }
    try FileManager.default.createDirectory(
      at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try validate(url)
  }
}

struct DesktopAccountStateStore: Sendable {
  let support: URL
  init(support: URL = LocalPaths.support) { self.support = support }
  func publish(_ scope: DesktopSessionScope?) throws {
    let manager = FileManager.default
    try DesktopPrivateDirectory.prepare(support)
    let destination = support.appendingPathComponent("account-state.json")
    let temporary = support.appendingPathComponent(".account-state-\(UUID().uuidString).tmp")
    let descriptor = open(temporary.path, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else { throw DesktopAuthFailure.service("ACCOUNT_SCOPE_UNAVAILABLE") }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    do {
      let data = try JSONEncoder().encode(
        DesktopJSON.object([
          "version": .number(1),
          "firebase_uid": scope.map { .string($0.firebaseUid) } ?? .null,
          "session_generation": scope.map { .string($0.generation.uuidString.lowercased()) }
            ?? .null,
        ]))
      try handle.write(contentsOf: data)
      guard fsync(descriptor) == 0 else {
        throw DesktopAuthFailure.service("ACCOUNT_SCOPE_UNAVAILABLE")
      }
      try handle.close()
      guard rename(temporary.path, destination.path) == 0 else {
        throw DesktopAuthFailure.service("ACCOUNT_SCOPE_UNAVAILABLE")
      }
      let directory = open(support.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
      if directory >= 0 {
        _ = fsync(directory)
        _ = close(directory)
      }
    } catch {
      try? handle.close()
      try? manager.removeItem(at: temporary)
      throw error
    }
  }
}
