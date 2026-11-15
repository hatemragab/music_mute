import SwiftUI
import UIKit

private struct ExportItem: Identifiable {
  let id = UUID()
  let url: URL
}

struct HistoryView: View {
  @ObservedObject var model: DownloadModel
  @ObservedObject var player: AudioPlayer
  let files: AudioFiles
  var removeMusic: ((AudioRecord) -> Void)? = nil
  var showHome: () -> Void
  @State private var export: ExportItem?
  @State private var exportTemporary: URL?
  @State private var saving: UUID?
  @State private var saveSuccess = false
  @State private var saveError = false
  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 20) {
        VStack(alignment: .leading, spacing: 10) {
          Text("history_title").font(.largeTitle.bold())
          Text("history_body").foregroundStyle(.secondary)
          Text("keep_open").font(.caption).foregroundStyle(.secondary)
        }
        if model.loading {
          ProgressView().frame(maxWidth: .infinity).accessibilityLabel(Text("loading"))
        }
        if model.storageError {
          VocalCard {
            Text("history_error").foregroundStyle(.red)
            Button("retry") { Task { await model.load() } }.frame(minHeight: 48)
          }
        }
        if player.failed { Text("playback_error").foregroundStyle(.red).font(.footnote) }
        if model.records.isEmpty && !model.loading && !model.storageError {
          VocalCard {
            Image(systemName: "headphones").font(.system(size: 42)).foregroundStyle(VocalStyle.teal)
              .accessibilityHidden(true)
            Text("empty_title").font(.title2.bold())
            Text("empty_body").foregroundStyle(.secondary)
            Button("download_audio", action: showHome).buttonStyle(PrimaryButtonStyle())
          }
        }
        ForEach(model.records) { record in
          AudioRow(
            record: record, player: player, saving: saving == record.id, saveEnabled: saving == nil,
            play: { player.toggle(record, file: files.url(for: record.relativePath)) },
            save: { prepareExport(record) }, cancel: { model.cancel(record.id) },
            retry: { Task { await model.retry(record) } },
            removeMusic: removeMusic.map { action in { action(record) } })
        }
      }.padding(20).frame(maxWidth: 680).frame(maxWidth: .infinity)
    }.navigationBarHidden(true)
      .sheet(item: $export, onDismiss: clearExport) { item in
        AudioExportPicker(file: item.url) { saved in
          export = nil
          if saved { saveSuccess = true }
        }
      }
      .alert("save_success", isPresented: $saveSuccess) { Button("ok", role: .cancel) {} }
      .alert("save_error", isPresented: $saveError) { Button("ok", role: .cancel) {} }
  }
  private func prepareExport(_ record: AudioRecord) {
    guard saving == nil else { return }
    saving = record.id
    Task {
      do {
        let file = try await files.exportCopy(of: record)
        exportTemporary = file
        export = ExportItem(url: file)
      } catch {
        saving = nil
        saveError = true
      }
    }
  }
  private func clearExport() {
    if let url = exportTemporary { Task { await files.removeExport(url) } }
    exportTemporary = nil
    saving = nil
  }
}

