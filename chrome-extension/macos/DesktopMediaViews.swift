import AppKit
import SwiftUI
import UniformTypeIdentifiers

enum DesktopHomeLibraryConnection: Equatable {
  case signedOut
  case connecting
  case offline
  case connected

  static func resolve(
    signedIn: Bool, accountOnline: Bool, libraryConnected: Bool, connectionInProgress: Bool
  ) -> Self {
    guard signedIn else { return .signedOut }
    if isConnected(
      signedIn: signedIn, accountOnline: accountOnline, libraryConnected: libraryConnected)
    {
      return .connected
    }
    if accountOnline || connectionInProgress { return .connecting }
    return .offline
  }

  static func isConnected(
    signedIn: Bool, accountOnline: Bool, libraryConnected: Bool
  ) -> Bool {
    signedIn && accountOnline && libraryConnected
  }

  var title: String {
    switch self {
    case .signedOut: "Your songs, on every device"
    case .connecting: "Connecting your library"
    case .offline: "Your library is offline"
    case .connected: "Your library follows you"
    }
  }

  var detail: String {
    switch self {
    case .signedOut:
      "Sign in to sync your MusicMute library across Mac, web, and mobile."
    case .connecting:
      "Your account is signed in. MusicMute is connecting your library; local playback stays available."
    case .offline:
      "Your account is still signed in. Local playback stays available while MusicMute reconnects."
    case .connected:
      "Your MusicMute library is connected across Mac, web, and mobile."
    }
  }

  var systemImage: String {
    switch self {
    case .signedOut: "person.crop.circle.badge.plus"
    case .connecting: "arrow.clockwise"
    case .offline: "icloud.slash"
    case .connected: "checkmark.icloud.fill"
    }
  }
}

