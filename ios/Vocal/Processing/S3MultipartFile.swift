import CryptoKit
import Foundation

enum ProcessingTransferFailure: Error, Equatable {
  case invalidGrant, expiredGrant, invalidInput, storage, corruptMultipart, retryLimit
}

struct S3MultipartFile: Sendable {
  let fileURL: URL
  let contentType: String
  let bytes: Int64

  func validate() throws {
    // URL resource values can cache the pre-truncation size. Read current filesystem attributes.
    let values = try FileManager.default.attributesOfItem(atPath: fileURL.path)
    guard values[.type] as? FileAttributeType == .typeRegular,
      (values[.size] as? NSNumber)?.int64Value == bytes, bytes > 0
    else { throw ProcessingTransferFailure.corruptMultipart }
  }

  static func build(
    inputURL: URL, declaration: InputDeclaration, grant: UploadGrant,
    destination: URL,
    availableCapacity: (URL) throws -> Int64? = {
      try $0.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        .volumeAvailableCapacityForImportantUsage
    }
  ) throws -> S3MultipartFile {
    let boundary = "Vocal-" + UUID().uuidString.lowercased()
    guard ["m4a", "mp4", "mp3", "aac", "ogg", "opus", "webm"].contains(declaration.extension),
      ["audio/mp4", "audio/mpeg", "audio/aac", "audio/ogg", "audio/webm"].contains(
        declaration.contentType),
      validProcessingInput(bytes: declaration.bytes, duration: declaration.durationSeconds)
    else { throw ProcessingTransferFailure.invalidInput }
    var prefix = Data()
    for (name, value) in grant.fields.sorted(by: { $0.key < $1.key }) {
      guard !name.contains("\r"), !name.contains("\n"), name.lowercased() != "file" else {
        throw ProcessingTransferFailure.invalidGrant
      }
      let quoted = name.replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
      prefix.append(
        Data(
          "--\(boundary)\r\nContent-Disposition: form-data; name=\"\(quoted)\"\r\n\r\n\(value)\r\n"
            .utf8))
    }
    prefix.append(
      Data(
        "--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"input.\(declaration.extension)\"\r\nContent-Type: \(declaration.contentType)\r\n\r\n"
          .utf8))
    let suffix = Data("\r\n--\(boundary)--\r\n".utf8)
    let expectedBytes = Int64(prefix.count) + declaration.bytes + Int64(suffix.count)
    let directory = destination.deletingLastPathComponent()
    if let capacity = try availableCapacity(directory), capacity < expectedBytes {
      throw ProcessingTransferFailure.storage
    }
    let sourceValues = try FileManager.default.attributesOfItem(atPath: inputURL.path)
    guard sourceValues[.type] as? FileAttributeType == .typeRegular,
      (sourceValues[.size] as? NSNumber)?.int64Value == declaration.bytes
    else { throw ProcessingTransferFailure.invalidInput }
    let temporary = directory.appendingPathComponent(UUID().uuidString + ".partial")
    guard
      FileManager.default.createFile(
        atPath: temporary.path, contents: nil, attributes: [.posixPermissions: 0o600])
    else {
      throw ProcessingTransferFailure.storage
    }
    defer { try? FileManager.default.removeItem(at: temporary) }
    let output = try FileHandle(forWritingTo: temporary)
    let input = try FileHandle(forReadingFrom: inputURL)
    defer {
      try? output.close()
      try? input.close()
    }
    try output.write(contentsOf: prefix)
    var copied: Int64 = 0
    var digest = SHA256()
    while true {
      try Task.checkCancellation()
      let data = try input.read(upToCount: 65_536) ?? Data()
      if data.isEmpty { break }
      copied += Int64(data.count)
      guard copied <= declaration.bytes else { throw ProcessingTransferFailure.invalidInput }
      digest.update(data: data)
      try output.write(contentsOf: data)
    }
    guard copied == declaration.bytes,
      Data(digest.finalize()).base64EncodedString() == declaration.sha256
    else {
      throw ProcessingTransferFailure.invalidInput
    }
    try output.write(contentsOf: suffix)
    try output.synchronize()
    try output.close()
    try FileManager.default.moveItem(at: temporary, to: destination)
    var url = destination
    var excluded = URLResourceValues()
    excluded.isExcludedFromBackup = true
    try url.setResourceValues(excluded)
    let result = S3MultipartFile(
      fileURL: destination, contentType: "multipart/form-data; boundary=\(boundary)",
      bytes: expectedBytes)
    try result.validate()
    return result
  }
}
