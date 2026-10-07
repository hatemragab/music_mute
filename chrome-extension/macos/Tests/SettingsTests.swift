import AppKit
import CoreText
import Foundation
import SwiftUI

private enum SettingsTestFailure: Error {
  case failed(String)
}

@MainActor private final class TextSizeProbeModel: ObservableObject {
  @Published var preference: DesktopTextSizePreference = .system
  @Published var inheritedSize: DynamicTypeSize = .large
}

@MainActor private final class TextSizeCapture {
  struct Sample {
    let identity: UUID
    let size: DynamicTypeSize
  }
  var sample: Sample?
}

private struct TextSizeCaptureView: NSViewRepresentable {
  let capture: TextSizeCapture
  let sample: TextSizeCapture.Sample

  func makeNSView(context: Context) -> NSView {
    capture.sample = sample
    return NSView()
  }

  func updateNSView(_ nsView: NSView, context: Context) {
    capture.sample = sample
  }
}

private struct StatefulTextSizeProbe: View {
  @State private var identity = UUID()
  @Environment(\.dynamicTypeSize) private var size
  let capture: TextSizeCapture
  let semanticStyle: Font.TextStyle?

  var body: some View {
    Group {
      if let semanticStyle {
        Text("Text size probe").desktopFont(semanticStyle)
      } else {
        Text("Text size probe")
      }
    }
    .background(
      TextSizeCaptureView(capture: capture, sample: .init(identity: identity, size: size)))
  }
}

private struct TextSizeProbeRoot: View {
  @ObservedObject var model: TextSizeProbeModel
  let capture: TextSizeCapture
  let semanticStyle: Font.TextStyle?

  var body: some View {
    StatefulTextSizeProbe(capture: capture, semanticStyle: semanticStyle)
      .desktopTextSize(model.preference)
      .environment(\.dynamicTypeSize, model.inheritedSize)
  }
}

@MainActor private final class UnusedSettingsVault: DesktopCredentialVault {
  func load() async throws -> DesktopCredential? {
    preconditionFailure("Settings preview attempted credential access")
  }
  func save(_ credential: DesktopCredential) throws {
    preconditionFailure("Settings preview attempted credential write")
  }
  func remove() throws {
    preconditionFailure("Settings preview attempted credential removal")
  }
}

private struct UnusedSettingsHTTPTransport: DesktopHTTPTransport {
  func send(_ request: URLRequest) async throws -> (Data, Int) {
    preconditionFailure("Settings preview attempted network access")
  }
}

@MainActor private final class PendingSettingsStorageLoad {
  private var continuation: CheckedContinuation<Bool, Never>?
  private(set) var calls = 0
  var isPending: Bool { continuation != nil }

  func load() async -> Bool {
    calls += 1
    guard calls == 1 else { return true }
    return await withCheckedContinuation { continuation = $0 }
  }

  func complete(_ result: Bool) {
    let pending = continuation
    continuation = nil
    pending?.resume(returning: result)
  }
}

