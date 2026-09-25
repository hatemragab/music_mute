import SwiftUI

#Preview("Home · English") {
  NavigationStack {
    HomeView(showHistory: {}).background(VocalStyle.background(.light))
  }
}

#Preview("Home · العربية") {
  NavigationStack {
    HomeView(showHistory: {}).background(VocalStyle.background(.light))
  }
  .environment(\.locale, Locale(identifier: "ar")).environment(\.layoutDirection, .rightToLeft)
}

#Preview("Settings · Arabic dark") {
  let firebase = FirebaseAuthGateway()
  let auth = AuthSessionModel(
    firebase: firebase, apple: AppleCredentialProvider(),
    installationStore: InstallationStore(
      file: FileManager.default.temporaryDirectory.appendingPathComponent("preview-auth.json")),
    api: nil)
  NavigationStack { SettingsView(preferences: AppPreferences(), auth: auth) }
    .environment(\.locale, Locale(identifier: "ar")).environment(\.layoutDirection, .rightToLeft)
    .preferredColorScheme(.dark)
}
