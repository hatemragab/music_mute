import SwiftUI

struct ProcessingDetailView: View {
  @ObservedObject var history: ProcessingHistoryModel
  var task: AudioTaskPresentation?
  var busy: Bool
  var progress: Double?
  var messageKey: String?
  var playing: Bool
  var position: Double
  var duration: Double
  var onPlay: () -> Void
  var onSeek: (Double) -> Void
  var onDownload: () -> Void
  var onSave: () -> Void
  var onShare: () -> Void
  var onRename: (String) -> Void
  var onDelete: () -> Void
  var onCancel: () -> Void
  var onRetry: () -> Void
  @State private var renaming = false
  @State private var deleting = false
  @State private var proposedName = ""
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        Text(task?.title ?? String(localized: "processing_details"))
          .font(.system(.largeTitle, design: .rounded, weight: .bold))
        if let key = messageKey { Text(LocalizedStringKey(key)).foregroundStyle(.red) }
        if let key = history.messageKey { Text(LocalizedStringKey(key)).foregroundStyle(.red) }
        if let task {
          HStack {
            Waveform(color: VocalStyle.teal.opacity(0.8)).frame(width: 50, height: 30)
            Text(LocalizedStringKey(task.statusKey)).font(.title3.weight(.semibold))
              .contentTransition(.opacity)
              .animation(.easeInOut(duration: reduceMotion ? 0 : 0.2), value: task.statusKey)
          }
          AudioStepTimeline(steps: task.timeline)
          identifierRow(
            title: task.jobID == nil ? "processing_reference" : "processing_job_id",
            value: task.jobID ?? task.reference)
          if task.jobID != nil, let reference = task.reference {
            identifierRow(title: "processing_reference", value: reference)
          }
          timing(task)
          if let job = history.detail {
            if job.workerAvailable == false && shouldPollProcessingJob(job.status) {
              Text("processing_worker_offline").foregroundStyle(.secondary)
            }
            if let error = job.error {
              Text(
                LocalizedStringKey(
                  ["UPLOAD_EXPIRED", "INVALID_AUDIO", "INPUT_TOO_LONG", "INPUT_CHECKSUM_MISMATCH"]
                    .contains(
                      error.code)
                    ? "processing_error_retry_input" : "processing_error_failed")
              ).foregroundStyle(.red)
            }
          }
          if busy { ProgressView(value: progress).accessibilityIdentifier("processingBusy") }
          actionButtons(task)
        } else if history.messageKey == nil {
          ProgressView()
        }
        Button("processing_refresh") { Task { await history.refresh() } }.disabled(history.loading)
      }.padding(20).frame(maxWidth: 680).frame(maxWidth: .infinity)
    }
    .accessibilityIdentifier("processingDetail")
    .sheet(isPresented: $renaming) {
      NavigationStack {
        Form {
          TextField("processing_name", text: $proposedName).textInputAutocapitalization(.sentences)
            .accessibilityIdentifier("processingName")
        }
        .navigationTitle("processing_rename")
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("cancel") { renaming = false }
          }
          ToolbarItem(placement: .confirmationAction) {
            Button("save") {
              onRename(proposedName)
              renaming = false
            }.disabled(!validName(proposedName))
          }
        }
      }.presentationDetents([.medium])
    }
    .confirmationDialog(
      "processing_delete_confirm_title", isPresented: $deleting, titleVisibility: .visible
    ) {
      Button("processing_delete", role: .destructive, action: onDelete)
      Button("cancel", role: .cancel) {}
    } message: {
      Text("processing_delete_confirm_body")
    }
  }

  @ViewBuilder private func actionButtons(_ task: AudioTaskPresentation) -> some View {
    Button("processing_rename") {
      proposedName = task.title
      renaming = true
    }.accessibilityIdentifier("processingRename")
    if task.canCancel {
      Button("processing_cancel", role: .destructive, action: onCancel)
        .accessibilityIdentifier("processingCancel")
    }
    if task.canRetry {
      Button("retry", action: onRetry).disabled(busy).accessibilityIdentifier("processingRetry")
    }
    if task.isReady {
      Text("processing_output_notice").font(.subheadline)
      Button(action: onPlay) {
        Label(playing ? "pause" : "play", systemImage: playing ? "pause.fill" : "play.fill")
      }
      .buttonStyle(PrimaryButtonStyle()).disabled(busy).accessibilityIdentifier("processingPlay")
      if duration > 0 {
        Slider(value: Binding(get: { min(position, duration) }, set: onSeek), in: 0...duration)
          .accessibilityLabel(Text("playback_position"))
      }
      Button("processing_download", action: onDownload).disabled(busy)
        .accessibilityIdentifier("processingDownload")
      Button("processing_share", action: onShare).disabled(busy)
        .accessibilityIdentifier("processingShare")
      Button("save_to_files", action: onSave).disabled(busy)
        .accessibilityIdentifier("processingSave")
    }
    if task.canDelete {
      Button("processing_delete", role: .destructive) { deleting = true }
        .accessibilityIdentifier("processingDelete")
    }
  }

  private func identifierRow(title: LocalizedStringKey, value: String?) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title).font(.caption).foregroundStyle(.secondary)
      HStack {
        Text(value ?? "—").font(.footnote.monospaced()).textSelection(.enabled)
        Spacer()
        if let value {
          Button {
            UIPasteboard.general.string = value
          } label: {
            Image(systemName: "doc.on.doc")
          }.accessibilityLabel(Text("copy"))
        }
      }
    }
  }

  private func timing(_ task: AudioTaskPresentation) -> some View {
    HStack(spacing: 24) {
      VStack(alignment: .leading, spacing: 4) {
        Text("processing_total_time").font(.caption).foregroundStyle(.secondary)
        AudioTaskElapsedTime(task: task).font(.headline.monospacedDigit())
      }
      timingValue(
        "processing_actual_time", seconds: task.processingSeconds,
        approximate: task.processingApproximate)
    }
  }

  private func timingValue(
    _ key: LocalizedStringKey, seconds: Double?, approximate: Bool
  ) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(key).font(.caption).foregroundStyle(.secondary)
      Text(seconds.map { (approximate ? "≈ " : "") + audioTime($0) } ?? "—")
        .font(.headline.monospacedDigit())
    }
  }

  private func validName(_ value: String) -> Bool {
    let name = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return !name.isEmpty && name.unicodeScalars.count <= 200
      && name.unicodeScalars.allSatisfy { $0.properties.generalCategory != .control }
  }
}
