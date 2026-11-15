import SwiftUI
import UniformTypeIdentifiers

private struct ProcessingExport: Identifiable {
  let id = UUID()
  let url: URL
}

struct ProcessingRootView: View {
  @ObservedObject var model: ProcessingModel
  @ObservedObject var repository: ProcessingRepository
  @ObservedObject var player: AudioPlayer
  var outputProgress: [String: Double?]
  var requestNotifications: () -> Void
  @State private var importing = false
  @State private var showingDetail = false
  @State private var export: ProcessingExport?
  @State private var share: ProcessingExport?

  var body: some View {
    ProcessingHistoryView(
      history: model.history, repository: repository, pipeline: model.pipeline,
      preparing: model.preparing, pendingInputName: model.pendingInputName,
      messageKey: model.messageKey,
      onImport: {
        model.beginSourceImport()
        importing = true
      }, onSubmit: model.submitImported,
      onSelect: { task in
        model.select(task)
        showingDetail = true
      },
      onResume: model.retry, onCancel: model.cancel, onNotifications: requestNotifications
    )
    .safeAreaInset(edge: .top) { ProcessingUsageView(repository: model.usageRepository) }
    .modifier(PendingAudioReviews(pipeline: model.pipeline))
    .fileImporter(
      isPresented: $importing, allowedContentTypes: [.audio, .movie, .mpeg4Movie, .quickTimeMovie],
      allowsMultipleSelection: false
    ) { result in
      switch result {
      case .success(let urls): if let url = urls.first { model.importAudio(url) }
      case .failure(let error): model.reportImportFailure(error)
      }
    }
    .navigationDestination(isPresented: $showingDetail) {
      ProcessingDetailView(
        history: model.history, task: model.selectedTask, busy: model.busy,
        progress: model.selectedJobID.flatMap { outputProgress[$0] } ?? nil,
        messageKey: model.messageKey,
        playing: model.selectedIsPlaying,
        position: model.selectedHasPlayback ? player.position : 0,
        duration: model.selectedHasPlayback ? player.duration : 0,
        onPlay: model.playSelected, onSeek: player.seek,
        onDownload: { model.downloadSelected() },
        onSave: {
          model.downloadSelected(stage: .exporting) { export = ProcessingExport(url: $0) }
        },
        onShare: {
          model.downloadSelected(stage: .exporting) { share = ProcessingExport(url: $0) }
        },
        onRename: model.renameSelected,
        onDelete: model.deleteSelected,
        onCancel: model.cancelSelected, onRetry: model.retrySelected
      )
    }
    .sheet(item: $export) { item in
      AudioExportPicker(file: item.url) { _ in export = nil }
    }
    .sheet(item: $share) { item in
      ProcessedAudioShareSheet(file: item.url) { share = nil }
    }
    .onChange(of: model.selectedJobID, initial: true) { _, id in
      showingDetail = id != nil
      if id == nil {
        export = nil
        share = nil
      }
    }
    .onChange(of: showingDetail) { _, shown in
      if !shown {
        model.select(nil)
      }
    }
  }
}
