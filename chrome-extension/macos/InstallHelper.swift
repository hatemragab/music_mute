import Darwin
import Foundation

@main enum MusicMuteInstallHelper {
  private static func fail(_ code: String) -> Never {
    FileHandle.standardError.write(Data("\(code)\n".utf8))
    Darwin.exit(1)
  }

  private static func safeParentPath(_ value: String) -> Bool {
    value.hasPrefix("/") && value.utf8.count <= Int(PATH_MAX) && !value.contains("\0")
      && URL(fileURLWithPath: value, isDirectory: true).standardizedFileURL.path == value
  }

  private static func safeLeaf(_ value: String) -> Bool {
    !value.isEmpty && value != "." && value != ".." && value.utf8.count <= Int(NAME_MAX)
      && !value.contains("/") && !value.contains("\0")
  }

  private static func matches(_ information: stat, device: String, inode: String) -> Bool {
    String(information.st_dev) == device && String(information.st_ino) == inode
  }

  private static func openParent(_ path: String, device: String, inode: String) -> Int32 {
    let descriptor = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
    guard descriptor >= 0 else { fail("INSTALL_PARENT_CHANGED") }
    var information = stat()
    guard fstat(descriptor, &information) == 0,
      information.st_mode & S_IFMT == S_IFDIR,
      matches(information, device: device, inode: inode)
    else {
      close(descriptor)
      fail("INSTALL_PARENT_CHANGED")
    }
    return descriptor
  }

  private static func parentAlive(_ pid: pid_t) -> Bool {
    if kill(pid, 0) == 0 { return true }
    return errno == EPERM || errno != ESRCH
  }