struct AudioRow: View {
  let record: AudioRecord
  @ObservedObject var player: AudioPlayer
  var saving = false
  var saveEnabled = true
  var play: () -> Void = {}
  var save: () -> Void = {}
  var cancel: () -> Void = {}
  var retry: () -> Void = {}
  var removeMusic: (() -> Void)? = nil
  @State private var seekPosition: Double?
  private var active: Bool { player.currentID == record.id }
  var body: some View {
    VocalCard {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: record.status == .complete ? "music.note" : "arrow.down.circle")
          .font(.title2).foregroundStyle(VocalStyle.teal).frame(width: 32).accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 6) {
          if record.title.isEmpty {
            Text("youtube_audio").font(.headline)
          } else {
            Text(record.title).font(.headline).textSelection(.enabled)
          }
          Text(record.createdAt, format: .dateTime.month(.abbreviated).day().hour().minute())
            .font(.caption).foregroundStyle(.secondary)
        }
        Spacer(minLength: 0)
      }
      if record.status == .complete {
        Text(
          "\(record.fileExtension.uppercased()) · \(record.codec) · \(ByteCountFormatter.string(fromByteCount: record.byteCount, countStyle: .file))"
        )
        .font(.caption.weight(.medium)).foregroundStyle(.secondary)
        if record.bitrate > 0 {
          Text("bitrate \(record.bitrate / 1000)").font(.caption).foregroundStyle(.secondary)
        }
        Label("saved_original", systemImage: "checkmark.circle.fill").font(.caption)
          .foregroundStyle(VocalStyle.teal)
          .accessibilityIdentifier("downloadComplete")
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 12) { actions }
          VStack(alignment: .leading, spacing: 8) { actions }
        }
        if let removeMusic {
          Button("processing_remove", action: removeMusic).frame(minHeight: 48)
            .accessibilityIdentifier("removeMusic-\(record.id)")
        }
        if active {
          if player.loading { ProgressView().accessibilityLabel(Text("loading")) }
          Slider(
            value: Binding(get: { seekPosition ?? player.position }, set: { seekPosition = $0 }),
            in: 0...max(1, player.duration),
            onEditingChanged: { editing in
              if !editing, let position = seekPosition {
                player.seek(to: position)
                seekPosition = nil
              }
            }
          ).accessibilityLabel(Text("playback_position")).accessibilityIdentifier("audioSeek")
          Text("\(audioTime(seekPosition ?? player.position)) / \(audioTime(player.duration))")
            .font(.caption.monospacedDigit()).accessibilityIdentifier("playbackTime")
        } else {
          Text(audioTime(record.duration)).font(.caption.monospacedDigit())
        }
      } else if record.status.isActive {
        Text(LocalizedStringKey(record.status.label)).font(.subheadline).accessibilityIdentifier(
          "downloadStatus")
        if record.totalBytes != nil || record.progress > 0 {
          ProgressView(value: record.progress)
            .accessibilityIdentifier("downloadProgress")
          Text(record.progress, format: .percent.precision(.fractionLength(0))).font(
            .caption.monospacedDigit()
          )
          .accessibilityIdentifier("downloadPercent")
        } else {
          ProgressView().frame(maxWidth: .infinity, alignment: .leading)
        }
        if record.status == .downloading {
          let received = ByteCountFormatter.string(
            fromByteCount: record.downloadedBytes ?? 0, countStyle: .file)
          if let total = record.totalBytes {
            Text(
              "download_bytes \(received) \(ByteCountFormatter.string(fromByteCount: total, countStyle: .file))"
            )
            .font(.caption.monospacedDigit()).accessibilityIdentifier("downloadBytes")
          } else {
            Text("download_received \(received)").font(.caption.monospacedDigit())
              .accessibilityIdentifier("downloadBytes")
          }
        }
        Button("cancel_download", role: .cancel, action: cancel).frame(minHeight: 48)
          .accessibilityIdentifier("cancelDownload")
      } else {
        Text(
          LocalizedStringKey(
            record.status == .cancelled
              ? "status_cancelled" : (record.failure ?? .unavailable).label)
        )
        .font(.subheadline).foregroundStyle(.secondary).accessibilityIdentifier("downloadFailure")
        Button("retry", action: retry).buttonStyle(.bordered).controlSize(.large)
          .accessibilityIdentifier("retryDownload")
      }
    }.accessibilityElement(children: .contain)
      .accessibilityIdentifier("audioRow-\(record.id.uuidString)")
  }
  @ViewBuilder private var actions: some View {
    Button(action: play) {
      Label(
        active && (player.playing || player.loading) ? "pause" : "play",
        systemImage: active && (player.playing || player.loading) ? "pause.fill" : "play.fill"
      ).frame(minHeight: 30)
    }
    .buttonStyle(.borderedProminent).controlSize(.large).accessibilityIdentifier("playAudio")
    Button(action: save) {
      Label(saving ? "saving" : "save_to_files", systemImage: "square.and.arrow.down").frame(
        minHeight: 30)
    }
    .buttonStyle(.bordered).controlSize(.large).disabled(!saveEnabled).accessibilityIdentifier(
      "saveAudio")
  }
}

struct AudioExportPicker: UIViewControllerRepresentable {
  let file: URL
  let completed: (Bool) -> Void
  func makeCoordinator() -> Coordinator { Coordinator(completed: completed) }
  func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
    let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
    picker.directoryURL =
      FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
    picker.delegate = context.coordinator
    return picker
  }
  func updateUIViewController(_ uiViewController: UIDocumentPickerViewController, context: Context)
  {}
  final class Coordinator: NSObject, UIDocumentPickerDelegate {
    let completed: (Bool) -> Void
    init(completed: @escaping (Bool) -> Void) { self.completed = completed }
    func documentPicker(
      _ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]
    ) { completed(!urls.isEmpty) }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
      completed(false)
    }
  }
}
