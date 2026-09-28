import SwiftUI

enum Appearance: String, CaseIterable { case system, light, dark }
enum AppLanguage: String, CaseIterable { case system, en, ar }

@MainActor final class AppPreferences: ObservableObject {
  private let defaults: UserDefaults
  @Published var appearance: Appearance {
    didSet { defaults.set(appearance.rawValue, forKey: "appearance") }
  }
  @Published var language: AppLanguage {
    didSet { defaults.set(language.rawValue, forKey: "language") }
  }
  @Published private(set) var accentHex: String
  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    appearance = Appearance(rawValue: defaults.string(forKey: "appearance") ?? "") ?? .system
    language = AppLanguage(rawValue: defaults.string(forKey: "language") ?? "") ?? .system
    accentHex = Self.normalizedAccent(defaults.string(forKey: "accent")) ?? "#FF814A"
  }
  var locale: Locale { language == .system ? .current : Locale(identifier: language.rawValue) }
  var direction: LayoutDirection {
    locale.language.languageCode?.identifier == "ar" ? .rightToLeft : .leftToRight
  }
  var colorScheme: ColorScheme? {
    appearance == .system ? nil : appearance == .dark ? .dark : .light
  }
  var accentColor: Color {
    let value = UInt64(accentHex.dropFirst(), radix: 16) ?? 0xFF814A
    return Color(
      red: Double((value >> 16) & 0xff) / 255,
      green: Double((value >> 8) & 0xff) / 255,
      blue: Double(value & 0xff) / 255)
  }
  func setAccent(_ value: String) {
    guard let normalized = Self.normalizedAccent(value) else { return }
    accentHex = normalized
    defaults.set(normalized, forKey: "accent")
  }
  static func normalizedAccent(_ value: String?) -> String? {
    guard let value else { return nil }
    let hex = value.trimmingCharacters(in: .whitespacesAndNewlines)
      .replacingOccurrences(of: "#", with: "").uppercased()
    guard hex.range(of: "^[0-9A-F]{6}$", options: .regularExpression) != nil else {
      return nil
    }
    return "#\(hex)"
  }
}
