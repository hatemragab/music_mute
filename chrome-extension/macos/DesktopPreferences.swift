import AppKit
import CoreText
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

  var fontScale: CGFloat {
    switch self {
    case .system, .standard: 1
    case .compact: 0.85
    case .small: 0.92
    case .large: 1.15
    case .extraLarge: 1.3
    case .accessibility: 1.55
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

private struct DesktopTextScaleKey: EnvironmentKey {
  static let defaultValue: CGFloat = 1
}

extension EnvironmentValues {
  var desktopTextScale: CGFloat {
    get { self[DesktopTextScaleKey.self] }
    set { self[DesktopTextScaleKey.self] = newValue }
  }
}

private struct DesktopTextSizeModifier: ViewModifier {
  let preference: DesktopTextSizePreference
  @Environment(\.dynamicTypeSize) private var inheritedSize

  func body(content: Content) -> some View {
    content
      .dynamicTypeSize(preference.dynamicTypeSize ?? inheritedSize)
      .environment(\.desktopTextScale, preference.fontScale)
      .font(DesktopTypography.font(.body, scale: preference.fontScale))
      .controlSize(.large)
  }
}

/// One readable type scale for every Mac screen, using Android's bundled font.
enum DesktopTypography {
  static let family = "Noto Sans Arabic"
  static let postScriptName = "NotoSansArabic-Regular"

  @discardableResult static func registerFont(resources: URL?) -> Bool {
    guard let resources else { return false }
    let file = resources.appendingPathComponent("Fonts/NotoSansArabic.ttf")
    guard FileManager.default.fileExists(atPath: file.path) else { return false }
    _ = CTFontManagerRegisterFontsForURL(file as CFURL, .process, nil)
    return NSFont(name: postScriptName, size: 17)?.familyName == family
  }

  static func baseSize(_ style: Font.TextStyle) -> CGFloat {
    switch style {
    case .largeTitle: 34
    case .title: 28
    case .title2: 24
    case .title3: 21
    case .headline: 18
    case .body: 17
    case .callout: 16
    case .subheadline: 16
    case .footnote: 15
    case .caption: 14
    case .caption2: 13
    default: 17
    }
  }

  static func pointSize(_ style: Font.TextStyle, scale: CGFloat) -> CGFloat {
    let systemScale = NSFont.preferredFont(forTextStyle: .body).pointSize / NSFont.systemFontSize
    return max(13, baseSize(style) * scale * systemScale)
  }

  static func nativeFont(
    _ style: Font.TextStyle, scale: CGFloat = 1, weight: Font.Weight? = nil,
    design: Font.Design = .default
  ) -> NSFont {
    let size = pointSize(style, scale: scale)
    let selected = weight ?? (style == .headline ? .semibold : .regular)
    if design == .monospaced {
      return NSFont.monospacedSystemFont(ofSize: size, weight: nativeWeight(selected))
    }
    let suffix: String
    switch selected {
    case .ultraLight: suffix = "_Thin"
    case .thin: suffix = "_ExtraLight"
    case .light: suffix = "_Light"
    case .medium: suffix = "_Medium"
    case .semibold: suffix = "_SemiBold"
    case .bold: suffix = "_Bold"
    case .heavy: suffix = "_ExtraBold"
    case .black: suffix = "_Black"
    default: suffix = ""
    }
    return NSFont(name: postScriptName + suffix, size: size)
      ?? NSFont.systemFont(ofSize: size, weight: nativeWeight(selected))
  }

  private static func nativeWeight(_ weight: Font.Weight) -> NSFont.Weight {
    switch weight {
    case .ultraLight: .ultraLight
    case .thin: .thin
    case .light: .light
    case .medium: .medium
    case .semibold: .semibold
    case .bold: .bold
    case .heavy: .heavy
    case .black: .black
    default: .regular
    }
  }

  static func font(
    _ style: Font.TextStyle, scale: CGFloat, weight: Font.Weight? = nil,
    design: Font.Design = .default
  ) -> Font {
    Font(nativeFont(style, scale: scale, weight: weight, design: design))
  }
}

private struct DesktopSemanticFontModifier: ViewModifier {
  let style: Font.TextStyle
  let weight: Font.Weight?
  let design: Font.Design
  let monospacedDigits: Bool
  @Environment(\.desktopTextScale) private var scale

  func body(content: Content) -> some View {
    let font = DesktopTypography.font(style, scale: scale, weight: weight, design: design)
    content.font(monospacedDigits ? font.monospacedDigit() : font)
  }
}

extension View {
  func desktopTextSize(_ preference: DesktopTextSizePreference) -> some View {
    modifier(DesktopTextSizeModifier(preference: preference))
  }

  func desktopFont(
    _ style: Font.TextStyle, weight: Font.Weight? = nil, design: Font.Design = .default,
    monospacedDigits: Bool = false
  ) -> some View {
    modifier(
      DesktopSemanticFontModifier(
        style: style, weight: weight, design: design, monospacedDigits: monospacedDigits))
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

enum DesktopProcessingAccess {
  static func resolved(
    _ requested: DesktopProcessingPreference, signedIn: Bool
  ) -> DesktopProcessingPreference {
    requested == .cloud && !signedIn ? .local : requested
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

enum DesktopSettingsSection: String, CaseIterable, Identifiable {
  case appearance, general, storage, shortcuts, updates

  var id: String { rawValue }
  var title: String {
    switch self {
    case .appearance: "Appearance"
    case .general: "General"
    case .storage: "Storage"
    case .shortcuts: "Shortcuts"
    case .updates: "App updates"
    }
  }
  var symbol: String {
    switch self {
    case .appearance: "paintpalette"
    case .general: "gearshape"
    case .storage: "externaldrive"
    case .shortcuts: "keyboard"
    case .updates: "arrow.triangle.2.circlepath"
    }
  }
}

struct DesktopPreferencesView: View {
  let workspace: DesktopWorkspace
  @ObservedObject var visualPreferences: DesktopVisualPreferences
  @ObservedObject var updater: DesktopUpdater
  @ObservedObject private var account: DesktopAccountModel
  let isPreview: Bool
  let openAccount: () -> Void
  @State private var section: DesktopSettingsSection
  @StateObject private var storageState: DesktopStoragePreferencesState
  @State private var cloudSignInRequired = false
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @AppStorage(DesktopPreferenceKey.importSource) private var importSourceRaw =
    DesktopImportSourcePreference.youtube.rawValue
  @AppStorage(DesktopPreferenceKey.processingMode) private var processingModeRaw =
    DesktopProcessingPreference.local.rawValue
  @AppStorage(DesktopPreferenceKey.expandPlayer) private var autoExpandPlayer = false
  @AppStorage(DesktopPreferenceKey.restoreLastPage) private var restoreLastPage = true

  init(
    workspace: DesktopWorkspace, visualPreferences: DesktopVisualPreferences,
    updater: DesktopUpdater, isPreview: Bool = false,
    initialSection: DesktopSettingsSection = .appearance, openAccount: @escaping () -> Void = {}
  ) {
    self.workspace = workspace
    self.visualPreferences = visualPreferences
    self.updater = updater
    self.isPreview = isPreview
    self.openAccount = openAccount
    _account = ObservedObject(wrappedValue: workspace.account)
    _section = State(initialValue: initialSection)
    _storageState = StateObject(
      wrappedValue: DesktopStoragePreferencesState(workspace: workspace, isPreview: isPreview))
  }

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
        DesktopProcessingAccess.resolved(
          DesktopPreferenceNormalizer.normalize(processingModeRaw, fallback: .local),
          signedIn: account.signedIn)
      },
      set: { requested in
        let resolved = DesktopProcessingAccess.resolved(requested, signedIn: account.signedIn)
        processingModeRaw = resolved.rawValue
        cloudSignInRequired = requested == .cloud && resolved == .local
      })
  }

  var body: some View {
    TabView(selection: $section) {
      settingsPane(.appearance) { appearanceSettings }
      settingsPane(.general) { generalSettings }
      settingsPane(.storage) {
        DesktopStoragePreferencesSection(workspace: workspace, state: storageState)
      }
      .task { await storageState.loadIfNeeded() }
      settingsPane(.shortcuts) { shortcutSettings }
      settingsPane(.updates) {
        DesktopUpdatesPreferencesSection(updater: updater, isPreview: isPreview)
      }
    }
    .padding(.top, 8)
    .frame(minWidth: 600, idealWidth: 700, minHeight: 580, idealHeight: 660)
    .accessibilityIdentifier("desktopPreferences.form")
    .onAppear(perform: repairMalformedOperationalPreferences)
    .onChange(of: account.signedIn) { _, signedIn in
      if signedIn {
        cloudSignInRequired = false
      } else {
        processingModeRaw = DesktopProcessingPreference.local.rawValue
      }
    }
  }

  private func settingsPane<Content: View>(
    _ section: DesktopSettingsSection, @ViewBuilder content: () -> Content
  ) -> some View {
    Form { content() }
      .formStyle(.grouped)
      .controlSize(.large)
      .tabItem { Label(LocalizedStringKey(section.title), systemImage: section.symbol) }
      .tag(section)
      .accessibilityIdentifier("desktopPreferences.pane.\(section.rawValue)")
  }

  private var appearanceSettings: some View {
    Section("Theme") {
      themePreview

      VStack(alignment: .leading, spacing: 10) {
        Text("Appearance")
          .desktopFont(.callout, weight: .semibold)
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 10) {
            ForEach(DesktopAppearancePreference.allCases) { option in
              appearanceButton(option)
            }
          }
          VStack(spacing: 8) {
            ForEach(DesktopAppearancePreference.allCases) { option in
              appearanceButton(option)
            }
          }
        }
      }
      .accessibilityIdentifier("desktopPreferences.appearance")

      VStack(alignment: .leading, spacing: 10) {
        Text("Accent color")
          .desktopFont(.callout, weight: .semibold)
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 86), alignment: .leading)], spacing: 10) {
          ForEach(DesktopAccentPreference.allCases) { option in
            accentButton(option)
          }
        }
      }
      .accessibilityIdentifier("desktopPreferences.accent")

      VStack(alignment: .leading, spacing: 10) {
        HStack {
          Text("Text size")
            .desktopFont(.callout, weight: .semibold)
          Spacer()
          Text(LocalizedStringKey(textSize.wrappedValue.title))
            .foregroundStyle(Brand.secondary)
        }
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 8) {
            decreaseTextButton
            increaseTextButton
            Spacer()
            resetTextButton
          }
          VStack(alignment: .leading, spacing: 8) {
            decreaseTextButton
            increaseTextButton
            resetTextButton
          }
        }
      }
      .accessibilityIdentifier("desktopPreferences.textSize")

      Text("System follows your Mac appearance. Adjust text size for easier reading.")
        .desktopFont(.footnote)
        .foregroundStyle(Brand.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }

  }

  private var generalSettings: some View {
    Group {
      Section("Language") {
        Picker("Language", selection: language) {
          ForEach(DesktopLanguagePreference.allCases) { option in
            Text(LocalizedStringKey(option.title)).tag(option)
          }
        }
        .accessibilityIdentifier("desktopPreferences.language")

        Text("System follows your Mac language setting.")
          .desktopFont(.footnote)
          .foregroundStyle(Brand.secondary)
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

        if cloudSignInRequired {
          VStack(alignment: .leading, spacing: 8) {
            Label(
              "Sign in to use MusicMute cloud. On this Mac remains selected.",
              systemImage: "exclamationmark.circle"
            )
            .desktopFont(.footnote, weight: .medium)
            .foregroundStyle(Brand.amber)
            .fixedSize(horizontal: false, vertical: true)

            Button("Open Account", action: openAccount)
              .buttonStyle(.bordered)
          }
          .accessibilityElement(children: .contain)
          .accessibilityIdentifier("desktopPreferences.cloudSignInRequired")
        }

        Text(
          "On this Mac keeps processing local. MusicMute cloud is used only after you start an import."
        )
        .desktopFont(.footnote)
        .foregroundStyle(Brand.secondary)
        .fixedSize(horizontal: false, vertical: true)
      }

      Section("Playback and navigation") {
        Toggle("Expand player controls when playback starts", isOn: $autoExpandPlayer)
          .accessibilityIdentifier("desktopPreferences.expandPlayer")

        Toggle("Restore the last section when MusicMute opens", isOn: $restoreLastPage)
          .accessibilityIdentifier("desktopPreferences.restoreLastPage")
      }

      Section {
        Text(
          "These preferences stay on this Mac. Changing a default does not upload media or start processing."
        )
        .desktopFont(.footnote)
        .foregroundStyle(Brand.secondary)
        .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private var shortcutSettings: some View {
    Section("Keyboard Shortcuts") {
      Text("Use these shortcuts anywhere in MusicMute. They avoid standard typing commands.")
        .desktopFont(.footnote)
        .foregroundStyle(Brand.secondary)
        .fixedSize(horizontal: false, vertical: true)

      LazyVGrid(
        columns: [GridItem(.adaptive(minimum: 210), alignment: .leading)], spacing: 8
      ) {
        ForEach(DesktopAppShortcut.allCases) { shortcut in
          HStack(spacing: 10) {
            Text(LocalizedStringKey(shortcut.title))
              .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            Text(shortcut.display)
              .desktopFont(.caption, weight: .semibold, design: .monospaced)
              .padding(.horizontal, 8)
              .padding(.vertical, 4)
              .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
              .accessibilityLabel(shortcut.display)
          }
        }
      }
      .accessibilityIdentifier("desktopPreferences.keyboardShortcuts")
    }

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
          .desktopFont(.title2, weight: .semibold)
          .foregroundStyle(accent.wrappedValue.color)
      }
      .frame(width: 40, height: 40)

      VStack(alignment: .leading, spacing: 4) {
        Text("MusicMute")
          .desktopFont(.headline)
        Text("Voice ready")
          .desktopFont(.subheadline)
          .foregroundStyle(Brand.secondary)
      }

      Spacer()

      Text("Aa")
        .desktopFont(.title2, weight: .semibold)
        .foregroundStyle(accent.wrappedValue.color)
        .accessibilityHidden(true)
    }
    .padding(12)
    .background(Brand.raised, in: RoundedRectangle(cornerRadius: 12))
    .overlay {
      RoundedRectangle(cornerRadius: 12)
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
          .desktopFont(.title3)
        Text(LocalizedStringKey(option.title))
          .desktopFont(.caption, weight: .medium)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .frame(maxWidth: .infinity, minHeight: 58)
      .fixedSize(horizontal: false, vertical: true)
      .background(selected ? accent.wrappedValue.color.opacity(0.14) : Color.clear)
      .overlay {
        RoundedRectangle(cornerRadius: 10)
          .stroke(selected ? accent.wrappedValue.color : Brand.border, lineWidth: selected ? 2 : 1)
      }
      .clipShape(RoundedRectangle(cornerRadius: 10))
      .overlay(alignment: .topTrailing) {
        Image(systemName: "checkmark.circle.fill")
          .desktopFont(.caption)
          .foregroundStyle(accent.wrappedValue.color)
          .opacity(selected ? 1 : 0)
          .padding(6)
          .accessibilityHidden(true)
      }
      .contentShape(RoundedRectangle(cornerRadius: 10))
      .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: selected)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(LocalizedStringKey(option.title))
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier("desktopPreferences.appearance.\(option.rawValue)")
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
              .desktopFont(.caption, weight: .bold)
              .foregroundStyle(accentForeground)
          }
        }
        Text(LocalizedStringKey(option.title))
          .desktopFont(.caption2)
          .foregroundStyle(.primary)
      }
      .frame(maxWidth: .infinity, minHeight: 56)
      .padding(6)
      .background(
        selected ? accent.wrappedValue.color.opacity(0.12) : .clear,
        in: RoundedRectangle(cornerRadius: 10)
      )
      .contentShape(RoundedRectangle(cornerRadius: 10))
      .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: selected)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(LocalizedStringKey(option.title))
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier("desktopPreferences.accent.\(option.rawValue)")
  }

  private var accentForeground: Color {
    colorScheme == .dark ? .black : .white
  }
}

