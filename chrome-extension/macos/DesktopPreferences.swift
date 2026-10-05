import SwiftUI

enum DesktopAppearancePreference: String, CaseIterable, Identifiable {
  case system
  case light
  case dark

  var id: String { rawValue }

  var title: String {
    switch self {
    case .system: "System"
    case .light: "Light"
    case .dark: "Dark"
    }
  }

  var colorScheme: ColorScheme? {
    switch self {
    case .system: nil
    case .light: .light
    case .dark: .dark
    }
  }
}

enum DesktopAccentPreference: String, CaseIterable, Identifiable {
  case orange
  case mint
  case blue
  case purple

  var id: String { rawValue }

  var title: String {
    switch self {
    case .orange: "Orange"
    case .mint: "Mint"
    case .blue: "Blue"
    case .purple: "Purple"
    }
  }

  var color: Color {
    switch self {
    case .orange: Color.adaptive(light: 0xC44D1B, dark: 0xFF814A)
    case .mint: Color.adaptive(light: 0x087C65, dark: 0x96E6C7)
    case .blue: Color.adaptive(light: 0x0068A0, dark: 0x8ECAFF)
    case .purple: Color.adaptive(light: 0x6F52A8, dark: 0xC5B0FF)
    }
  }
}

enum DesktopTextSizePreference: String, CaseIterable, Identifiable {
  case system
  case compact
  case small
  case standard
  case large
  case extraLarge
  case accessibility

  var id: String { rawValue }

  var title: String {
    switch self {
    case .system: "System"
    case .compact: "Compact"
    case .small: "Small"
    case .standard: "Standard"
    case .large: "Large"
    case .extraLarge: "Extra Large"
    case .accessibility: "Accessibility"
    }
  }

  var dynamicTypeSize: DynamicTypeSize? {
    switch self {
    case .system: nil
    case .compact: .small
    case .small: .medium
    case .standard: .large
    case .large: .xLarge
    case .extraLarge: .xxLarge
    case .accessibility: .accessibility1
    }
  }

  static func clamped(index: Int) -> Self {
    let adjustableCases: [Self] = [
      .compact, .small, .standard, .large, .extraLarge, .accessibility,
    ]
    let boundedIndex = min(
      max(index, adjustableCases.startIndex),
      adjustableCases.index(before: adjustableCases.endIndex))
    return adjustableCases[boundedIndex]
  }

  func increased() -> Self {
    guard self != .system else { return .large }
    let adjustableCases: [Self] = [
      .compact, .small, .standard, .large, .extraLarge, .accessibility,
    ]
    return Self.clamped(index: adjustableCases.firstIndex(of: self)! + 1)
  }

  func decreased() -> Self {
    guard self != .system else { return .small }
    let adjustableCases: [Self] = [
      .compact, .small, .standard, .large, .extraLarge, .accessibility,
    ]
    return Self.clamped(index: adjustableCases.firstIndex(of: self)! - 1)
  }
}

private struct DesktopTextSizeModifier: ViewModifier {
  let preference: DesktopTextSizePreference

  @ViewBuilder func body(content: Content) -> some View {
    if let size = preference.dynamicTypeSize {
      content.dynamicTypeSize(size)
    } else {
      content
    }
  }
}

extension View {
  func desktopTextSize(_ preference: DesktopTextSizePreference) -> some View {
    modifier(DesktopTextSizeModifier(preference: preference))
  }
}

enum DesktopAppShortcut: String, CaseIterable, Identifiable {
  case newVoice
  case home
  case library
  case account
  case setup
  case diagnostics
  case playPause
  case nextVoice
  case seekBackward
  case seekForward
  case switchVersion
  case favorite
  case toggleMute
  case volumeUp
  case volumeDown
  case stop
  case checkReadiness
  case textLarger
  case textSmaller
  case textStandard

  var id: String { rawValue }