struct DesktopHomeView: View {
  @ObservedObject var workspace: DesktopWorkspace
  @ObservedObject var account: DesktopAccountModel
  var openAccount: () -> Void = {}
  @AppStorage(DesktopPreferenceKey.importSource) private var source =
    DesktopImportSourcePreference.youtube.rawValue
  @AppStorage(DesktopPreferenceKey.processingMode) private var mode =
    DesktopProcessingPreference.local.rawValue
  @State private var link = ""
  @State private var file: URL?
  @State private var rights = false
  @State private var confirmCloud = false
  @State private var cloudConfirmation: DesktopCloudConfirmation?
  @State private var handoffCloudSelected = false
  @State private var estimatedCloudSeconds: Int?
  @State private var estimatedCloudSource: String?
  @Environment(\.locale) private var locale
  @FocusState private var linkFocused: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      accountAndProductsCard
      HStack(alignment: .firstTextBaseline) {
        Label("New voice", systemImage: "waveform.badge.plus").font(.title2.weight(.semibold))
        Spacer()
        Label("Audio only · up to 20 minutes", systemImage: "timer")
          .font(.caption).foregroundStyle(Brand.secondary)
      }
      if account.updateRequired {
        Label("Update MusicMute before starting new processing.", systemImage: "arrow.down.app")
          .foregroundStyle(Brand.amber)
        if let build = account.requiredBuild {
          Text("Required app build: \(build)").font(.caption).foregroundStyle(Brand.secondary)
        }
        Button("Open MusicMute website") {
          MusicMuteProductLinks.open(.downloads)
        }.buttonStyle(.bordered)
      }
      Text(
        "Paste a supported video link or choose an audio file. MusicMute keeps the full timeline and prepares voice-only audio."
      )
      .font(.body).foregroundStyle(Brand.secondary)
      Picker("Source", selection: $source) {
        ForEach(DesktopImportSourcePreference.allCases, id: \.self) { option in
          Label(
            LocalizedStringKey(option.title),
            systemImage: option == .youtube ? "link" : "waveform"
          )
          .tag(option.rawValue)
        }
      }.pickerStyle(.segmented).accessibilityIdentifier("import_source")
      if selectedSource == .youtube {
        HStack(spacing: 10) {
          TextField("Paste a supported video URL", text: $link)
            .textFieldStyle(.roundedBorder)
            .controlSize(.large)
            .focused($linkFocused)
            .onSubmit { startProcessing() }
            .accessibilityIdentifier("import_youtube_url")
          Button("Paste", systemImage: "doc.on.clipboard") { pasteLink() }
            .buttonStyle(.bordered).controlSize(.large)
            .help("Paste a video URL from the Clipboard")
        }
        .environment(\.layoutDirection, .leftToRight)
      } else {
        HStack(spacing: 12) {
          Button("Choose Audio…", systemImage: "folder") { chooseAudio() }
            .buttonStyle(.bordered).controlSize(.large)
            .accessibilityIdentifier("import_choose_file")
          VStack(alignment: .leading, spacing: 3) {
            Text(file?.lastPathComponent ?? "No audio selected").lineLimit(1)
            Text("You can also drop an audio file anywhere on this card.")
              .font(.caption).foregroundStyle(Brand.secondary)
          }
        }
      }
      Picker("Process using", selection: processingSelection) {
        ForEach(DesktopProcessingPreference.allCases, id: \.self) { option in
          Label(
            LocalizedStringKey(option.title),
            systemImage: option == .local ? "desktopcomputer" : "cloud"
          )
          .tag(option.rawValue)
        }
      }.pickerStyle(.segmented).accessibilityIdentifier("processing_mode")
      Text("This choice is saved and also used by the Chrome extension.")
        .font(.caption).foregroundStyle(Brand.secondary)
      Label(
        LocalizedStringKey(
          selectedProcessing == .local
            ? "Uses your Mac. No cloud processing minutes."
            : "Uses the same account processing allowance as Android."),
        systemImage: selectedProcessing == .local ? "desktopcomputer" : "cloud"
      )
      .font(.callout).foregroundStyle(Brand.secondary)
      if selectedSource == .youtube {
        Text(
          LocalizedStringKey(
            account.signedIn
              ? "Video-link originals and voice results may be added to MusicMute’s reusable shared cache. Your result is also linked to your account library."
              : "Video-link originals and voice results may be added to MusicMute’s reusable shared cache. Sign in to link the result to your account library."
          )
        )
        .font(.caption).foregroundStyle(Brand.secondary)
      } else if account.signedIn {
        Text(
          "Audio files stay private. After local processing, your original and voice result are saved to your account; storage and transfer allowances apply."
        )
        .font(.caption).foregroundStyle(Brand.secondary)
      } else {
        Text("Audio files stay on this Mac unless you sign in to save them to your account.")
          .font(.caption).foregroundStyle(Brand.secondary)
      }
      if selectedProcessing == .cloud {
        Button(account.signedIn ? "Review or switch account" : "Sign in to use MusicMute cloud") {
          openAccount()
        }.buttonStyle(.bordered).accessibilityIdentifier("cloud_open_account")
        if let usage = DesktopUsagePresentation.parse(workspace.usage) {
          Text(
            "Remaining this month: \(DesktopUsagePresentation.durationLabel(seconds: usage.processing.remaining, locale: locale))"
          )
          .font(.callout).foregroundStyle(Brand.secondary)
          Text(
            "Allowance resets \(DesktopUsagePresentation.resetLabel(usage.resetAt, locale: locale))"
          )
          .font(.caption).foregroundStyle(Brand.secondary)
        } else {
          Text(
            "Your current allowance appears after account connection. Cloud processing requires an available allowance."
          )
          .font(.caption).foregroundStyle(Brand.secondary)
        }
        if let seconds = estimatedCloudSeconds {
          Text(
            "Estimated processing usage: \(DesktopUsagePresentation.durationLabel(seconds: Int64(seconds), locale: locale))"
          )
          .font(.callout).foregroundStyle(Brand.secondary)
        }
        Text(
          "New cloud processing uses the full audio duration, rounded up to seconds. Compatible saved results may be reused without new processing usage. The server confirms admission and usage."
        )
        .font(.caption).foregroundStyle(Brand.secondary)
      }
      Toggle("I have permission to process this audio", isOn: $rights).accessibilityIdentifier(
        "import_rights")
      HStack {
        Button(
          LocalizedStringKey(workspace.processing ? "Preparing voice…" : "Remove background music")
        ) { startProcessing() }
        .buttonStyle(.borderedProminent).controlSize(.large)
        .keyboardShortcut(.defaultAction)
        .disabled(!canStart)
        .accessibilityIdentifier("import_start")
        if workspace.processing {
          ProgressView().controlSize(.small)
          Text(workspace.progress).font(.callout).foregroundStyle(Brand.secondary)
          Button("Cancel") { workspace.cancelProcessing() }.buttonStyle(.bordered)
            .accessibilityIdentifier("import_cancel")
        }
      }
      if let failure = workspace.failure {
        Label(LocalizedStringKey(failure), systemImage: "exclamationmark.circle").foregroundStyle(
          Brand.amber
        )
        .accessibilityIdentifier("media_error")
      }
      if let notice = workspace.notice {
        Text(LocalizedStringKey(notice)).foregroundStyle(Brand.secondary)
      }
      Text(
        "Offline voices use up to \(bytesLabel(workspace.budgetBytes)). Change the limit in Settings. Saved voices are reused before processing again; older unused files can be removed to make room."
      )
      .font(.caption).foregroundStyle(Brand.secondary)
    }
    .padding(24)
    .background(Brand.surface, in: RoundedRectangle(cornerRadius: 20))
    .overlay(RoundedRectangle(cornerRadius: 20).stroke(Brand.border))
    .dropDestination(for: URL.self) { urls, _ in
      guard let audio = urls.first(where: isAudioFile) else { return false }
      file = audio
      source = DesktopImportSourcePreference.file.rawValue
      return true
    }
    .onAppear { applyCloudHandoff() }
    .onChange(of: workspace.pendingCloudHandoff) { _, _ in applyCloudHandoff() }
    .onChange(of: link) { _, _ in
      if link != estimatedCloudSource {
        estimatedCloudSeconds = nil
        estimatedCloudSource = nil
        workspace.consumeCloudHandoff()
      }
      confirmCloud = false
      cloudConfirmation = nil
    }
    .onChange(of: account.scope) { _, _ in
      confirmCloud = false
      cloudConfirmation = nil
    }
    .onChange(of: source) { _, value in
      confirmCloud = false
      cloudConfirmation = nil
      if value != DesktopImportSourcePreference.youtube.rawValue {
        estimatedCloudSeconds = nil
        estimatedCloudSource = nil
        workspace.consumeCloudHandoff()
      }
    }
    .onChange(of: rights) { _, hasRights in
      if !hasRights {
        confirmCloud = false
        cloudConfirmation = nil
      }
    }
    .confirmationDialog("Use your cloud processing allowance?", isPresented: $confirmCloud) {
      Button("Process in MusicMute cloud") {
        guard let confirmation = cloudConfirmation,
          confirmation.matches(
            url: selectedSource == .youtube ? link : nil,
            file: selectedSource == .file ? file : nil, scope: account.scope, hasRights: rights),
          canStart
        else { return }
        mode = DesktopProcessingPreference.cloud.rawValue
        handoffCloudSelected = false
        cloudConfirmation = nil
        workspace.consumeCloudHandoff()
        Task {
          await workspace.process(
            url: confirmation.sourceURL,
            file: confirmation.sourceFile,
            cloud: true, expectedAccountScope: confirmation.accountScope)
        }
      }
    } message: {
      Text(cloudConfirmationMessage)
    }
  }

  private var accountAndProductsCard: some View {
    let connection = DesktopHomeLibraryConnection.resolve(
      signedIn: account.signedIn, accountOnline: account.online,
      libraryConnected: workspace.libraryConnected,
      connectionInProgress: account.authenticating)
    return VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: connection.systemImage)
          .font(.title2)
          .foregroundStyle(
            connection == .connected
              ? Brand.mint : connection == .signedOut ? Brand.accent : Brand.amber
          )
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 5) {
          Text(LocalizedStringKey(connection.title))
            .font(.headline)
          Text(LocalizedStringKey(connection.detail))
            .font(.callout)
            .foregroundStyle(Brand.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 8)
      }

      if !account.signedIn {
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 10) { signInActions }
          VStack(alignment: .leading, spacing: 10) { signInActions }
        }
      }

      Divider().overlay(Brand.border)
      Text("Also available from MusicMute")
        .font(.caption.weight(.semibold))
        .foregroundStyle(Brand.secondary)
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 10) { productActions }
        VStack(alignment: .leading, spacing: 10) { productActions }
      }
    }
    .padding(18)
    .background(Brand.raised, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Brand.border))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("home_account_products")
  }

  @ViewBuilder private var signInActions: some View {
    Button {
      Task { await account.signInGoogle() }
    } label: {
      GoogleSignInLabel("Continue with Google")
    }
    .buttonStyle(.borderedProminent)
    .tint(Brand.accent)
    .disabled(account.busy || account.restoring || !account.googleConfigured)
    .accessibilityIdentifier("home_google_sign_in")

    Button("Sign in with email") { openAccount() }
      .buttonStyle(.bordered)
      .disabled(account.busy || account.restoring)
      .accessibilityIdentifier("home_email_sign_in")
  }

  @ViewBuilder private var productActions: some View {
    Button {
      MusicMuteProductLinks.open(.webApp)
    } label: {
      Label("Open web app", systemImage: "safari")
    }
    .buttonStyle(.bordered)
    .accessibilityIdentifier("home_web_app")

    Button {
      MusicMuteProductLinks.open(.googlePlay)
    } label: {
      Label("Android on Google Play", systemImage: "play.fill")
    }
    .buttonStyle(.bordered)
    .accessibilityIdentifier("home_google_play")
  }

  private var selectedSource: DesktopImportSourcePreference {
    DesktopImportSourcePreference(rawValue: source) ?? .youtube
  }

  private var selectedProcessing: DesktopProcessingPreference {
    handoffCloudSelected ? .cloud : DesktopProcessingPreference(rawValue: mode) ?? .local
  }

  private var processingSelection: Binding<String> {
    Binding(
      get: { selectedProcessing.rawValue },
      set: { value in
        handoffCloudSelected = false
        mode = value
        workspace.consumeCloudHandoff()
        confirmCloud = false
        cloudConfirmation = nil
      })
  }

  private var cloudConfirmationMessage: String {
    var parts = [
      String(
        localized:
          "This request is sent to MusicMute and uses your account's cloud processing allowance. Compatible saved account results are reused.",
        locale: locale
      )
    ]
    if let usage = DesktopUsagePresentation.parse(workspace.usage) {
      parts.append(
        String(
          localized:
            "Remaining this month: \(DesktopUsagePresentation.durationLabel(seconds: usage.processing.remaining, locale: locale))",
          locale: locale
        ))
      parts.append(
        String(
          localized:
            "Allowance resets \(DesktopUsagePresentation.resetLabel(usage.resetAt, locale: locale))",
          locale: locale
        ))
    }
    if let seconds = cloudConfirmation?.estimatedDurationSeconds {
      parts.append(
        String(
          localized:
            "Estimated processing usage: \(DesktopUsagePresentation.durationLabel(seconds: Int64(seconds), locale: locale))",
          locale: locale
        ))
    } else {
      parts.append(
        String(
          localized:
            "Processing usage is based on the full audio duration. The server confirms admission and usage.",
          locale: locale
        ))
    }
    return parts.joined(separator: "\n")
  }

  private func applyCloudHandoff() {
    guard let handoff = workspace.pendingCloudHandoff else { return }
    confirmCloud = false
    cloudConfirmation = nil
    source = DesktopImportSourcePreference.youtube.rawValue
    file = nil
    rights = false
    handoffCloudSelected = true
    link = handoff.sourceURL
    estimatedCloudSource = handoff.sourceURL
    estimatedCloudSeconds = handoff.estimatedDurationSeconds
  }

  private var canStart: Bool {
    !workspace.processing && !account.updateRequired && rights
      && (selectedSource == .youtube
        ? !link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        : file != nil)
      && (selectedProcessing == .local || account.signedIn)
      && (selectedProcessing == .local
        || (workspace.cloudConnected && DesktopUsagePresentation.parse(workspace.usage) != nil))
  }

  private func startProcessing() {
    guard canStart else { return }
    if selectedProcessing == .cloud {
      guard let scope = account.scope else { return }
      cloudConfirmation = DesktopCloudConfirmation(
        sourceURL: selectedSource == .youtube ? link : nil,
        sourceFile: selectedSource == .file ? file : nil, accountScope: scope,
        estimatedDurationSeconds: estimatedCloudSeconds)
      confirmCloud = true
      return
    }
    Task {
      await workspace.process(
        url: selectedSource == .youtube ? link : nil,
        file: selectedSource == .file ? file : nil, cloud: false)
    }
  }

  private func pasteLink() {
    guard
      let value = NSPasteboard.general.string(forType: .string)?
        .trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty
    else { return }
    link = value
    source = DesktopImportSourcePreference.youtube.rawValue
    linkFocused = true
  }

  private func chooseAudio() {
    let picker = NSOpenPanel()
    picker.canChooseDirectories = false
    picker.allowsMultipleSelection = false
    picker.allowedContentTypes = [.audio]
    picker.prompt = "Choose Audio"
    if picker.runModal() == .OK { file = picker.url }
  }

  private func isAudioFile(_ url: URL) -> Bool {
    guard url.isFileURL,
      let values = try? url.resourceValues(forKeys: [.contentTypeKey]),
      let type = values.contentType
    else { return false }
    return type.conforms(to: .audio)
  }
}