private struct DesktopUpdatesPreferencesSection: View {
  @ObservedObject var updater: DesktopUpdater
  let isPreview: Bool

  var body: some View {
    Section("App updates") {
      Toggle("Automatically check for updates", isOn: $updater.automaticChecksEnabled)
        .disabled(!updater.canConfigureAutomaticChecks || isPreview)
        .accessibilityIdentifier("desktopPreferences.automaticUpdates")
      Label(
        LocalizedStringKey(updater.status),
        systemImage: updater.configured ? "info.circle" : "info.circle.fill"
      )
      .desktopFont(.callout)
      .foregroundStyle(Brand.secondary)
      .fixedSize(horizontal: false, vertical: true)
      Button("Check for Updates…") { updater.checkForUpdates() }
        .disabled(!updater.canCheck || isPreview)
        .accessibilityIdentifier("desktopPreferences.checkForUpdates")
    }
  }
}

struct DesktopStorageLimitDraft {
  var text = ""
  private(set) var referenceBytes: Int64?

  var hasChanges: Bool {
    guard let referenceBytes else { return !text.isEmpty }
    return DesktopOfflineStoragePolicy.bytes(gigabytes: text) != referenceBytes
  }

  mutating func receive(bytes: Int64, replaceEdits: Bool = false) {
    let preserve = referenceBytes != nil && hasChanges && !replaceEdits
    if !preserve { text = DesktopOfflineStoragePolicy.gigabytes(bytes) }
    referenceBytes = bytes
  }
}

