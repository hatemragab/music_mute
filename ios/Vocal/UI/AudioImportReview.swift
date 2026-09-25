import SwiftUI

struct AudioImportReview: View {
  let intent: AudioPipelineIntent
  let confirm: () async throws -> Void
  let cancel: () async -> Void
  @State private var rightsConfirmed = false
  @State private var submitting = false
  @State private var failed = false

  var body: some View {
    Form {
      Section("import_review_title") {
        Text(intent.sourceTitle ?? intent.reviewInput?.fileURL.lastPathComponent ?? "")
        Text("processing_import")
        if let input = intent.reviewInput {
          Text(
            ByteCountFormatter.string(fromByteCount: input.declaration.bytes, countStyle: .file))
          Text(
            Duration.seconds(input.declaration.durationSeconds).formatted(
              .time(pattern: .minuteSecond)))
        }
        Text("import_cloud_disclosure")
        Toggle("import_rights_confirmation", isOn: $rightsConfirmed)
          .accessibilityIdentifier("importRightsConfirmation")
      }
      if failed { Text("processing_error_service").foregroundStyle(.red) }
      Button("processing_remove") {
        guard rightsConfirmed, !submitting else { return }
        submitting = true
        Task {
          do { try await confirm() } catch {
            failed = true
            submitting = false
          }
        }
      }
      .disabled(!rightsConfirmed || submitting)
      .accessibilityIdentifier("confirmCloudProcessing")
      Button("cancel", role: .cancel) { Task { await cancel() } }.disabled(submitting)
    }
    .navigationTitle("import_review_title")
    .navigationBarBackButtonHidden()
  }
}

struct PendingAudioReviews: ViewModifier {
  @ObservedObject var pipeline: AudioPipelineCoordinator
  func body(content: Content) -> some View {
    content.navigationDestination(
      isPresented: Binding(
        get: { pipeline.pipelines.contains { $0.phase == .awaitingConfirmation } },
        set: { _ in }
      )
    ) {
      if let intent = pipeline.pipelines.first(where: { $0.phase == .awaitingConfirmation }) {
        AudioImportReview(
          intent: intent,
          confirm: {
            try await pipeline.confirmProcessing(intent.operationId, rightsConfirmed: true)
          }, cancel: { await pipeline.cancel(intent.operationId) }
        )
        .id(intent.operationId)
      }
    }
  }
}
