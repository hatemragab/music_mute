import SwiftUI
import UniformTypeIdentifiers

struct HomeView: View {
  var beginImport: () -> Void = {}
  var importAudio: (URL) -> Void = { _ in }
  var photoSourceLimit = ProcessingMediaPolicy.standard.maxSourceBytes!
  var importPhoto: (URL) -> Void = { _ in }
  var reportImportFailure: (Error) -> Void = { _ in }
  var showProcessing: () -> Void = {}
  var showHistory: () -> Void
  @State private var importing = false
  @State private var importingPhoto = false
  var body: some View {
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
        VStack(alignment: .leading, spacing: 16) {
          Text("hero_eyebrow").font(.caption.bold()).foregroundStyle(VocalStyle.teal)
          Text("hero_title").font(.system(.largeTitle, design: .rounded, weight: .bold)).fixedSize(
            horizontal: false, vertical: true)
          Text("hero_body").foregroundStyle(.secondary)
          Waveform(color: VocalStyle.teal.opacity(0.65)).frame(height: 58).padding(.top, 8)
        }.padding(.vertical, 8)
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
        VocalCard {
          Label("processing_title", systemImage: "waveform.badge.mic").font(.headline)
          Text("processing_description").foregroundStyle(.secondary)
          Button("processing_import", action: showProcessing).frame(minHeight: 48)
            .accessibilityIdentifier("openProcessing")
          Text("processing_limits").font(.caption).foregroundStyle(.secondary)
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
