import Foundation

/// Keeps a missing API configuration an explicit error at every processing boundary.
@MainActor struct UnavailableJobsAPI: JobsAPI {
  func create(requestId: UUID, input: InputDeclaration) async throws -> CreateReservation {
    throw AuthFailure.configuration
  }
  func renewUpload(id: String) async throws -> UploadGrant { throw AuthFailure.configuration }
  func confirmUpload(id: String) async throws -> JobMutation { throw AuthFailure.configuration }
  func list(cursor: String?, status: String?) async throws -> JobPage {
    throw AuthFailure.configuration
  }
  func detail(id: String) async throws -> Job { throw AuthFailure.configuration }
  func cancel(id: String) async throws -> JobMutation { throw AuthFailure.configuration }
  func retry(id: String, requestId: UUID) async throws -> JobMutation {
    throw AuthFailure.configuration
  }
  func download(id: String, artifact: String) async throws -> DownloadGrant {
    throw AuthFailure.configuration
  }
  func rename(id: String, displayName: String) async throws -> Job {
    throw AuthFailure.configuration
  }
  func delete(id: String) async throws { throw AuthFailure.configuration }
  func report(_ event: ClientErrorEvent) async throws -> ClientErrorReceipt {
    throw AuthFailure.configuration
  }
}

@MainActor struct UnavailablePushRegistrationAPI: PushRegistrationAPI {
  func register(installationID: String, token: String) async throws -> PushBinding {
    throw AuthFailure.configuration
  }
  func deactivate(installationID: String, expectedBindingRevision: Int64) async throws {
    throw AuthFailure.configuration
  }
}
