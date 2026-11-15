import SwiftUI

private struct PreviewDownloader: AudioDownloading {
  func download(
    videoID: String, id: UUID, stage: @escaping @Sendable (DownloadStatus) -> Void,
    progress: @escaping @Sendable (DownloadProgress) -> Void
  ) async throws -> SavedAudio {
    throw AudioFailure.unavailable
  }
}

@MainActor private enum PreviewData {
  static func model() -> DownloadModel {
    DownloadModel(
      service: PreviewDownloader(),
      history: HistoryStore(
        file: FileManager.default.temporaryDirectory.appendingPathComponent(
          "preview-\(UUID()).json")))
  }
  static var record: AudioRecord {
    var value = AudioRecord(id: UUID(), videoID: "jNQXAC9IVRw", createdAt: Date())
    value.status = .complete
    value.title = "Morning voice notes"
    value.codec = "AAC"
    value.fileExtension = "m4a"
    value.bitrate = 128000
    value.byteCount = 4_000_000
    value.duration = 180
    return value
  }
}

#Preview("Home · English") {
  NavigationStack {
    HomeView(model: PreviewData.model(), showHistory: {}).background(VocalStyle.background(.light))
  }
}

#Preview("Home · العربية") {
  NavigationStack {
    HomeView(model: PreviewData.model(), showHistory: {}).background(VocalStyle.background(.light))
  }
  .environment(\.locale, Locale(identifier: "ar")).environment(\.layoutDirection, .rightToLeft)
}

#Preview("History · dark") {
  ScrollView { AudioRow(record: PreviewData.record, player: AudioPlayer()).padding(20) }
    .background(VocalStyle.background(.dark)).preferredColorScheme(.dark)
}

#Preview("History · narrow and large text", traits: .fixedLayout(width: 320, height: 900)) {
  ScrollView { AudioRow(record: PreviewData.record, player: AudioPlayer()).padding(16) }
    .dynamicTypeSize(.accessibility2).background(VocalStyle.background(.light))
}

#Preview("History · cancelled") {
  let record = AudioRecord(
    id: UUID(), videoID: "jNQXAC9IVRw", createdAt: Date(), status: .cancelled)
  ScrollView { AudioRow(record: record, player: AudioPlayer()).padding(20) }
}

#Preview("History · failure") {
  let record = AudioRecord(
    id: UUID(), videoID: "jNQXAC9IVRw", createdAt: Date(), status: .failed, failure: .network)
  ScrollView { AudioRow(record: record, player: AudioPlayer()).padding(20) }
}

#Preview("History · progress") {
  let record = AudioRecord(
    id: UUID(), videoID: "jNQXAC9IVRw", createdAt: Date(), status: .downloading, progress: 0.42)
  ScrollView { AudioRow(record: record, player: AudioPlayer()).padding(20) }
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