  var title: String {
    switch self {
    case .newVoice: "New Voice"
    case .home: "Go to Home"
    case .library: "Go to Library"
    case .account: "Go to Account"
    case .setup: "Go to Setup"
    case .diagnostics: "Go to Diagnostics"
    case .playPause: "Play or Pause"
    case .nextVoice: "Next Voice"
    case .seekBackward: "Back 10 Seconds"
    case .seekForward: "Forward 10 Seconds"
    case .switchVersion: "Switch Voice and Original"
    case .favorite: "Toggle Favorite Current Voice"
    case .toggleMute: "Mute or Unmute"
    case .volumeUp: "Increase Volume"
    case .volumeDown: "Decrease Volume"
    case .stop: "Stop Playback"
    case .checkReadiness: "Check Mac Readiness"
    case .textLarger: "Make Text Larger"
    case .textSmaller: "Make Text Smaller"
    case .textStandard: "Reset Text Size"
    }
  }

  var key: KeyEquivalent {
    switch self {
    case .newVoice: "n"
    case .home: "1"
    case .library: "2"
    case .account: "3"
    case .setup: "4"
    case .diagnostics: "5"
    case .playPause: "p"
    case .nextVoice: .rightArrow
    case .seekBackward: "["
    case .seekForward: "]"
    case .switchVersion: "v"
    case .favorite: "f"
    case .toggleMute: "m"
    case .volumeUp: .upArrow
    case .volumeDown: .downArrow
    case .stop: "."
    case .checkReadiness: "r"
    case .textLarger: "+"
    case .textSmaller: "-"
    case .textStandard: "0"
    }
  }

  var modifiers: EventModifiers {
    switch self {
    case .playPause, .switchVersion, .favorite, .toggleMute, .checkReadiness:
      [.command, .shift]
    case .nextVoice, .volumeUp, .volumeDown:
      [.command, .option]
    default:
      .command
    }
  }

  var display: String {
    let modifierSymbols = modifiers.contains(.control) ? "⌃" : ""
    let optionSymbols = modifiers.contains(.option) ? "⌥" : ""
    let shiftSymbols = modifiers.contains(.shift) ? "⇧" : ""
    let commandSymbols = modifiers.contains(.command) ? "⌘" : ""
    let keyLabel =
      switch self {
      case .nextVoice: "→"
      case .volumeUp: "↑"
      case .volumeDown: "↓"
      default: String(key.character).uppercased()
      }
    return modifierSymbols + optionSymbols + shiftSymbols + commandSymbols + keyLabel
  }

  var chordIdentifier: String {
    "\(modifiers.rawValue):\(key.character)"
  }
}

enum DesktopImportSourcePreference: String, CaseIterable, Identifiable {
  case youtube
  case file

  var id: String { rawValue }

  var title: String {
    switch self {
    case .youtube: "YouTube"
    case .file: "Audio file"
    }
  }
}

enum DesktopProcessingPreference: String, CaseIterable, Identifiable {
  case local
  case cloud

  var id: String { rawValue }

  var title: String {
    switch self {
    case .local: "On this Mac"
    case .cloud: "MusicMute cloud"
    }
  }
}

enum DesktopPreferenceKey {
  static let appearance = "desktop.appearance"
  static let accent = "desktop.accent"
  static let textSize = "desktop.textSize"
  static let language = "desktop.language"
  static let importSource = "desktop.importSource"
  static let processingMode = "desktop.processingMode"
  static let expandPlayer = "desktop.expandPlayer"
  static let playbackVolume = "desktop.playbackVolume"
  static let playbackMuted = "desktop.playbackMuted"
  static let playbackLastAudibleVolume = "desktop.playbackLastAudibleVolume"
  static let restoreLastPage = "desktop.restoreLastPage"
  static let lastPage = "desktop.lastPage"
}

enum DesktopPreferenceNormalizer {
  static func normalize<Value>(_ rawValue: String, fallback: Value) -> Value
  where Value: RawRepresentable, Value.RawValue == String {
    Value(rawValue: rawValue) ?? fallback
  }
}

enum DesktopLanguagePreference: String, CaseIterable, Identifiable {
  case system
  case english = "en"
  case arabic = "ar"

  var id: String { rawValue }

  var title: String {
    switch self {
    case .system: "System"
    case .english: "English"
    case .arabic: "Arabic — العربية"
    }
  }
}

@MainActor final class DesktopVisualPreferences: ObservableObject {
  private let defaults: UserDefaults