enum MusicMuteProductLinks: CaseIterable, Sendable {
  case webApp
  case googlePlay
  case downloads

  var url: URL {
    switch self {
    case .webApp:
      URL(string: "https://app.music-mute.com")!
    case .googlePlay:
      URL(string: "https://play.google.com/store/apps/details?id=com.hatem.musicmute")!
    case .downloads:
      URL(string: "https://music-mute.com/#downloads")!
    }
  }

  static func isAllowed(_ url: URL) -> Bool {
    guard url.scheme == "https", url.user == nil, url.password == nil, url.port == nil else {
      return false
    }
    switch (url.host?.lowercased(), url.path, url.fragment) {
    case ("app.music-mute.com", "", nil) where url.query == nil:
      return true
    case ("play.google.com", "/store/apps/details", nil):
      return URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        == [URLQueryItem(name: "id", value: "com.hatem.musicmute")]
    case ("music-mute.com", "/", "downloads") where url.query == nil:
      return true
    default:
      return false
    }
  }

  @MainActor static func open(_ destination: MusicMuteProductLinks) {
    let url = destination.url
    guard isAllowed(url) else { return }
    NSWorkspace.shared.open(url)
  }
}

struct DesktopLibraryView: View {
  @ObservedObject var workspace: DesktopWorkspace
  @State private var search = ""
  @State private var filter = "All"
  @State private var sort = "Newest"
  @State private var renameTrack: DesktopTrack?
  @State private var renameTitle = ""
  @State private var deleteTrack: DesktopTrack?
  private var accountLibraryConnected: Bool {
    DesktopHomeLibraryConnection.isConnected(
      signedIn: workspace.account.signedIn,
      accountOnline: workspace.account.online,
      libraryConnected: workspace.libraryConnected)
  }
  private var visible: [DesktopTrack] {
    let values = workspace.tracks.filter { track in
      (search.isEmpty || track.title.localizedCaseInsensitiveContains(search))
        && (filter == "Removed" ? workspace.removed(track) : !workspace.removed(track))
        && (filter != "Starred" || workspace.starred(track))
        && (filter != "Offline" || track.path != nil)
        && (filter != "Online" || track.path == nil)
    }
    return sort == "Title"
      ? values.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
      : DesktopWorkspace.newestTracks(values)
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack {
        Spacer()
        Picker("Filter", selection: $filter) {
          ForEach(["All", "Starred", "Offline", "Online", "Removed"], id: \.self) {
            Text(LocalizedStringKey($0))
          }
        }.frame(width: 140)
        Picker("Sort", selection: $sort) {
          Text("Newest")
          Text("Title")
        }.frame(width: 140)
      }
      HStack {
        Label(
          "\(bytesLabel(workspace.cacheBytes)) of \(bytesLabel(workspace.budgetBytes)) offline voices",
          systemImage: "internaldrive"
        )
        Spacer()
        if workspace.account.signedIn {
          Label(
            LocalizedStringKey(
              accountLibraryConnected
                ? "Account library connected" : "Connecting account library…"
            ),
            systemImage: accountLibraryConnected ? "checkmark.icloud" : "icloud")
        }
      }.font(.caption).foregroundStyle(Brand.secondary)
      if let failure = workspace.failure {
        Text(LocalizedStringKey(failure)).foregroundStyle(Brand.amber)
      }
      if visible.isEmpty {
        ContentUnavailableView(
          "Your voices appear here", systemImage: "waveform",
          description: Text(
            "Process audio on Home or sign in to see your account library. Saved voices are available offline."
          )
        )
        .frame(minHeight: 180)
      }
      LazyVStack(spacing: 10) {
        ForEach(visible) { track in
          HStack(spacing: 14) {
            Button {
              Task { await workspace.play(track) }
            } label: {
              Group {
                if workspace.currentTrack?.id == track.id && workspace.preparingPlayback {
                  ProgressView().controlSize(.small)
                } else {
                  Image(
                    systemName: workspace.currentTrack?.id == track.id && workspace.playing
                      ? "waveform" : "play.fill")
                }
              }.frame(width: 44, height: 44)
            }.buttonStyle(.bordered).tint(Brand.accent).accessibilityLabel("Play \(track.title)")
              .help("Play \(track.title)")
              .disabled(workspace.currentTrack?.id == track.id && workspace.preparingPlayback)
            VStack(alignment: .leading, spacing: 4) {
              Text(track.title).font(.headline).lineLimit(2)
              Text(
                "\(durationLabel(track.duration * 1000)) · \(track.path == nil ? "Account voice" : "Saved offline")"
              ).font(.caption).foregroundStyle(Brand.secondary)
            }
            Spacer()
            Button {
              workspace.favorite(track)
            } label: {
              Image(systemName: workspace.starred(track) ? "star.fill" : "star")
                .frame(width: 32, height: 32)
            }
            .buttonStyle(.plain).foregroundStyle(Brand.accent).accessibilityLabel(
              workspace.starred(track) ? "Remove star from \(track.title)" : "Star \(track.title)"
            ).accessibilityValue(workspace.starred(track) ? "Starred" : "Not starred")
            .help(workspace.starred(track) ? "Remove from starred" : "Add to starred")
            Menu {
              Button("Play next") { workspace.queue.insert(track, at: 0) }
              Button("Add to queue") { workspace.queue.append(track) }
              Button(
                LocalizedStringKey(
                  workspace.removed(track) ? "Restore in library" : "Remove from library")
              ) {
                workspace.hide(track)
              }
              if track.jobId != nil {
                Button("Rename") {
                  renameTrack = track
                  renameTitle = track.title
                }
                if track.path == nil {
                  Button("Keep offline") { Task { await workspace.download(track) } }
                }
                if track.originalAvailable {
                  Button("Play original") { Task { await workspace.play(track, original: true) } }
                }
                Button("Delete from account", role: .destructive) { deleteTrack = track }
              }
              if track.path != nil {
                Button("Export voice") { workspace.export(track) }
                Button("Share voice") { workspace.share(track) }
              }
            } label: {
              Image(systemName: "ellipsis").frame(width: 32, height: 32)
            }.menuStyle(.borderlessButton).frame(width: 36)
              .accessibilityLabel("More actions for \(track.title)")
              .help("More actions")
          }
          .padding(16)
          .background(Brand.surface, in: RoundedRectangle(cornerRadius: 16))
          .overlay(RoundedRectangle(cornerRadius: 16).stroke(Brand.border))
        }
      }
      if workspace.localHasMore {
        Button("More offline voices") { Task { await workspace.nextLocalPage() } }.buttonStyle(
          .bordered)
      }
      if workspace.cloudHasMore {
        Button("Next account page") { Task { await workspace.nextCloudPage() } }.buttonStyle(
          .bordered)
      }
      if !workspace.queue.isEmpty {
        GroupBox("Play queue") {
          VStack(alignment: .leading) {
            ForEach(Array(workspace.queue.enumerated()), id: \.offset) { index, track in
              HStack {
                Text(track.title).lineLimit(1)
                Spacer()
                Button("Play") {
                  workspace.queue.remove(at: index)
                  Task { await workspace.play(track) }
                }
                if index > 0 { Button("Move up") { workspace.queue.swapAt(index, index - 1) } }
                Button("Remove") { workspace.queue.remove(at: index) }
              }.padding(.vertical, 6)
            }
            Button("Clear queue") { workspace.queue = [] }
          }.padding(12)
        }
      }
    }
    .searchable(text: $search, placement: .toolbar, prompt: "Search voices")
    .accessibilityIdentifier("library_search")
    .sheet(
      isPresented: Binding(get: { renameTrack != nil }, set: { if !$0 { renameTrack = nil } })
    ) {
      VStack(spacing: 16) {
        Text("Rename voice").font(.title2)
        TextField("Title", text: $renameTitle).textFieldStyle(.roundedBorder)
        HStack {
          Button("Cancel") { renameTrack = nil }
          Button("Save") {
            if let track = renameTrack {
              Task { await workspace.rename(track, title: renameTitle) }
            }
            renameTrack = nil
          }.disabled(
            renameTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              || renameTitle.count > 200)
        }
      }.padding(30).frame(width: 420)
    }.confirmationDialog(
      "Delete this result from your account?",
      isPresented: Binding(get: { deleteTrack != nil }, set: { if !$0 { deleteTrack = nil } })
    ) {
      if let track = deleteTrack {
        Button("Delete result", role: .destructive) {
          deleteTrack = nil
          Task { await workspace.deleteCloud(track) }
        }
      }
    } message: {
      Text(
        "This removes account access to both the original and voice result. The server applies its storage cleanup policy."
      )
    }
  }
}