@MainActor final class DesktopStoragePreferencesState: ObservableObject {
  @Published var draft = DesktopStorageLimitDraft()
  @Published private(set) var loadingStorage = false
  @Published private(set) var storageLoadFailed = false
  @Published private(set) var hasLoadedStorage = false
  let isPreview: Bool
  private let workspace: DesktopWorkspace
  private let loadCache: @MainActor () async -> Bool
  private var attemptedInitialLoad = false

  init(
    workspace: DesktopWorkspace, isPreview: Bool = false,
    loadCache: (@MainActor () async -> Bool)? = nil
  ) {
    self.workspace = workspace
    self.isPreview = isPreview
    self.loadCache = loadCache ?? { await workspace.loadCache() }
  }

  func loadIfNeeded() async {
    guard !attemptedInitialLoad else { return }
    attemptedInitialLoad = true
    if isPreview {
      draft.receive(bytes: workspace.budgetBytes)
      hasLoadedStorage = true
    } else {
      await reloadStorage()
    }
  }

  func reloadStorage() async {
    guard !loadingStorage, !isPreview else { return }
    guard !workspace.storageOperationBusy else {
      storageLoadFailed = true
      hasLoadedStorage = false
      return
    }
    loadingStorage = true
    defer { loadingStorage = false }
    let loaded = await loadCache()
    // A launched native request owns its completion even if the presenting tab's
    // task was cancelled. Always settle this window-owned state and its retry path.
    storageLoadFailed = !loaded
    hasLoadedStorage = loaded
    if loaded { draft.receive(bytes: workspace.budgetBytes) }
  }
}