@main struct SettingsTests {
  @MainActor private static func checkTextSizeIdentity() async throws {
    let model = TextSizeProbeModel()
    let capture = TextSizeCapture()
    let headlineCapture = TextSizeCapture()
    let hosting = NSHostingView(
      rootView: TextSizeProbeRoot(model: model, capture: capture, semanticStyle: nil))
    let headlineHosting = NSHostingView(
      rootView: TextSizeProbeRoot(model: model, capture: headlineCapture, semanticStyle: .headline))
    hosting.frame = NSRect(x: 0, y: 0, width: 300, height: 100)
    headlineHosting.frame = hosting.frame

    func sample(_ expectedSize: DynamicTypeSize) async throws -> TextSizeCapture.Sample {
      let deadline = ContinuousClock.now.advanced(by: .seconds(2))
      repeat {
        hosting.layoutSubtreeIfNeeded()
        headlineHosting.layoutSubtreeIfNeeded()
        if let result = capture.sample, result.size == expectedSize,
          headlineCapture.sample?.size == expectedSize
        {
          return result
        }
        try await Task.sleep(for: .milliseconds(5))
      } while ContinuousClock.now < deadline
      throw SettingsTestFailure.failed("Text size did not resolve to \(expectedSize)")
    }

    let initial = try await sample(.large)
    let headlineIdentity = headlineCapture.sample!.identity
    let systemSize = hosting.fittingSize
    let systemHeadlineSize = headlineHosting.fittingSize
    var accessibilitySize: NSSize?
    var accessibilityHeadlineSize: NSSize?
    var compactSize: NSSize?
    var compactHeadlineSize: NSSize?
    let changes: [(DesktopTextSizePreference, DynamicTypeSize, DynamicTypeSize)] = [
      (.system, .accessibility2, .accessibility2),
      (.compact, .accessibility2, .small),
      (.compact, .xxxLarge, .small),
      (.system, .xxxLarge, .xxxLarge),
      (.large, .medium, .xLarge),
      (.large, .accessibility3, .xLarge),
      (.system, .accessibility3, .accessibility3),
      (.system, .medium, .medium),
      (.system, .large, .large),
      (.accessibility, .large, .accessibility1),
      (.compact, .large, .small),
      (.system, .large, .large),
    ]
    for (preference, inheritedSize, expectedSize) in changes {
      model.inheritedSize = inheritedSize
      model.preference = preference
      let current = try await sample(expectedSize)
      let measured = hosting.fittingSize
      let headlineMeasured = headlineHosting.fittingSize
      if preference == .accessibility {
        accessibilitySize = measured
        accessibilityHeadlineSize = headlineMeasured
      } else if preference == .compact, inheritedSize == .large {
        compactSize = measured
        compactHeadlineSize = headlineMeasured
      }
      guard current.identity == initial.identity,
        headlineCapture.sample?.identity == headlineIdentity
      else {
        throw SettingsTestFailure.failed("Changing text size recreated the mounted child state")
      }
    }
    for (name, system, compact, accessibility) in [
      ("inherited body", systemSize, compactSize, accessibilitySize),
      ("semantic headline", systemHeadlineSize, compactHeadlineSize, accessibilityHeadlineSize),
    ] {
      guard let compact, let accessibility,
        compact.width < system.width, compact.height < system.height,
        accessibility.width > system.width, accessibility.height > system.height
      else { throw SettingsTestFailure.failed("\(name) did not visibly scale on macOS") }
      print(
        "Settings \(name) intrinsic sizes: System \(system), Compact \(compact), Accessibility \(accessibility)"
      )
    }
    print(
      "Settings text-size checks passed: native glyphs scale, mounted state survives and system size is inherited"
    )
  }

