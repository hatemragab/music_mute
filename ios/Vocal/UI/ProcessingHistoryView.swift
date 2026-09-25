import SwiftUI

struct ProcessingHistoryView: View {
  @ObservedObject var history: ProcessingHistoryModel
  @ObservedObject var repository: ProcessingRepository
  @ObservedObject var pipeline: AudioPipelineCoordinator
  var preparing: Bool
  var pendingInputName: String?
  var messageKey: String?
  var onImport: () -> Void
  var onSubmit: () -> Void
  var onSelect: (AudioTaskPresentation) -> Void
  var onResume: (AudioTaskPresentation) -> Void
  var onCancel: (AudioTaskPresentation) -> Void
  var onNotifications: () -> Void

  var body: some View {
    let tasks = AudioTaskPresentation.merge(
      pipelines: pipeline.pipelines, uploads: repository.operations, jobs: history.jobs)
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 20) {
        Text("processing_title").font(.largeTitle.bold())
        Text("processing_description").foregroundStyle(.secondary)
        Text("processing_limits").font(.caption)
        Button(action: onImport) { Label("processing_import", systemImage: "doc.badge.plus") }
          .buttonStyle(PrimaryButtonStyle()).disabled(preparing)
          .accessibilityIdentifier("processingImport")
        Button("processing_notifications", action: onNotifications)
        Text("processing_notifications_optional").font(.caption).foregroundStyle(.secondary)
        if preparing { ProgressView("processing_preparing") }
        if let messageKey { Text(LocalizedStringKey(messageKey)).foregroundStyle(.red) }
        if let key = history.messageKey { Text(LocalizedStringKey(key)).foregroundStyle(.red) }
        if history.loading { ProgressView() }
        if !history.loading && tasks.isEmpty {
          Text("processing_empty").foregroundStyle(.secondary)
        }
        ForEach(tasks) { task in
          AudioTaskCard(
            task: task,
            progress: transferProgress(for: task),
            onOpen: { onSelect(task) },
            onCancel: { onCancel(task) },
            onRetry: { onResume(task) })
        }
        if history.nextCursor != nil {
          Button("processing_more") { Task { await history.loadMore() } }.disabled(
            history.loadingMore)
        }
        Button("processing_refresh") { Task { await history.refresh() } }.disabled(history.loading)
      }.padding(20).frame(maxWidth: 680).frame(maxWidth: .infinity)
    }.refreshable { await history.refresh() }
      .accessibilityIdentifier("processingHistory")
  }

  private func transferProgress(for task: AudioTaskPresentation) -> Double? {
    guard let operationID = task.operationID else { return nil }
    switch task.statusKey {
    case "processing_finding_downloading":
      return nil
    case "processing_uploading_audio":
      return repository.transferProgress[operationID]?.fraction
    default:
      return nil
    }
  }
}