struct DesktopMiniPlayer: View {
  @ObservedObject var workspace: DesktopWorkspace
  @AppStorage(DesktopPreferenceKey.expandPlayer) private var autoExpandPlayer = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var controlsExpanded = false
  @State private var sleepMinutes = 0

  var body: some View {
    if let track = workspace.currentTrack {
      VStack(spacing: 0) {
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 12) {
            compactTransportControls
            Divider().frame(height: 36)
            trackIdentity(track)
              .frame(minWidth: 170, maxWidth: .infinity, alignment: .leading)
            audioSourcePicker(track)
            playerActions(track)
          }
          VStack(spacing: 8) {
            HStack(spacing: 12) {
              trackIdentity(track)
                .frame(maxWidth: .infinity, alignment: .leading)
              playerActions(track)
            }
            HStack(spacing: 14) {
              audioSourcePicker(track)
              Spacer(minLength: 8)
              compactTransportControls
            }
          }
        }
        .padding(.horizontal, 18).padding(.top, 10).padding(.bottom, 7)
        playbackFooter
          .padding(.horizontal, 18).padding(.bottom, 9)
        if controlsExpanded {
          Divider()
          expandedControls(track)
            .padding(.horizontal, 18).padding(.vertical, 12)
            .transition(.opacity.combined(with: .scale(scale: 0.985, anchor: .bottom)))
        }
      }
      .background(
        .ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous)
      )
      .overlay {
        RoundedRectangle(cornerRadius: 18, style: .continuous)
          .stroke(Brand.border.opacity(0.8))
      }
      .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
      .padding(.horizontal, 14)
      .padding(.top, 4)
      .padding(.bottom, 12)
      .accessibilityIdentifier("desktop_player")
      .transition(.opacity)
      .onAppear { expandControlsIfPreferred(animated: false) }
      .onChange(of: workspace.playing) { wasPlaying, isPlaying in
        if isPlaying && !wasPlaying { expandControlsIfPreferred(animated: true) }
      }
      .onChange(of: autoExpandPlayer) { _, enabled in
        if enabled && workspace.playing { expandControlsIfPreferred(animated: true) }
      }
    }
  }

  @ViewBuilder private var playbackFooter: some View {
    if let preparation = workspace.playbackPreparation {
      HStack(spacing: 10) {
        if case .failed = preparation {
          Image(systemName: "exclamationmark.circle")
            .foregroundStyle(Brand.amber)
            .accessibilityHidden(true)
        } else {
          ProgressView().controlSize(.small)
            .accessibilityHidden(true)
        }
        Text(LocalizedStringKey(preparation.message))
          .font(.caption.weight(.medium))
          .foregroundStyle(Brand.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("player_preparation_status")
        Spacer(minLength: 8)
        if case .failed = preparation {
          Button("Retry") { Task { await workspace.retryPlayback() } }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("player_retry")
        }
        if workspace.preparingPlayback {
          Button("Cancel") { workspace.stop() }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("player_cancel")
        } else if case .failed = preparation {
          Button("Dismiss") { workspace.stop() }.buttonStyle(.bordered)
        }
      }
      .controlSize(.small)
      .frame(minHeight: 26)
    } else {
      DesktopPlaybackScrubber(workspace: workspace, clock: workspace.playbackClock)
        .disabled(!workspace.canControlPlayback)
        .frame(minHeight: 26)
    }
  }

  private func trackIdentity(_ track: DesktopTrack) -> some View {
    HStack(spacing: 12) {
      ZStack {
        RoundedRectangle(cornerRadius: 9, style: .continuous)
          .fill(
            LinearGradient(
              colors: [Brand.accent.opacity(0.38), Brand.accent.opacity(0.12)],
              startPoint: .topLeading, endPoint: .bottomTrailing))
        Image(systemName: workspace.originalPlaying ? "music.note" : "waveform")
          .font(.system(size: 19, weight: .semibold))
          .foregroundStyle(Brand.accent)
      }
      .frame(width: 42, height: 42)
      .overlay(
        RoundedRectangle(cornerRadius: 9, style: .continuous)
          .stroke(Brand.border.opacity(0.65))
      )
      .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 3) {
        Text(track.title).font(.callout.weight(.semibold)).lineLimit(1).truncationMode(.tail)
        Label(
          LocalizedStringKey(workspace.originalPlaying ? "Original audio" : "Voice only"),
          systemImage: workspace.originalPlaying ? "music.note" : "waveform"
        )
        .font(.caption)
        .foregroundStyle(Brand.secondary)
      }
    }
    .accessibilityElement(children: .combine)
  }
  @ViewBuilder private func audioSourcePicker(_ track: DesktopTrack) -> some View {
    if workspace.preparingOriginal {
      HStack(spacing: 8) {
        ProgressView().controlSize(.small)
        Text("Preparing original…").font(.caption.weight(.medium))
      }
      .foregroundStyle(Brand.secondary)
      .frame(width: 230, height: 32)
      .accessibilityElement(children: .combine)
    } else if workspace.canCompareOriginal {
      Picker(
        "Playback",
        selection: Binding(
          get: { workspace.originalPlaying },
          set: { original in
            guard original != workspace.originalPlaying else { return }
            Task { await workspace.compareOriginal() }
          })
      ) {
        Text("Voice only").tag(false)
        Text("Original audio").tag(true)
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .controlSize(.small)
      .frame(width: 190)
      .accessibilityLabel("Playback")
      .help(workspace.originalPlaying ? "Play voice" : "Play original")
      .disabled(!workspace.canControlPlayback)
    } else {
      Label("Voice only", systemImage: "waveform")
        .font(.caption.weight(.medium))
        .foregroundStyle(Brand.secondary)
        .padding(.horizontal, 12)
        .frame(height: 32)
        .background(Brand.raised, in: Capsule())
    }
  }

  private var compactTransportControls: some View {
    HStack(spacing: 2) {
      DesktopPlayerIconButton(
        title: "Shuffle", systemImage: "shuffle", selected: workspace.shuffle,
        accessibilityValue: workspace.shuffle ? "On" : "Off",
        help: workspace.shuffle ? "Turn shuffle off" : "Turn shuffle on"
      ) { workspace.shuffle.toggle() }
      DesktopPlayerIconButton(title: "Restart voice", systemImage: "backward.end.fill") {
        workspace.seek(0)
      }
      .disabled(!workspace.canControlPlayback)
      if workspace.preparingPlayback {
        ProgressView()
          .controlSize(.small)
          .frame(width: 40, height: 40)
          .background(Brand.accent.opacity(0.15), in: Circle())
          .accessibilityLabel(
            Text(LocalizedStringKey(workspace.playbackPreparation?.message ?? "Preparing voice…")))
      } else {
        DesktopPlayerIconButton(
          title: workspace.playing ? "Pause" : "Play",
          systemImage: workspace.playing ? "pause.fill" : "play.fill", prominent: true
        ) { workspace.togglePlayback() }
        .disabled(!workspace.canControlPlayback)
      }
      DesktopPlayerIconButton(title: "Next voice", systemImage: "forward.end.fill") {
        Task { await workspace.next() }
      }
      .disabled(!workspace.canControlPlayback)
      DesktopPlayerIconButton(
        title: "Repeat",
        systemImage: workspace.repeatMode == "Track" ? "repeat.1" : "repeat",
        selected: workspace.repeatMode != "Off",
        accessibilityValue: LocalizedStringKey(workspace.repeatMode),
        help: repeatHelp
      ) {
        workspace.repeatMode =
          switch workspace.repeatMode {
          case "Off": "Queue"
          case "Queue": "Track"
          default: "Off"
          }
      }
    }
    .controlSize(.small)
  }

  private func playerActions(_ track: DesktopTrack) -> some View {
    HStack(spacing: 2) {
      Button {
        withAnimation(reduceMotion ? nil : .snappy) { controlsExpanded.toggle() }
      } label: {
        Image(systemName: controlsExpanded ? "list.bullet.circle.fill" : "list.bullet")
          .frame(width: 38, height: 38)
          .contentShape(Circle())
      }
      .buttonStyle(.plain)
      .foregroundStyle(controlsExpanded ? Brand.accent : Brand.secondary)
      .background(controlsExpanded ? Brand.accent.opacity(0.12) : .clear, in: Circle())
      .accessibilityLabel(controlsExpanded ? "Hide listening tools" : "Show listening tools")
      .help(controlsExpanded ? "Hide listening tools" : "Show listening tools")
      DesktopVolumeButton(workspace: workspace, state: workspace.playbackVolumeState)
      Menu {
        Button(controlsExpanded ? "Hide listening tools" : "Show listening tools") {
          withAnimation(reduceMotion ? nil : .snappy) { controlsExpanded.toggle() }
        }
        if track.path != nil {
          Divider()
          Button("Export voice") { workspace.export(track) }
          Button("Share") { workspace.share(track) }
        }
        Divider()
        Button("Stop playback", role: .destructive) { workspace.stop() }
      } label: {
        Image(systemName: "ellipsis").frame(width: 38, height: 38).contentShape(Circle())
      }
      .menuStyle(.borderlessButton)
      .menuIndicator(.hidden)
      .fixedSize()
      .accessibilityLabel("More playback actions")
      .help("More playback actions")
    }
  }

  private func expandedControls(_ track: DesktopTrack) -> some View {
    LazyVGrid(
      columns: [GridItem(.adaptive(minimum: 240, maximum: 380), spacing: 12)],
      alignment: .leading, spacing: 12
    ) {
      controlCard(title: "Playback", symbol: "dial.medium") {
        DesktopVolumeControl(workspace: workspace, state: workspace.playbackVolumeState)
        LabeledContent("Speed") {
          Picker(
            "Speed",
            selection: Binding(get: { workspace.rate }, set: { workspace.changeRate($0) })
          ) {
            ForEach([0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0], id: \.self) {
              Text(String(format: "%.2g×", $0)).tag($0)
            }
          }
          .labelsHidden()
          .frame(width: 110)
        }
        .disabled(!workspace.canControlPlayback)
        LabeledContent("Sleep timer") {
          Picker("Sleep timer", selection: $sleepMinutes) {
            ForEach([0, 5, 10, 15, 30, 60], id: \.self) {
              if $0 == 0 { Text("Off").tag($0) } else { Text("\($0) minutes").tag($0) }
            }
          }
          .labelsHidden()
          .frame(width: 110)
          .onChange(of: sleepMinutes) { _, value in
            workspace.sleep(after: Double(value * 60))
          }
        }
        .disabled(!workspace.canControlPlayback)
      }
      controlCard(title: "Loop", symbol: "repeat") {
        DesktopLoopControls(workspace: workspace, clock: workspace.playbackClock)
      }
      .disabled(!workspace.canControlPlayback)
      controlCard(title: "Voice only", symbol: "waveform") {
        Toggle(
          "Skip silence",
          isOn: Binding(
            get: { workspace.skipSilence },
            set: { value in
              Task { await workspace.setSkipSilence(value) }
            })
        )
        .toggleStyle(.switch)
        .disabled(
          !workspace.canControlPlayback || track.path == nil || workspace.originalPlaying
            || workspace.analyzingSilence)
        if workspace.analyzingSilence {
          HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text("Preparing silence skipping…")
          }
          .font(.caption)
          .foregroundStyle(Brand.secondary)
        } else if track.path == nil {
          Text("Keep this voice offline to skip silence.")
            .font(.caption)
            .foregroundStyle(Brand.secondary)
        }
        if track.path != nil {
          HStack {
            Button("Export voice") { workspace.export(track) }
            Button("Share") { workspace.share(track) }
          }
        }
      }
      controlCard(title: "Queue", symbol: "music.note.list") {
        if workspace.queue.isEmpty {
          Text("Add voices from Library to keep listening.")
            .font(.caption)
            .foregroundStyle(Brand.secondary)
        } else {
          ForEach(Array(workspace.queue.prefix(4).enumerated()), id: \.offset) { index, item in
            HStack(spacing: 8) {
              Text(item.title).lineLimit(1)
              Spacer()
              Button {
                workspace.queue.remove(at: index)
              } label: {
                Image(systemName: "xmark").frame(width: 28, height: 28)
              }
              .buttonStyle(.plain)
              .accessibilityLabel(Text("Remove \(item.title) from queue"))
            }
          }
          if workspace.queue.count > 4 {
            Text("\(workspace.queue.count - 4) more")
              .font(.caption)
              .foregroundStyle(Brand.secondary)
          }
          HStack {
            Button("Play next") { Task { await workspace.next() } }
            Spacer()
            Button("Clear queue") { workspace.queue = [] }
          }
        }
      }
    }
  }

  private func controlCard<Content: View>(
    title: LocalizedStringKey, symbol: String, @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Label(title, systemImage: symbol)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(Brand.secondary)
      Divider()
      content()
    }
    .padding(14)
    .frame(maxWidth: .infinity, minHeight: 132, alignment: .topLeading)
    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(Brand.border.opacity(0.65)))
  }

  private func expandControlsIfPreferred(animated: Bool) {
    guard autoExpandPlayer, !controlsExpanded else { return }
    withAnimation(animated && !reduceMotion ? .snappy : nil) { controlsExpanded = true }
  }

  private var repeatHelp: LocalizedStringKey {
    switch workspace.repeatMode {
    case "Queue": "Repeat queue"
    case "Track": "Repeat track"
    default: "Repeat off"
    }
  }
}

