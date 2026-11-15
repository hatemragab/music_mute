import CryptoKit
import Foundation

enum ProcessingTransferFailure: Error, Equatable {
  case invalidGrant, expiredGrant, invalidInput, storage, corruptMultipart, retryLimit
}

struct S3MultipartFile: Sendable {
  let fileURL: URL
  let contentType: String
  let checksumSha256: String
  let bytes: Int64

  func validate() throws {
    // URL resource values can cache the pre-truncation size. Read current filesystem attributes.
    let values = try FileManager.default.attributesOfItem(atPath: fileURL.path)
    guard values[.type] as? FileAttributeType == .typeRegular,
      (values[.size] as? NSNumber)?.int64Value == bytes, bytes > 0
    else { throw ProcessingTransferFailure.corruptMultipart }
  }

  static func build(
    inputURL: URL, declaration: InputDeclaration,
    destination: URL, policyVersion: Int? = nil,
    availableCapacity: (URL) throws -> Int64? = {
      try $0.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        .volumeAvailableCapacityForImportantUsage
    }
  ) throws -> S3MultipartFile {
    guard ["m4a", "mp4", "mp3", "aac", "ogg", "opus", "webm"].contains(declaration.extension),
      ["audio/mp4", "audio/mpeg", "audio/aac", "audio/ogg", "audio/webm"].contains(
        declaration.contentType),
      policyVersion == 2,
      ProcessingMediaPolicy.standard.accepts(
        bytes: declaration.bytes, duration: declaration.durationSeconds)
    else { throw ProcessingTransferFailure.invalidInput }
    let expectedBytes = declaration.bytes
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
    try output.synchronize()
    try output.close()
    try FileManager.default.moveItem(at: temporary, to: destination)
    var url = destination
    var excluded = URLResourceValues()
    excluded.isExcludedFromBackup = true
    try url.setResourceValues(excluded)
    let result = S3MultipartFile(
      fileURL: destination, contentType: declaration.contentType,
      checksumSha256: declaration.sha256,
      bytes: expectedBytes)
    try result.validate()
    return result
  }
}
