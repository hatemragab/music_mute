import SwiftUI
import UniformTypeIdentifiers

struct HomeView: View {
  @ObservedObject var model: DownloadModel
  var acceptURL: (String) async -> Bool = { _ in false }
  var beginImport: () -> Void = {}
  var importAudio: (URL) -> Void = { _ in }
  var photoSourceLimit: Int64 = 29_999_999
  var importPhoto: (URL) -> Void = { _ in }
  var reportImportFailure: (Error) -> Void = { _ in }
  var showProcessing: () -> Void = {}
  var showHistory: () -> Void
  @State private var emptyClipboard = false
  @State private var importing = false
  @State private var importingPhoto = false
  @State private var youtubeExpanded = false
  @FocusState private var editing: Bool
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
          DisclosureGroup("youtube_secondary", isExpanded: $youtubeExpanded) {
            Text("source_title").font(.title3.bold())
            Text("source_body").font(.subheadline).foregroundStyle(.secondary)
            TextField("video_link", text: $model.urlText, axis: .vertical)
              .textInputAutocapitalization(.never).autocorrectionDisabled()
              .keyboardType(.URL).focused($editing).lineLimit(1...3)
              .environment(\.layoutDirection, .leftToRight)
              .padding(14).background(
                .quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 12)
              )
              .accessibilityIdentifier("youtubeURL")
            HStack {
              Text("supported_links").font(.caption).foregroundStyle(.secondary)
              Spacer()
              Button {
                if let value = UIPasteboard.general.string, !value.isEmpty {
                  model.urlText = value
                } else {
                  emptyClipboard = true
                }
              } label: {
                Label("paste", systemImage: "document.on.clipboard")
              }
              .frame(minHeight: 48).accessibilityIdentifier("pasteURL")
            }
            if model.invalidURL {
              Text("invalid_url").font(.footnote).foregroundStyle(.red).accessibilityIdentifier(
                "invalidURL")
            }
            if model.storageError { Text("history_error").foregroundStyle(.red).font(.footnote) }
            Text("youtube_permission_guidance").font(.caption)
            Button("download_audio") { commit(model.urlText) }
              .accessibilityIdentifier("downloadAudio")
          }
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
      .alert("clipboard_empty", isPresented: $emptyClipboard) { Button("ok", role: .cancel) {} }
  }

  private func commit(_ value: String) {
    editing = false
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    guard YouTubeURL.videoID(from: trimmed) != nil else {
      model.invalidURL = true
      return
    }
    model.urlText = ""
    editing = false
    Task {
      if await acceptURL(trimmed) { showProcessing() } else { model.invalidURL = true }
    }
  }
}
