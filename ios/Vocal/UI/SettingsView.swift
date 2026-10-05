import SwiftUI

enum MusicMutePlatformLink {
  case web
  case macOS

  fileprivate var canonicalURL: String {
    switch self {
    case .web: return "https://app.music-mute.com"
    case .macOS: return "https://music-mute.com/#downloads"
    }
  }

  fileprivate var host: String {
    switch self {
    case .web: return "app.music-mute.com"
    case .macOS: return "music-mute.com"
    }
  }

  fileprivate var fragment: String? {
    switch self {
    case .web: return nil
    case .macOS: return "downloads"
    }
  }
}

func musicMutePlatformURL(
  _ platform: MusicMutePlatformLink, candidate: String? = nil
) -> URL? {
  guard let components = URLComponents(string: candidate ?? platform.canonicalURL),
    components.scheme?.lowercased() == "https",
    components.host?.lowercased() == platform.host,
    components.user == nil, components.password == nil, components.port == nil,
    components.query == nil,
    components.percentEncodedPath.isEmpty || components.percentEncodedPath == "/",
    components.fragment == platform.fragment
  else { return nil }
  return components.url
}

struct SettingsView: View {
  @ObservedObject var preferences: AppPreferences
  @ObservedObject var auth: AuthSessionModel
  var usageRepository: ProcessingUsageRepository?
  @State private var customAccent = ""
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
      Section("settings_accent") {
        HStack(spacing: 14) {
          ForEach(["#FF814A", "#62A8FF", "#71D7B1", "#BB86FC", "#FF6B9D"], id: \.self) {
            value in
            Button {
              preferences.setAccent(value)
            } label: {
              Circle().fill(accentColor(value)).frame(width: 36, height: 36)
                .overlay {
                  if preferences.accentHex == value {
                    Image(systemName: "checkmark").font(.caption.bold()).foregroundStyle(.black)
                  }
                }
            }.buttonStyle(.plain).accessibilityLabel(Text("\(value)"))
          }
        }
        HStack {
          TextField("#FF814A", text: $customAccent)
            .textInputAutocapitalization(.characters).autocorrectionDisabled()
          Button("settings_apply") { preferences.setAccent(customAccent) }
            .disabled(AppPreferences.normalizedAccent(customAccent) == nil)
        }
      }
      Section("language") {
        Picker("language", selection: $preferences.language) {
          Text("follow_system").tag(AppLanguage.system)
          Text("english").tag(AppLanguage.en)
          Text("arabic").tag(AppLanguage.ar)
        }.pickerStyle(.inline).labelsHidden().accessibilityIdentifier("languagePicker")
      }
      Section("settings_processing") {
        if let usageRepository {
          NavigationLink("settings_usage") {
            Form {
              ProcessingUsageView(repository: usageRepository)
              Text("processing_limits").font(.caption).foregroundStyle(.secondary)
            }.navigationTitle("settings_usage")
          }
        }
      }
      Section("settings_help") {
        Link("settings_support", destination: URL(string: "mailto:support@music-mute.com")!)
        Link("privacy_policy", destination: URL(string: "https://api.music-mute.com/privacy")!)
        Link("settings_terms", destination: URL(string: "https://api.music-mute.com/terms")!)
      }
      Section("settings_other_platforms") {
        platformLink(
          .web, title: "platform_web_title", description: "platform_web_description",
          systemImage: "globe", identifier: "platformWebLink")
        platformLink(
          .macOS, title: "platform_macos_title", description: "platform_macos_description",
          systemImage: "laptopcomputer", identifier: "platformMacOSLink")
      }
      Section("about") {
        LabeledContent(
          "app_name",
          value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
            ?? "0.1.0")
        Text("about_body").font(.subheadline).foregroundStyle(.secondary)
      }
    }.navigationTitle("settings_title").scrollContentBackground(.hidden)
      .onAppear { customAccent = preferences.accentHex }
  }

  private func accentColor(_ value: String) -> Color {
    let hex = UInt64(value.dropFirst(), radix: 16) ?? 0
    return Color(
      red: Double((hex >> 16) & 0xff) / 255,
      green: Double((hex >> 8) & 0xff) / 255,
      blue: Double(hex & 0xff) / 255)
  }

  @ViewBuilder private func platformLink(
    _ platform: MusicMutePlatformLink,
    title: LocalizedStringKey,
    description: LocalizedStringKey,
    systemImage: String,
    identifier: String
  ) -> some View {
    if let destination = musicMutePlatformURL(platform) {
      Link(destination: destination) {
        Label {
          VStack(alignment: .leading, spacing: 4) {
            Text(title)
            Text(description).font(.caption).foregroundStyle(.secondary)
          }
        } icon: {
          Image(systemName: systemImage)
        }
      }
      .accessibilityLabel(Text(title))
      .accessibilityHint(Text(description))
      .accessibilityIdentifier(identifier)
    }
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