private struct DesktopPlaybackScrubber: View {
  let workspace: DesktopWorkspace
  @ObservedObject var clock: DesktopPlaybackClock
  @State private var scrubPosition: Double?

  private var displayedPosition: Double { scrubPosition ?? clock.position }

  var body: some View {
    HStack(spacing: 10) {
      Text(desktopClock(displayedPosition))
        .frame(minWidth: 36, alignment: .trailing)
      Slider(
        value: Binding(
          get: { displayedPosition },
          set: { scrubPosition = min(max(0, $0), max(1, clock.duration)) }),
        in: 0...max(1, clock.duration),
        onEditingChanged: { editing in
          if editing {
            scrubPosition = clock.position
          } else if let target = scrubPosition {
            workspace.seek(target)
            scrubPosition = nil
          }
        }
      )
      .accessibilityLabel("Playback position")
      .accessibilityValue(
        "\(desktopClock(displayedPosition)) / \(desktopClock(clock.duration))"
      )
      .transaction { $0.animation = nil }
      Text(desktopClock(clock.duration))
        .frame(minWidth: 36, alignment: .leading)
    }
    .font(.caption2.monospacedDigit())
    .foregroundStyle(Brand.secondary)
  }
}

private struct DesktopVolumeButton: View {
  let workspace: DesktopWorkspace
  @ObservedObject var state: DesktopPlaybackVolumeState
  @State private var showingVolume = false