  @MainActor private static func checkStorageLoadLifecycle() async throws {
    let suite = "musicmute.settings-state.\(UUID().uuidString.lowercased())"
    guard let defaults = UserDefaults(suiteName: suite) else {
      throw SettingsTestFailure.failed("Private defaults are unavailable")
    }
    defer { defaults.removePersistentDomain(forName: suite) }
    let support = FileManager.default.temporaryDirectory.appendingPathComponent(
      "musicmute-unused-settings-\(UUID().uuidString.lowercased())")
    let account = DesktopAccountModel(
      vault: UnusedSettingsVault(), transport: UnusedSettingsHTTPTransport(),
      installationId: UUID().uuidString.lowercased(), preferences: defaults)
    let workspace = DesktopWorkspace(
      account: account, resources: nil, playbackSupport: support, preferences: defaults)
    let loader = PendingSettingsStorageLoad()
    let state = DesktopStoragePreferencesState(
      workspace: workspace, loadCache: { await loader.load() })
    let firstConsumer = Task { @MainActor in await state.loadIfNeeded() }
    let deadline = ContinuousClock.now.advanced(by: .seconds(2))
    while !loader.isPending && ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(5))
    }
    guard loader.isPending, state.loadingStorage, loader.calls == 1 else {
      throw SettingsTestFailure.failed("Storage initial load did not start")
    }
    firstConsumer.cancel()
    await state.loadIfNeeded()
    await state.reloadStorage()
    guard loader.calls == 1, state.loadingStorage else {
      throw SettingsTestFailure.failed("Reentering Storage overlapped or reset the pending load")
    }
    loader.complete(false)
    await firstConsumer.value
    guard !state.loadingStorage, state.storageLoadFailed, !state.hasLoadedStorage else {
      throw SettingsTestFailure.failed("Cancelled consumer left storage load state unsettled")
    }
    await state.loadIfNeeded()
    guard loader.calls == 1 else {
      throw SettingsTestFailure.failed("Storage initial failure retried without an explicit action")
    }
    await state.reloadStorage()
    guard loader.calls == 2, !state.loadingStorage, !state.storageLoadFailed,
      state.hasLoadedStorage, state.draft.text == "2"
    else { throw SettingsTestFailure.failed("Explicit Storage retry did not recover") }
    state.draft.text = "3"
    await state.reloadStorage()
    guard loader.calls == 3, state.draft.text == "3", state.draft.hasChanges else {
      throw SettingsTestFailure.failed("Refreshing Storage discarded an unsaved limit")
    }
    guard !FileManager.default.fileExists(atPath: support.path) else {
      throw SettingsTestFailure.failed("Storage state checks wrote support data")
    }
    print(
      "Settings storage checks passed: cancellation/reentry settle once, explicit retry recovers and edits survive"
    )
  }

  @MainActor private static func renderUI(at destination: URL) async throws {
    guard destination.isFileURL, destination.path.hasPrefix("/"), destination.path != "/",
      !FileManager.default.fileExists(atPath: destination.path)
    else { throw SettingsTestFailure.failed("Use a new absolute private output directory") }
    for language in ["en", "ar"] {
      guard
        Bundle.main.url(
          forResource: "Localizable", withExtension: "strings", subdirectory: nil,
          localization: language) != nil
      else {
        throw SettingsTestFailure.failed("Settings renderer requires bundled \(language) resources")
      }
    }
    try FileManager.default.createDirectory(
      at: destination, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])

    var cases: [(String, ColorScheme, DesktopTextSizePreference, DesktopSettingsSection, String)] =
      []
    for language in ["en", "ar"] {
      for section in DesktopSettingsSection.allCases {
        cases.append((language, language == "en" ? .light : .dark, .system, section, "standard"))
      }
      cases.append((language, language == "en" ? .dark : .light, .system, .appearance, "alternate"))
      cases.append(
        (language, language == "en" ? .light : .dark, .accessibility, .appearance, "large"))
    }
    var images = [String]()
    for (language, scheme, textSize, section, variant) in cases {
      let suite = "musicmute.settings-preview.\(UUID().uuidString.lowercased())"
      guard let defaults = UserDefaults(suiteName: suite) else {
        throw SettingsTestFailure.failed("Private defaults are unavailable")
      }
      defer { defaults.removePersistentDomain(forName: suite) }
      let account = DesktopAccountModel(
        vault: UnusedSettingsVault(), transport: UnusedSettingsHTTPTransport(),
        installationId: UUID().uuidString.lowercased(), preferences: defaults)
      let workspace = DesktopWorkspace(
        account: account, resources: nil,
        playbackSupport: destination.appendingPathComponent("unused-support"), preferences: defaults
      )
      let updater = DesktopUpdater(
        support: destination.appendingPathComponent("unused-updates"), fixture: true)
      let preferences = DesktopVisualPreferences(defaults: defaults)
      preferences.appearance = scheme == .dark ? .dark : .light
      preferences.textSize = textSize
      preferences.language = language == "ar" ? .arabic : .english
      let width: CGFloat = textSize == .accessibility ? 1000 : 850
      let height: CGFloat = textSize == .accessibility ? 1050 : 780
      let preview = DesktopPreferencesView(
        workspace: workspace, visualPreferences: preferences, updater: updater,
        isPreview: true, initialSection: section
      )
      .defaultAppStorage(defaults)
      .environment(\.locale, Locale(identifier: language))
      .environment(\.layoutDirection, language == "ar" ? .rightToLeft : .leftToRight)
      .environment(\.colorScheme, scheme)
      .desktopTextSize(textSize)
      .tint(preferences.accent.color).accentColor(preferences.accent.color)
      .frame(width: width, height: height)
      .background(Color(nsColor: .windowBackgroundColor))
      let hosting = NSHostingView(rootView: preview)
      hosting.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
      hosting.frame = NSRect(x: 0, y: 0, width: width, height: height)
      let window = NSWindow(
        contentRect: hosting.frame, styleMask: [.borderless], backing: .buffered, defer: false)
      window.isReleasedWhenClosed = false
      window.appearance = hosting.appearance
      window.contentView = hosting
      defer { window.close() }
      hosting.layoutSubtreeIfNeeded()
      try await Task.sleep(for: .milliseconds(30))
      hosting.layoutSubtreeIfNeeded()
      guard !window.isVisible else {
        throw SettingsTestFailure.failed("Settings preview window became visible")
      }
      guard let bitmap = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else {
        throw SettingsTestFailure.failed("Settings bitmap is unavailable")
      }
      hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
      guard let bytes = bitmap.representation(using: .png, properties: [:]), bytes.count > 10_000
      else {
        throw SettingsTestFailure.failed("Settings bitmap is empty")
      }
      let name =
        "settings-\(language)-\(scheme == .dark ? "dark" : "light")-\(section.rawValue)-\(variant).png"
      try bytes.write(to: destination.appendingPathComponent(name), options: .withoutOverwriting)
      images.append(name)
      guard
        !FileManager.default.fileExists(
          atPath: destination.appendingPathComponent("unused-support").path),
        !FileManager.default.fileExists(
          atPath: destination.appendingPathComponent("unused-updates").path)
      else { throw SettingsTestFailure.failed("Settings preview wrote runtime or update state") }
    }
    let report: [String: Any] = [
      "scope": "OFFSCREEN_REAL_SETTINGS_VIEW_PRIVATE_PREFERENCES",
      "images": images,
      "app_window_shown": false,
      "account_or_keychain_access": false,
      "network_or_processing_started": false,
      "installed_app_or_worker_modified": false,
      "native_tab_header_pixels_validated": false,
      "capture_limitation":
        "Offscreen bitmap capture does not validate native compositor-backed tab controls.",
    ]
    let bytes = try JSONSerialization.data(
      withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
    try bytes.write(
      to: destination.appendingPathComponent("settings-preview.json"), options: .withoutOverwriting)
    print("Rendered \(images.count) isolated Settings previews to \(destination.path)")
  }

  @MainActor private static func checkTypography() throws {
    let resources = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("Resources")
    let repository = resources.deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent()
    let android = repository.appendingPathComponent("android/app/src/main")
    guard
      try Data(contentsOf: resources.appendingPathComponent("Fonts/NotoSansArabic.ttf"))
        == Data(contentsOf: android.appendingPathComponent("res/font/noto_sans_arabic.ttf")),
      try Data(contentsOf: resources.appendingPathComponent("licenses/noto_sans_arabic_ofl.txt"))
        == Data(
          contentsOf: android.appendingPathComponent("assets/licenses/noto_sans_arabic_ofl.txt"))
    else { throw SettingsTestFailure.failed("Mac font or license differs from Android") }
    for weight: Font.Weight in [.regular, .medium, .semibold, .bold] {
      let font = DesktopTypography.nativeFont(.body, weight: weight)
      guard font.familyName == DesktopTypography.family else {
        throw SettingsTestFailure.failed("Font weight fell back to a different family")
      }
      let characters = Array("MusicMute صوت واضح".utf16)
      var glyphs = [CGGlyph](repeating: 0, count: characters.count)
      guard CTFontGetGlyphsForCharacters(font as CTFont, characters, &glyphs, characters.count),
        glyphs.allSatisfy({ $0 != 0 })
      else { throw SettingsTestFailure.failed("Noto font is missing English or Arabic glyphs") }
    }
    guard DesktopTypography.nativeFont(.body).pointSize >= 17,
      DesktopTypography.nativeFont(.caption).pointSize >= 14,
      DesktopTypography.nativeFont(.caption2, scale: 0.85).pointSize >= 13,
      DesktopTypography.nativeFont(.body, scale: 1.55).pointSize
        > DesktopTypography.nativeFont(.body).pointSize,
      DesktopTypography.nativeFont(.caption, design: .monospaced).isFixedPitch
    else {
      throw SettingsTestFailure.failed("Readable type scale or technical monospace regressed")
    }
    print(
      "Typography checks passed: exact Android font and license, native weights, bilingual glyphs, readable sizes"
    )
  }

  @MainActor static func main() async throws {
    _ = NSApplication.shared
    NSApp.setActivationPolicy(.prohibited)
    let resources = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("Resources")
    guard DesktopTypography.registerFont(resources: resources) else {
      throw SettingsTestFailure.failed("Android's bundled Noto Sans Arabic font did not register")
    }
    if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--render-settings-ui" {
      guard CommandLine.arguments[2].hasPrefix("/") else {
        throw SettingsTestFailure.failed("Use an absolute Settings output path")
      }
      try await renderUI(at: URL(fileURLWithPath: CommandLine.arguments[2]))
      return
    }
    guard CommandLine.arguments.count == 1 else {
      throw SettingsTestFailure.failed("Unsupported Settings test arguments")
    }
    try checkTypography()
    try await checkTextSizeIdentity()
    try await checkStorageLoadLifecycle()
  }
}