  @Published var appearance: DesktopAppearancePreference {
    didSet { persist(appearance, oldValue: oldValue, key: DesktopPreferenceKey.appearance) }
  }
  @Published var accent: DesktopAccentPreference {
    didSet { persist(accent, oldValue: oldValue, key: DesktopPreferenceKey.accent) }
  }
  @Published var textSize: DesktopTextSizePreference {
    didSet { persist(textSize, oldValue: oldValue, key: DesktopPreferenceKey.textSize) }
  }
  @Published var language: DesktopLanguagePreference {
    didSet { persist(language, oldValue: oldValue, key: DesktopPreferenceKey.language) }
  }

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    appearance = Self.load(
      DesktopAppearancePreference.self, key: DesktopPreferenceKey.appearance, fallback: .system,
      defaults: defaults)
    accent = Self.load(
      DesktopAccentPreference.self, key: DesktopPreferenceKey.accent, fallback: .orange,
      defaults: defaults)
    textSize = Self.load(
      DesktopTextSizePreference.self, key: DesktopPreferenceKey.textSize, fallback: .system,
      defaults: defaults)
    language = Self.load(
      DesktopLanguagePreference.self, key: DesktopPreferenceKey.language, fallback: .system,
      defaults: defaults)
  }

  private func persist<Value: RawRepresentable & Equatable>(
    _ value: Value, oldValue: Value, key: String
  ) where Value.RawValue == String {
    guard value != oldValue else { return }
    defaults.set(value.rawValue, forKey: key)
  }

  private static func load<Value: RawRepresentable>(
    _ type: Value.Type, key: String, fallback: Value, defaults: UserDefaults
  ) -> Value where Value.RawValue == String {
    guard let rawValue = defaults.string(forKey: key) else { return fallback }
    guard let value = Value(rawValue: rawValue) else {
      defaults.set(fallback.rawValue, forKey: key)
      return fallback
    }
    return value
  }
}

struct DesktopPreferencesView: View {
  let workspace: DesktopWorkspace
  @ObservedObject var visualPreferences: DesktopVisualPreferences
  @Environment(\.colorScheme) private var colorScheme
  @AppStorage(DesktopPreferenceKey.importSource) private var importSourceRaw =
    DesktopImportSourcePreference.youtube.rawValue
  @AppStorage(DesktopPreferenceKey.processingMode) private var processingModeRaw =
    DesktopProcessingPreference.local.rawValue
  @AppStorage(DesktopPreferenceKey.expandPlayer) private var autoExpandPlayer = false
  @AppStorage(DesktopPreferenceKey.restoreLastPage) private var restoreLastPage = true

  private var appearance: Binding<DesktopAppearancePreference> {
    $visualPreferences.appearance
  }

  private var accent: Binding<DesktopAccentPreference> {
    $visualPreferences.accent
  }

  private var textSize: Binding<DesktopTextSizePreference> {
    $visualPreferences.textSize
  }

  private var language: Binding<DesktopLanguagePreference> {
    $visualPreferences.language
  }

  private var importSource: Binding<DesktopImportSourcePreference> {
    Binding(
      get: {
        DesktopPreferenceNormalizer.normalize(importSourceRaw, fallback: .youtube)
      },
      set: { importSourceRaw = $0.rawValue })
  }

  private var processingMode: Binding<DesktopProcessingPreference> {
    Binding(
      get: {
        DesktopPreferenceNormalizer.normalize(processingModeRaw, fallback: .local)
      },
      set: { processingModeRaw = $0.rawValue })
  }

