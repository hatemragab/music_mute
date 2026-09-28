import SwiftUI
import UniformTypeIdentifiers

struct HomeView: View {
  var urlImports: URLImportsModel?
  var openImportedJob: (String) -> Void = { _ in }
  var beginImport: () -> Void = {}
  var importAudio: (URL) -> Void = { _ in }
  var photoSourceLimit = ProcessingMediaPolicy.standard.maxSourceBytes!
  var importPhoto: (URL) -> Void = { _ in }
  var reportImportFailure: (Error) -> Void = { _ in }
  var showProcessing: () -> Void = {}
  var tasks: [AudioTaskPresentation] = []
  var jobs: [Job] = []
  var connection: RealtimeState = .paused
  var onSelectTask: (AudioTaskPresentation) -> Void = { _ in }
  var onCancelTask: (AudioTaskPresentation) -> Void = { _ in }
  var onRetryTask: (AudioTaskPresentation) -> Void = { _ in }
  var showHistory: () -> Void
  @State private var importing = false
  @State private var importingPhoto = false
  var body: some View {
    let visibleTasks = tasks.filter(\.visibleOnHome)
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        HStack(spacing: 12) {
          Waveform().frame(width: 36, height: 34)
          VStack(alignment: .leading, spacing: 2) {
            Text("app_name").font(.title2.bold())
            Text("tagline").font(.caption).foregroundStyle(.secondary)
          }
          Spacer()
          Text("on_device").font(.caption.weight(.semibold)).padding(.horizontal, 12).padding(
            .vertical, 8
          )
          .background(VocalStyle.teal.opacity(0.10), in: Capsule())
        }
        Text("home_start").font(.title2.bold())
        if let urlImports { URLImportCard(model: urlImports, openJob: openImportedJob) }
        VocalCard {
          Button {
            beginImport()
            importing = true
          } label: {
            Label("processing_import", systemImage: "doc.badge.plus")
          }
          .buttonStyle(PrimaryButtonStyle())
          .accessibilityIdentifier("homeImportAudio")
          Button {
            beginImport()
            importingPhoto = true
          } label: {
            Label("media_import_photos", systemImage: "photo.on.rectangle")
          }
          .accessibilityIdentifier("homeImportVideo")
          Text("owned_audio_guidance").foregroundStyle(.secondary)
          Text("quality_notice").font(.caption).foregroundStyle(.secondary)
        }
        HStack {
          Text("home_recent").font(.title2.bold())
          Spacer()
          Button("home_see_all", action: showProcessing).frame(minHeight: 44)
            .accessibilityIdentifier("openProcessing")
        }
        ProcessingConnectionStatus(connection: connection)
        if visibleTasks.isEmpty {
          VocalCard { Text("processing_empty").foregroundStyle(.secondary) }
        } else {
          ForEach(visibleTasks.prefix(4)) { task in
            AudioTaskCard(
              task: task, onOpen: { onSelectTask(task) },
              onCancel: { onCancelTask(task) }, onRetry: { onRetryTask(task) })
            ProcessingQueueStatus(
              job: jobs.first { $0.id == task.jobID }, connection: connection)
          }
        }
      }.padding(20).frame(maxWidth: 680).frame(maxWidth: .infinity)
    }.scrollDismissesKeyboard(.interactively)
      .navigationBarHidden(true)

      .fileImporter(
        isPresented: $importing,
        allowedContentTypes: [.audio, .movie, .mpeg4Movie, .quickTimeMovie],
        allowsMultipleSelection: false
      ) { result in
        switch result {
        case .success(let urls):
          if let url = urls.first {
            importAudio(url)
            showProcessing()
          }
        case .failure(let error): reportImportFailure(error)
        }
      }
      .sheet(isPresented: $importingPhoto) {
        MediaPhotoPicker(maxSourceBytes: photoSourceLimit) { result in
          importingPhoto = false
          switch result {
          case .success(let url):
            if let url {
              importPhoto(url)
              showProcessing()
            }
          case .failure(let error): reportImportFailure(error)
          }
        }
      }
  }

}