  private static func sparkleInstallerActive() -> Bool? {
    let stride = MemoryLayout<kinfo_proc>.stride
    for _ in 0..<3 {
      var query: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]
      var requiredBytes = 0
      guard sysctl(&query, u_int(query.count), nil, &requiredBytes, nil, 0) == 0,
        requiredBytes >= 0
      else { return nil }
      let capacity = requiredBytes / stride + 64
      guard capacity > 0, capacity <= 32_768 else { return nil }
      var processes = [kinfo_proc](repeating: kinfo_proc(), count: capacity)
      var actualBytes = processes.count * stride
      if sysctl(&query, u_int(query.count), &processes, &actualBytes, nil, 0) == 0 {
        guard actualBytes >= 0, actualBytes % stride == 0,
          actualBytes / stride <= processes.count
        else { return nil }
        for index in 0..<(actualBytes / stride) {
          let processName = withUnsafePointer(to: processes[index].kp_proc.p_comm) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: Int(MAXCOMLEN)) { characters in
              let buffer = UnsafeBufferPointer(start: characters, count: Int(MAXCOMLEN))
              let end = buffer.firstIndex(of: 0) ?? buffer.endIndex
              return String(
                decoding: buffer[..<end].map { UInt8(bitPattern: $0) }, as: UTF8.self)
            }
          }
          if ["Autoupdate", "Installer", "Updater"].contains(processName) {
            return true
          }
        }
        return false
      }
      guard errno == ENOMEM else { return nil }
    }
    return nil
  }

  private static func writeReady() {
    let ready = Array("READY\n".utf8)
    let wroteAll = ready.withUnsafeBytes { bytes -> Bool in
      guard let base = bytes.baseAddress else { return false }
      var offset = 0
      while offset < bytes.count {
        let written = write(STDOUT_FILENO, base.advanced(by: offset), bytes.count - offset)
        if written > 0 {
          offset += written
        } else if written < 0 && errno == EINTR {
          continue
        } else {
          return false
        }
      }
      return true
    }
    guard wroteAll, close(STDOUT_FILENO) == 0 else { fail("UPDATE_GUARD_READY_FAILED") }
  }

  private static func runUpdateGuard(_ arguments: [String]) {
    guard arguments.count == 6, arguments[1] == "update-guard",
      let parent = pid_t(arguments[2]), parent > 1, parent != getpid()
    else { fail("UPDATE_GUARD_INVALID_ARGUMENTS") }
    guard safeParentPath(arguments[3]), arguments[3] != "/",
      URL(fileURLWithPath: arguments[3], isDirectory: true).pathExtension == "app"
    else { fail("UPDATE_GUARD_INVALID_BUNDLE_PATH") }
    guard UInt64(arguments[4]) != nil, UInt64(arguments[5]) != nil else {
      fail("UPDATE_GUARD_INVALID_IDENTITY")
    }
    guard getppid() == parent, parentAlive(parent) else {
      fail("UPDATE_GUARD_PARENT_CHANGED")
    }

    var lease = stat()
    guard fstat(STDIN_FILENO, &lease) == 0,
      lease.st_mode & S_IFMT == S_IFREG, lease.st_uid == getuid(),
      lease.st_nlink == 1, lease.st_mode & 0o777 == 0o600
    else { fail("UPDATE_GUARD_INVALID_LEASE") }
    var original = stat()
    guard lstat(arguments[3], &original) == 0,
      original.st_mode & S_IFMT == S_IFDIR,
      matches(original, device: arguments[4], inode: arguments[5])
    else { fail("UPDATE_GUARD_BUNDLE_CHANGED") }

    writeReady()
    var quietSince: TimeInterval?
    while true {
      let alive = getppid() == parent && parentAlive(parent)
      var current = stat()
      let replaced =
        lstat(arguments[3], &current) == 0
        && current.st_mode & S_IFMT == S_IFDIR
        && !matches(current, device: arguments[4], inode: arguments[5])
      if !alive && replaced { return }
      if alive {
        quietSince = nil
      } else if let active = sparkleInstallerActive() {
        if active {
          quietSince = nil
        } else if let quietSince {
          if ProcessInfo.processInfo.systemUptime - quietSince >= 2 { return }
        } else {
          quietSince = ProcessInfo.processInfo.systemUptime
        }
      } else {
        quietSince = nil
      }
      usleep(100_000)
    }
  }

  private static func runExclusiveRename(_ arguments: [String]) {
    guard arguments.count == 12, arguments[1] == "exclusive-rename",
      safeParentPath(arguments[2]), safeLeaf(arguments[3]), safeParentPath(arguments[4]),
      safeLeaf(arguments[5]), arguments[6...11].allSatisfy({ UInt64($0) != nil })
    else { fail("INSTALL_HELPER_INVALID_ARGUMENTS") }

    let sourceParent = openParent(arguments[2], device: arguments[8], inode: arguments[9])
    defer { close(sourceParent) }
    let destinationParent = openParent(
      arguments[4], device: arguments[10], inode: arguments[11])
    defer { close(destinationParent) }

    var source = stat()
    guard
      fstatat(sourceParent, arguments[3], &source, AT_SYMLINK_NOFOLLOW) == 0,
      source.st_mode & S_IFMT == S_IFDIR, source.st_uid == getuid(),
      matches(source, device: arguments[6], inode: arguments[7])
    else { fail("INSTALL_PATH_CHANGED") }

    var destination = stat()
    guard
      fstatat(destinationParent, arguments[5], &destination, AT_SYMLINK_NOFOLLOW) != 0,
      errno == ENOENT
    else { fail("INSTALL_EXCLUSIVE_RENAME_FAILED") }

    guard
      renameatx_np(
        sourceParent, arguments[3], destinationParent, arguments[5], UInt32(RENAME_EXCL)) == 0
    else { fail("INSTALL_EXCLUSIVE_RENAME_FAILED") }
  }

  static func main() {
    let arguments = CommandLine.arguments
    if arguments.count > 1, arguments[1] == "update-guard" {
      runUpdateGuard(arguments)
    } else {
      runExclusiveRename(arguments)
    }
  }
}