private struct DesktopStoragePreferencesSection: View {
  @ObservedObject var workspace: DesktopWorkspace
  @ObservedObject var state: DesktopStoragePreferencesState
  @State private var confirmClearOfflineVoices = false
  @FocusState private var editingLimit: Bool
  @Environment(\.locale) private var locale

  private var storageBusy: Bool {
    state.loadingStorage || workspace.storageOperationBusy
  }
  private var canChangeStorage: Bool {
    state.hasLoadedStorage && !storageBusy && !state.isPreview
  }
  private var canSave: Bool {
    canChangeStorage && DesktopOfflineStoragePolicy.bytes(gigabytes: state.draft.text) != nil
      && state.draft.hasChanges
  }

  var body: some View {
    Group {
      Section("Storage") {
        LabeledContent("Offline voices") {
          if state.hasLoadedStorage {
            Text("\(storageSize(workspace.cacheBytes)) of \(storageSize(workspace.budgetBytes))")
              .foregroundStyle(Brand.secondary)
          } else {
            Text(LocalizedStringKey(state.loadingStorage ? "Loading storage…" : "Unavailable"))
              .foregroundStyle(Brand.secondary)
          }
        }
        if state.loadingStorage {
          ProgressView().controlSize(.small)
        } else if state.storageLoadFailed {
          Label(
            "The saved storage limit could not be read. Finish the current MusicMute operation, then retry.",
            systemImage: "exclamationmark.circle"
          )
          .desktopFont(.callout)
          .foregroundStyle(Brand.amber)
          .fixedSize(horizontal: false, vertical: true)
          Button("Retry") { Task { await state.reloadStorage() } }
            .disabled(storageBusy || state.isPreview)
            .accessibilityIdentifier("desktopPreferences.retryStorage")
        }

        LabeledContent("Offline voice storage limit") {
          HStack(spacing: 8) {
            TextField("", text: $state.draft.text)
              .textFieldStyle(.roundedBorder)
              .labelsHidden()
              .frame(width: 110)
              .disabled(!canChangeStorage)
              .focused($editingLimit)
              .onSubmit { saveLimit() }
              .accessibilityLabel("Offline voice storage limit in GB")
              .accessibilityIdentifier("desktopPreferences.offlineStorageLimit")
            Text("GB").foregroundStyle(Brand.secondary)
          }
        }

        ViewThatFits(in: .horizontal) {
          HStack(spacing: 8) { storageActions }
          VStack(alignment: .leading, spacing: 8) { storageActions }
        }
        Text(
          "Choose a whole number of GB, starting at 1. The default is 2 GB, shared with the Chrome extension. Lowering the limit removes older unused voices only when space is next needed; active playback and pending account saves stay protected."
        )
        .desktopFont(.footnote)
        .foregroundStyle(Brand.secondary)
        .fixedSize(horizontal: false, vertical: true)

        if state.hasLoadedStorage
          && DesktopOfflineStoragePolicy.bytes(gigabytes: state.draft.text) == nil
        {
          Text("Enter a whole number from 1 to 9,007,199 GB.")
            .desktopFont(.footnote)
            .foregroundStyle(Brand.amber)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("desktopPreferences.storageValidation")
        }
        if let status = workspace.cacheBudgetStatus {
          Label(
            LocalizedStringKey(status),
            systemImage: workspace.savingCacheBudget ? "hourglass" : "info.circle"
          )
          .desktopFont(.footnote)
          .foregroundStyle(Brand.secondary)
          .accessibilityIdentifier("desktopPreferences.offlineStorageStatus")
        }
      }
      Section("Clear Offline Voices") {
        Text(
          "Clearing stops current MusicMute playback, then removes eligible voice copies from this Mac. Other voices pinned by extension playback or pending account saves stay protected."
        )
        .desktopFont(.footnote)
        .foregroundStyle(Brand.secondary)
        .fixedSize(horizontal: false, vertical: true)
        HStack {
          Button("Clear Offline Voices…", role: .destructive) { confirmClearOfflineVoices = true }
            .disabled(!canChangeStorage)
            .accessibilityIdentifier("desktopPreferences.clearOfflineVoices")
          if workspace.clearingCache { ProgressView().controlSize(.small) }
        }
        if let count = workspace.cacheClearedEntries, count > 0 {
          Text("Removed \(count) eligible offline voices from this Mac.")
            .desktopFont(.footnote)
            .foregroundStyle(Brand.secondary)
        } else if let status = workspace.cacheClearStatus {
          Label(
            LocalizedStringKey(status),
            systemImage: workspace.clearingCache ? "hourglass" : "info.circle"
          )
          .desktopFont(.footnote)
          .foregroundStyle(Brand.secondary)
          .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .onChange(of: workspace.budgetBytes, initial: true) { _, bytes in
      guard state.hasLoadedStorage else { return }
      state.draft.receive(bytes: bytes)
    }
    .confirmationDialog(
      "Clear eligible offline voices from this Mac?", isPresented: $confirmClearOfflineVoices
    ) {
      Button("Clear Offline Voices", role: .destructive) {
        guard canChangeStorage else { return }
        Task { await workspace.clearOfflineVoices() }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(
        "Current MusicMute playback stops first. Only other voice data pinned by active extension playback or pending account saves stays protected. Account media, models, and diagnostics are not part of this cache."
      )
    }
  }

  @ViewBuilder private var storageActions: some View {
    Button("Save Storage Limit") { saveLimit() }
      .disabled(!canSave)
      .accessibilityIdentifier("desktopPreferences.saveOfflineStorageLimit")
    Button("Use Default (2 GB)") {
      guard canChangeStorage else { return }
      state.draft.text = "2"
      saveLimit()
    }
    .disabled(
      !canChangeStorage
        || (workspace.budgetBytes == DesktopOfflineStoragePolicy.defaultBytes
          && !state.draft.hasChanges)
    )
    .accessibilityIdentifier("desktopPreferences.defaultOfflineStorageLimit")
    if workspace.savingCacheBudget { ProgressView().controlSize(.small) }
  }

  private func storageSize(_ bytes: Int64) -> String {
    bytes.formatted(
      .byteCount(style: .file, allowedUnits: .all, spellsOutZero: false).locale(locale))
  }

  private func saveLimit() {
    guard canSave else { return }
    let submitted = state.draft.text
    editingLimit = false
    Task {
      await workspace.saveOfflineStorageLimit(gigabytes: submitted)
      guard state.draft.text == submitted,
        DesktopOfflineStoragePolicy.bytes(gigabytes: submitted) == workspace.budgetBytes
      else { return }
      state.draft.receive(bytes: workspace.budgetBytes, replaceEdits: true)
    }
  }

}
