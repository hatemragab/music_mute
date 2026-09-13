import UIKit

/// iOS grants finite execution time. Expiration cancels the exporter and relaunch
/// asks for source reselection unless a complete prepared input was persisted.
@MainActor enum MediaPreparationCoordinator {
  static func run(_ operation: @escaping @Sendable () async throws -> PreparedInput) async throws
    -> PreparedInput
  {
    let task = Task { try await operation() }
    let identifier = UIApplication.shared.beginBackgroundTask(withName: "Prepare audio") {
      task.cancel()
    }
    defer {
      if identifier != .invalid { UIApplication.shared.endBackgroundTask(identifier) }
    }
    return try await withTaskCancellationHandler {
      do { return try await task.value } catch AudioInputPreparationError.cancelled {
        if Task.isCancelled { throw CancellationError() }
        throw AudioInputPreparationError.interrupted
      }
    } onCancel: {
      task.cancel()
    }
  }
}
