import SwiftUI

struct SettingsView: View {
  @ObservedObject var preferences: AppPreferences
  @ObservedObject var auth: AuthSessionModel
  var body: some View {
    Form {
      Section("auth_account") {
        NavigationLink {
          AccountView(model: auth)
        } label: {
          VStack(alignment: .leading, spacing: 4) {
            Text(auth.profile?.displayName ?? String(localized: "auth_account"))
            Text(auth.profile?.email ?? auth.identity?.email ?? "")
              .font(.caption).foregroundStyle(.secondary)
          }
        }
      }
      Section("appearance") {
        Picker("appearance", selection: $preferences.appearance) {
          Text("follow_system").tag(Appearance.system)
          Text("light").tag(Appearance.light)
          Text("dark").tag(Appearance.dark)
        }.pickerStyle(.inline).labelsHidden().accessibilityIdentifier("appearancePicker")
      }
      Section("language") {
        Picker("language", selection: $preferences.language) {
          Text("follow_system").tag(AppLanguage.system)
          Text("english").tag(AppLanguage.en)
          Text("arabic").tag(AppLanguage.ar)
        }.pickerStyle(.inline).labelsHidden().accessibilityIdentifier("languagePicker")
      }
      Section("about") {
        LabeledContent(
          "app_name",
          value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
            ?? "0.1.0")
        Text("about_body").font(.subheadline).foregroundStyle(.secondary)
        Label("private_download", systemImage: "iphone.and.arrow.forward").font(.subheadline)
      }
      Section("future_flow") {
        Text("future_flow_body").font(.subheadline).foregroundStyle(.secondary)
      }
    }.navigationTitle("settings_title").scrollContentBackground(.hidden)
  }
}

struct DemoView: View {
  @Environment(\.dismiss) private var dismiss
  @State private var progress = 0.0
  @State private var complete = false
  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 24) {
        Label("demo_badge", systemImage: "sparkles").font(.caption.bold()).foregroundStyle(
          VocalStyle.teal)
        Text(complete ? "demo_result_title" : "demo_title").font(.largeTitle.bold())
        Text(complete ? "demo_result_body" : "demo_body").foregroundStyle(.secondary)
        Waveform().frame(height: 100)
        if !complete {
          ProgressView(value: progress)
          Text(progress < 0.5 ? "demo_preparing" : "demo_separating").font(.headline)
        } else {
          Label("demo_original", systemImage: "waveform").font(.headline)
          Label("demo_voice", systemImage: "mic").font(.headline)
        }
        Button(complete ? "done" : "cancel_demo") { dismiss() }.buttonStyle(PrimaryButtonStyle())
        Spacer()
      }.padding(24)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("close") { dismiss() } } }
        .task {
          do {
            for step in 1...30 {
              try await Task.sleep(for: .milliseconds(100))
              progress = Double(step) / 30
            }
            complete = true
          } catch {
            // Closing the sheet cancels the demo.
          }
        }
    }.presentationDragIndicator(.visible)
  }
}