  var body: some View {
    Form {
      Section("Theme") {
        themePreview

        VStack(alignment: .leading, spacing: 10) {
          Text("Appearance")
            .font(.callout.weight(.semibold))
          HStack(spacing: 10) {
            ForEach(DesktopAppearancePreference.allCases) { option in
              appearanceButton(option)
            }
          }
        }
        .accessibilityIdentifier("desktopPreferences.appearance")

        VStack(alignment: .leading, spacing: 10) {
          Text("Accent color")
            .font(.callout.weight(.semibold))
          HStack(spacing: 14) {
            ForEach(DesktopAccentPreference.allCases) { option in
              accentButton(option)
            }
          }
        }
        .accessibilityIdentifier("desktopPreferences.accent")

        VStack(alignment: .leading, spacing: 10) {
          HStack {
            Text("Text size")
              .font(.callout.weight(.semibold))
            Spacer()
            Text(LocalizedStringKey(textSize.wrappedValue.title))
              .foregroundStyle(.secondary)
          }
          ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
              decreaseTextButton
              increaseTextButton
              Spacer()
              resetTextButton
            }
            VStack(alignment: .leading, spacing: 8) {
              HStack(spacing: 8) {
                decreaseTextButton
                increaseTextButton
              }
              resetTextButton
            }
          }
        }
        .accessibilityIdentifier("desktopPreferences.textSize")

        Text("System follows your Mac appearance. Text size applies throughout MusicMute.")
          .font(.footnote)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      Section("Language") {
        Picker("Language", selection: language) {
          ForEach(DesktopLanguagePreference.allCases) { option in
            Text(LocalizedStringKey(option.title)).tag(option)
          }
        }
        .accessibilityIdentifier("desktopPreferences.language")

        Text("System follows your Mac language setting.")
          .font(.footnote)
          .foregroundStyle(.secondary)
      }

      Section("New imports") {
        Picker("Default source", selection: importSource) {
          ForEach(DesktopImportSourcePreference.allCases) { option in
            Text(LocalizedStringKey(option.title)).tag(option)
          }
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("desktopPreferences.importSource")

        Picker("Process with", selection: processingMode) {
          ForEach(DesktopProcessingPreference.allCases) { option in
            Text(LocalizedStringKey(option.title)).tag(option)
          }
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("desktopPreferences.processingMode")

        Text(
          "On this Mac keeps processing local. MusicMute cloud is used only after you start an import."
        )
        .font(.footnote)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      }

      Section("Playback and navigation") {
        Toggle("Expand player controls when playback starts", isOn: $autoExpandPlayer)
          .accessibilityIdentifier("desktopPreferences.expandPlayer")

        Toggle("Restore the last section when MusicMute opens", isOn: $restoreLastPage)
          .accessibilityIdentifier("desktopPreferences.restoreLastPage")
      }

      Section("Keyboard Shortcuts") {
        Text("Use these shortcuts anywhere in MusicMute. They avoid standard typing commands.")
          .font(.footnote)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)

        LazyVGrid(
          columns: [GridItem(.adaptive(minimum: 210), alignment: .leading)], spacing: 8
        ) {
          ForEach(DesktopAppShortcut.allCases) { shortcut in
            HStack(spacing: 10) {
              Text(LocalizedStringKey(shortcut.title))
                .lineLimit(2)
              Spacer(minLength: 8)
              Text(shortcut.display)
                .font(.caption.monospaced().weight(.semibold))
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
                .accessibilityLabel(shortcut.display)
            }
          }
        }
        .accessibilityIdentifier("desktopPreferences.keyboardShortcuts")
      }

      DesktopStoragePreferencesSection(workspace: workspace)

      Section {
        Text(
          "These preferences stay on this Mac. Changing a default does not upload media or start processing."
        )
        .font(.footnote)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      }
    }
    .formStyle(.grouped)
    .controlSize(.regular)
    .frame(minWidth: 560, idealWidth: 640, minHeight: 540)
    .accessibilityIdentifier("desktopPreferences.form")
    .onAppear(perform: repairMalformedOperationalPreferences)
  }

  private func repairMalformedOperationalPreferences() {
    if DesktopImportSourcePreference(rawValue: importSourceRaw) == nil {
      importSourceRaw = DesktopImportSourcePreference.youtube.rawValue
    }
    if DesktopProcessingPreference(rawValue: processingModeRaw) == nil {
      processingModeRaw = DesktopProcessingPreference.local.rawValue
    }
  }

