import Foundation

struct PreparedInput: Codable, Equatable, Sendable {
  let operationId: UUID
  let ownerUid: String
  let fileURL: URL
  let declaration: InputDeclaration
  let sourceTitle: String?
  let sourceKind: JobSourceKind?
  let sourceURL: String?
  let clientStartedAt: Date?
  let displayName: String?

  init(
    operationId: UUID, ownerUid: String, fileURL: URL, declaration: InputDeclaration,
    sourceTitle: String? = nil, sourceKind: JobSourceKind? = nil, clientStartedAt: Date? = nil,
    displayName: String? = nil, sourceURL: String? = nil
  ) {
    self.operationId = operationId
    self.ownerUid = ownerUid
    self.fileURL = fileURL
    self.declaration = declaration
    self.sourceTitle = sourceTitle
    self.sourceKind = sourceKind
    self.sourceURL = sourceURL
    self.clientStartedAt = clientStartedAt
    self.displayName = displayName
  }
}

enum AudioInputPreparationError: Error, Equatable {
  case cancelled, accessDenied, unreadable, storage, invalidSize, invalidAudio, unsupportedFormat
}

func validProcessingInput(bytes: Int64, duration: Double) -> Bool {
  (1...29_999_999).contains(bytes) && duration.isFinite && duration > 0 && duration < 600
}