  var body: some View {
    Button {
      showingVolume.toggle()
    } label: {
      Image(systemName: desktopVolumeSymbol(state.value))
        .frame(width: 38, height: 38)
        .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .foregroundStyle(showingVolume ? Brand.accent : Brand.secondary)
    .background(showingVolume ? Brand.accent.opacity(0.12) : .clear, in: Circle())
    .accessibilityLabel("Volume")
    .accessibilityValue(
      state.value.muted
        ? Text("Muted")
        : Text(state.value.level, format: .percent.precision(.fractionLength(0)))
    )
    .accessibilityIdentifier("player_volume_button")
    .help("Adjust volume")
    .popover(isPresented: $showingVolume, arrowEdge: .top) {
      DesktopVolumeControl(workspace: workspace, state: state)
        .padding(16)
        .frame(width: 240)
        .tint(Brand.accent)
    }
  }
}

private struct DesktopVolumeControl: View {
  let workspace: DesktopWorkspace
  @ObservedObject var state: DesktopPlaybackVolumeState
  @State private var editing = false

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      HStack {
        Text("Volume")
        Spacer()
        Text(
          state.value.muted ? 0 : state.value.level, format: .percent.precision(.fractionLength(0))
        )
        .font(.caption.monospacedDigit())
        .foregroundStyle(Brand.secondary)
        .accessibilityHidden(true)
      }
      HStack(spacing: 10) {
        Button {
          workspace.toggleMute()
        } label: {
          Image(systemName: desktopVolumeSymbol(state.value))
            .frame(width: 32, height: 32)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(state.value.muted ? Brand.accent : Brand.secondary)
        .accessibilityLabel(Text(LocalizedStringKey(state.value.muted ? "Unmute" : "Mute")))
        .help(LocalizedStringKey(state.value.muted ? "Unmute" : "Mute"))
        Slider(
          value: Binding(
            get: { state.value.muted ? 0 : state.value.level },
            set: { value in
              if editing { workspace.previewVolume(value) } else { workspace.setVolume(value) }
            }),
          in: 0...1,
          onEditingChanged: { isEditing in
            editing = isEditing
            if !isEditing { workspace.commitPlaybackVolume() }
          }
        )
        .accessibilityLabel("Volume")
        .accessibilityIdentifier("player_volume_slider")
        .accessibilityValue(
          state.value.muted
            ? Text("Muted")
            : Text(state.value.level, format: .percent.precision(.fractionLength(0)))
        )
        .transaction { $0.animation = nil }
      }
    }
    .onDisappear {
      if editing { workspace.commitPlaybackVolume() }
    }
  }
}