  private var themePreview: some View {
    HStack(spacing: 14) {
      ZStack {
        RoundedRectangle(cornerRadius: 12)
          .fill(accent.wrappedValue.color.opacity(0.16))
        Image(systemName: "waveform")
          .font(.title2.weight(.semibold))
          .foregroundStyle(accent.wrappedValue.color)
      }
      .frame(width: 52, height: 52)

      VStack(alignment: .leading, spacing: 4) {
        Text("MusicMute")
          .font(.headline)
        Text("Voice ready")
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }

      Spacer()

      Image(systemName: "play.fill")
        .font(.headline)
        .foregroundStyle(accentForeground)
        .frame(width: 36, height: 36)
        .background(accent.wrappedValue.color, in: Circle())
    }
    .padding(16)
    .background(Brand.raised, in: RoundedRectangle(cornerRadius: 16))
    .overlay {
      RoundedRectangle(cornerRadius: 16)
        .stroke(Brand.border, lineWidth: 1)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Theme preview")
  }

  private var decreaseTextButton: some View {
    Button {
      textSize.wrappedValue = textSize.wrappedValue.decreased()
    } label: {
      Label("Make Text Smaller", systemImage: "textformat.size.smaller")
    }
    .buttonStyle(.bordered)
    .disabled(textSize.wrappedValue == .compact)
  }

  private var increaseTextButton: some View {
    Button {
      textSize.wrappedValue = textSize.wrappedValue.increased()
    } label: {
      Label("Make Text Larger", systemImage: "textformat.size.larger")
    }
    .buttonStyle(.bordered)
    .disabled(textSize.wrappedValue == .accessibility)
  }

  private var resetTextButton: some View {
    Button("Reset to System") {
      textSize.wrappedValue = .system
    }
    .buttonStyle(.bordered)
    .disabled(textSize.wrappedValue == .system)
  }

  private func appearanceButton(_ option: DesktopAppearancePreference) -> some View {
    let selected = appearance.wrappedValue == option
    return Button {
      if appearance.wrappedValue != option { appearance.wrappedValue = option }
    } label: {
      VStack(spacing: 7) {
        Image(systemName: appearanceSymbol(option))
          .font(.title3)
        Text(LocalizedStringKey(option.title))
          .font(.caption.weight(.medium))
      }
      .frame(maxWidth: .infinity, minHeight: 58)
      .background(selected ? accent.wrappedValue.color.opacity(0.14) : Color.clear)
      .overlay {
        RoundedRectangle(cornerRadius: 10)
          .stroke(selected ? accent.wrappedValue.color : Brand.border, lineWidth: selected ? 2 : 1)
      }
      .clipShape(RoundedRectangle(cornerRadius: 10))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(LocalizedStringKey(option.title))
    .accessibilityAddTraits(selected ? .isSelected : [])
  }

  private func appearanceSymbol(_ option: DesktopAppearancePreference) -> String {
    switch option {
    case .system: "circle.lefthalf.filled"
    case .light: "sun.max.fill"
    case .dark: "moon.stars.fill"
    }
  }

  private func accentButton(_ option: DesktopAccentPreference) -> some View {
    let selected = accent.wrappedValue == option
    return Button {
      if accent.wrappedValue != option { accent.wrappedValue = option }
    } label: {
      VStack(spacing: 6) {
        ZStack {
          Circle()
            .fill(option.color)
            .frame(width: 28, height: 28)
          if selected {
            Image(systemName: "checkmark")
              .font(.caption.bold())
              .foregroundStyle(accentForeground)
          }
        }
        Text(LocalizedStringKey(option.title))
          .font(.caption2)
          .foregroundStyle(.primary)
      }
      .frame(minWidth: 54)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(LocalizedStringKey(option.title))
    .accessibilityAddTraits(selected ? .isSelected : [])
  }

  private var accentForeground: Color {
    colorScheme == .dark ? .black : .white
  }
}

private struct DesktopStoragePreferencesSection: View {
  @ObservedObject var workspace: DesktopWorkspace
  @State private var confirmClearOfflineVoices = false
  @State private var storageGigabytes = "2"
  @State private var loadingStorage = false
  @State private var storageLoadFailed = false

  private var storageBusy: Bool {
    loadingStorage || workspace.processing || workspace.clearingCache || workspace.savingCacheBudget
  }

  var body: some View {
    Section("Storage") {
      LabeledContent("Offline voices") {
        Text("\(bytesLabel(workspace.cacheBytes)) of \(bytesLabel(workspace.budgetBytes))")
          .foregroundStyle(.secondary)
      }
      if loadingStorage {
        ProgressView().controlSize(.small)
      } else if storageLoadFailed {
        Text(
          "The saved storage limit could not be read. Finish the current MusicMute operation, then reopen Settings."
        )
        .font(.footnote)
        .foregroundStyle(.secondary)
      }

      LabeledContent("Offline voice storage limit") {
        HStack {
          TextField("GB", text: $storageGigabytes)
            .textFieldStyle(.roundedBorder)
            .frame(width: 110)
            .disabled(storageBusy)
            .accessibilityLabel("Offline voice storage limit in GB")
            .accessibilityIdentifier("desktopPreferences.offlineStorageLimit")
          Text("GB").foregroundStyle(.secondary)
        }
      }

      HStack {
        Button("Save Storage Limit") {
          Task { await workspace.saveOfflineStorageLimit(gigabytes: storageGigabytes) }
        }
        .disabled(
          storageBusy || DesktopOfflineStoragePolicy.bytes(gigabytes: storageGigabytes) == nil
            || DesktopOfflineStoragePolicy.bytes(gigabytes: storageGigabytes)
              == workspace.budgetBytes
        )
        .accessibilityIdentifier("desktopPreferences.saveOfflineStorageLimit")
        Button("Use Default (2 GB)") {
          storageGigabytes = "2"
          Task { await workspace.saveOfflineStorageLimit(gigabytes: "2") }
        }
        .disabled(storageBusy || workspace.budgetBytes == DesktopOfflineStoragePolicy.defaultBytes)
        .accessibilityIdentifier("desktopPreferences.defaultOfflineStorageLimit")
        if workspace.savingCacheBudget { ProgressView().controlSize(.small) }
      }

      Text(
        "Choose a whole number of GB, starting at 1. The default is 2 GB, shared with the Chrome extension. Lowering the limit removes older unused voices only when space is next needed; active playback and pending account saves stay protected."
      )
      .font(.footnote)
      .foregroundStyle(.secondary)
      .fixedSize(horizontal: false, vertical: true)

      if DesktopOfflineStoragePolicy.bytes(gigabytes: storageGigabytes) == nil {
        Text("Enter a whole number of GB, starting at 1.")
          .font(.footnote)
          .foregroundStyle(.secondary)
      }
      if let status = workspace.cacheBudgetStatus {
        Label(
          LocalizedStringKey(status),
          systemImage: workspace.savingCacheBudget ? "hourglass" : "info.circle"
        )
        .font(.footnote)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("desktopPreferences.offlineStorageStatus")
      }

      HStack {
        Button("Clear Offline Voices…", role: .destructive) {
          confirmClearOfflineVoices = true
        }
        .disabled(storageBusy)
        .accessibilityIdentifier("desktopPreferences.clearOfflineVoices")
        if workspace.clearingCache { ProgressView().controlSize(.small) }
      }

      Text(
        "Clearing stops current MusicMute playback, then removes eligible voice copies from this Mac. Other voices pinned by extension playback or pending account saves stay protected."
      )
      .font(.footnote)
      .foregroundStyle(.secondary)
      .fixedSize(horizontal: false, vertical: true)

      if let status = workspace.cacheClearStatus {
        Label(status, systemImage: workspace.clearingCache ? "hourglass" : "info.circle")
          .font(.footnote)
          .foregroundStyle(.secondary)
      }
    }
    .onAppear { storageGigabytes = DesktopOfflineStoragePolicy.gigabytes(workspace.budgetBytes) }
    .task {
      loadingStorage = true
      defer { loadingStorage = false }
      storageLoadFailed = !(await workspace.loadCache())
      storageGigabytes = DesktopOfflineStoragePolicy.gigabytes(workspace.budgetBytes)
    }
    .onChange(of: workspace.budgetBytes) { _, bytes in
      storageGigabytes = DesktopOfflineStoragePolicy.gigabytes(bytes)
    }
    .confirmationDialog(
      "Clear eligible offline voices from this Mac?",
      isPresented: $confirmClearOfflineVoices
    ) {
      Button("Clear Offline Voices", role: .destructive) {
        Task { await workspace.clearOfflineVoices() }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(
        "Current MusicMute playback stops first. Only other voice data pinned by active extension playback or pending account saves stays protected. Account media, models, and diagnostics are not part of this cache."
      )
    }
  }
}
