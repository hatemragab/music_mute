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
  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    appearance = Appearance(rawValue: defaults.string(forKey: "appearance") ?? "") ?? .system
    language = AppLanguage(rawValue: defaults.string(forKey: "language") ?? "") ?? .system
  }
  var locale: Locale { language == .system ? .current : Locale(identifier: language.rawValue) }
  var direction: LayoutDirection {
    locale.language.languageCode?.identifier == "ar" ? .rightToLeft : .leftToRight
  }
  var colorScheme: ColorScheme? {
    appearance == .system ? nil : appearance == .dark ? .dark : .light
  }
}