private struct DesktopLoopControls: View {
  @ObservedObject var workspace: DesktopWorkspace
  @ObservedObject var clock: DesktopPlaybackClock

  var body: some View {
    ControlGroup {
      Button("Set loop start") { workspace.markLoopStart() }
      Button("Set loop end") { workspace.markLoopEnd() }
        .disabled(workspace.loopStart == nil || clock.position <= (workspace.loopStart ?? 0) + 0.1)
      Button("Clear loop") { workspace.clearLoop() }
        .disabled(workspace.loopStart == nil)
    }
    .controlSize(.regular)
    if let start = workspace.loopStart {
      Label(
        "\(desktopClock(start)) – \(workspace.loopEnd.map(desktopClock) ?? "…")",
        systemImage: "repeat"
      )
      .font(.caption.monospacedDigit())
      .foregroundStyle(Brand.secondary)
    }
    HStack {
      Button("Add bookmark") { workspace.addBookmark() }
      Spacer()
      Menu("Bookmarks") {
        ForEach(workspace.bookmarks, id: \.self) { value in
          Menu(desktopClock(value)) {
            Button("Go to bookmark") { workspace.seek(value) }
            Button("Remove bookmark") { workspace.removeBookmark(value) }
          }
        }
      }
      .disabled(workspace.bookmarks.isEmpty)
    }
  }
}

