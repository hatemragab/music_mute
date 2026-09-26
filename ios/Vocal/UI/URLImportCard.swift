import SwiftUI

struct URLImportCard: View {
  @ObservedObject var model: URLImportsModel
  let openJob: (String) -> Void
  @State private var source = ""
  @FocusState private var sourceFocused: Bool
  @State private var rights = false
  @State private var trimEnabled = false
  @State private var localError: String?

  var body: some View {
    VocalCard {
      Label("url_import_title", systemImage: "link").font(.headline)
      Text("url_import_supported").font(.caption).foregroundStyle(.secondary)
      Text(SupportedAudioSites.names.joined(separator: ", ")).font(.caption)
      if model.record == nil || model.record?.terminal == true {
        TextField("url_import_hint", text: $source)
          .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
          .environment(\.layoutDirection, .leftToRight)
          .accessibilityIdentifier("urlImportSource")
          .focused($sourceFocused)
          .onSubmit { sourceFocused = false }
          .onChange(of: source) { _, _ in localError = nil }
        Text("import_cloud_disclosure").font(.caption)
        Toggle("trim_silence", isOn: $trimEnabled)
        Toggle("import_rights_confirmation", isOn: $rights)
          .accessibilityIdentifier("urlImportRights")
        Button("url_import_action") {
          do {
            _ = try SupportedAudioSites.canonical(source)
            localError = nil
            Task { await model.submit(source, trimEnabled: trimEnabled) }
          } catch {
            localError = (error as? URLImportFailure)?.messageKey ?? "url_import_invalid"
          }
        }
        .buttonStyle(PrimaryButtonStyle())
        .disabled(
          !rights || model.busy || source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        )
        .accessibilityIdentifier("submitURLImport")
      }
      if let record = model.record {
        Text(LocalizedStringKey(statusKey(record.status))).font(.caption)
        if let key = record.messageKey { Text(LocalizedStringKey(key)).foregroundStyle(.red) }
        if let job = record.jobId, record.status == "submitted" {
          Button("url_import_open_job") { openJob(job) }
        } else if !model.busy && !record.terminal {
          Button("retry") { model.resume() }
        }
      }
      if model.busy { ProgressView().accessibilityLabel(Text("url_import_pending")) }
      if let key = localError ?? model.messageKey {
        Text(LocalizedStringKey(key)).foregroundStyle(.red).accessibilityIdentifier(
          "urlImportError")
      }
    }
    .onChange(of: model.owner) { _, _ in
      source = ""
      rights = false
      trimEnabled = false
      localError = nil
    }
  }

  private func statusKey(_ status: String) -> String {
    switch status {
    case "submitted": return "url_import_submitted"
    case "failed": return "url_import_failed"
    default: return "url_import_pending"
    }
  }
}