private struct DesktopPlayerIconButton: View {
  @Environment(\.colorScheme) private var colorScheme
  let title: LocalizedStringKey
  let systemImage: String
  var selected = false
  var prominent = false
  var accessibilityValue: LocalizedStringKey?
  var help: LocalizedStringKey?
  let action: () -> Void

  @ViewBuilder var body: some View {
    if let accessibilityValue {
      configuredButton.accessibilityValue(Text(accessibilityValue))
    } else {
      configuredButton
    }
  }

  private var configuredButton: some View {
    Button(action: action) {
      Image(systemName: systemImage)
        .font(.system(size: prominent ? 16 : 14, weight: .semibold))
        .frame(width: prominent ? 40 : 34, height: prominent ? 40 : 34)
        .foregroundStyle(prominent ? prominentForeground : selected ? Brand.accent : Brand.text)
        .background(
          prominent ? Brand.accent : selected ? Brand.accent.opacity(0.13) : Color.clear,
          in: Circle()
        )
        .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(Text(title))
    .accessibilityAddTraits(selected ? .isSelected : [])
    .help(help ?? title)
  }

  private var prominentForeground: Color { colorScheme == .dark ? .black : .white }
}

private func desktopVolumeSymbol(_ volume: DesktopPlaybackVolume) -> String {
  if volume.muted || volume.level == 0 { return "speaker.slash.fill" }
  if volume.level < 0.34 { return "speaker.wave.1.fill" }
  if volume.level < 0.67 { return "speaker.wave.2.fill" }
  return "speaker.wave.3.fill"
}

private func desktopClock(_ seconds: Double) -> String {
  let value = max(0, Int(seconds.isFinite ? seconds : 0))
  return "\(value / 60):\(String(format: "%02d", value % 60))"
}
