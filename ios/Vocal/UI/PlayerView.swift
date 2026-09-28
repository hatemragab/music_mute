import SwiftUI

private struct PlayerExport: Identifiable {
  let id = UUID()
  let url: URL
}

struct MiniPlayerView: View {
  @ObservedObject var model: ProcessingModel
  @ObservedObject var player: AudioPlayer
  var onOpen: () -> Void

  var body: some View {
    if let job = model.currentPlaybackJob {
      HStack(spacing: 12) {
        Image(systemName: "waveform").foregroundStyle(VocalStyle.teal)
          .frame(width: 44, height: 44)
          .background(VocalStyle.teal.opacity(0.14), in: RoundedRectangle(cornerRadius: 12))
        Button(action: onOpen) {
          VStack(alignment: .leading, spacing: 2) {
            Text(job.preferredName).font(.subheadline.weight(.semibold)).lineLimit(1)
            Text(player.original ? "player_original" : "player_voice")
              .font(.caption).foregroundStyle(.secondary)
          }.frame(maxWidth: .infinity, alignment: .leading)
        }.buttonStyle(.plain).accessibilityIdentifier("miniPlayerOpen")
        Button(action: model.playPrevious) {
          Image(systemName: "backward.end.fill").frame(width: 44, height: 44)
        }.accessibilityLabel(Text("player_previous"))
        Button {
          player.playing ? player.pause() : player.resume()
        } label: {
          Image(systemName: player.playing ? "pause.fill" : "play.fill")
            .frame(width: 44, height: 44)
        }.accessibilityLabel(Text(player.playing ? "pause" : "play"))
        Button(action: model.playNext) {
          Image(systemName: "forward.end.fill").frame(width: 44, height: 44)
        }.accessibilityLabel(Text("player_next"))
      }
      .padding(.horizontal, 12).padding(.vertical, 8)
      .background(.ultraThinMaterial)
      .overlay(alignment: .top) { Divider() }
    }
  }
}

struct PlayerView: View {
  @ObservedObject var model: ProcessingModel
  @ObservedObject var player: AudioPlayer
  @ObservedObject var preferences: LibraryPreferencesStore
  var onOpenDetails: (Job) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var export: PlayerExport?

  var body: some View {
    ScrollView {
      VStack(spacing: 22) {
        HStack {
          Button("close") { dismiss() }
          Spacer()
          Text("player_title").font(.headline)
          Spacer()
          if let job = model.currentPlaybackJob {
            Button {
              dismiss()
              onOpenDetails(job)
            } label: {
              Image(systemName: "info.circle").frame(width: 44, height: 44)
            }.accessibilityLabel(Text("processing_details"))
              .accessibilityIdentifier("playerInfo")
          } else {
            Color.clear.frame(width: 44, height: 44)
          }
        }
        if let job = model.currentPlaybackJob {
          RoundedRectangle(cornerRadius: 30)
            .fill(
              RadialGradient(
                colors: [VocalStyle.teal.opacity(0.45), VocalStyle.card(.dark)],
                center: .topLeading, startRadius: 10, endRadius: 260)
            )
            .aspectRatio(1, contentMode: .fit)
            .overlay {
              Image(systemName: "waveform").font(.system(size: 94)).foregroundStyle(VocalStyle.teal)
            }
            .shadow(color: .black.opacity(0.35), radius: 30, y: 18)
          Text(job.preferredName).font(.title2.bold()).multilineTextAlignment(.center)
          HStack(spacing: 12) {
            Button {
              preferences.toggleFavorite(job.id)
            } label: {
              Label(
                preferences.favorites.contains(job.id)
                  ? "library_unfavorite" : "library_favorite",
                systemImage: preferences.favorites.contains(job.id) ? "star.fill" : "star"
              )
              .frame(minHeight: 44)
            }.buttonStyle(.bordered).accessibilityIdentifier("playerFavorite")
            Button {
              model.downloadOriginal(job) { export = PlayerExport(url: $0) }
            } label: {
              Label("save_original", systemImage: "arrow.down.circle")
                .frame(minHeight: 44)
            }.buttonStyle(.bordered).disabled(model.busy || !job.canDownloadInput)
              .accessibilityIdentifier("playerSaveOriginal")
          }
          Picker(
            "player_track",
            selection: Binding(
              get: { player.original }, set: { model.selectOriginal($0) }
            )
          ) {
            Text("player_voice").tag(false)
            Text("player_original").tag(true)
          }
          .pickerStyle(.segmented)
          .disabled(model.busy || !job.canDownloadInput)
          VStack(spacing: 8) {
            Slider(
              value: Binding(get: { player.position }, set: player.seek),
              in: 0...max(1, player.duration)
            )
            .accessibilityLabel(Text("playback_position"))
            HStack {
              Text(audioTime(player.position))
              Spacer()
              Text(audioTime(player.duration))
            }.font(.caption.monospacedDigit()).foregroundStyle(.secondary)
          }
          HStack(spacing: 26) {
            PlayerIconButton(
              "player_previous", systemImage: "backward.end.fill", action: model.playPrevious)
            PlayerIconButton(
              player.playing ? "pause" : "play",
              systemImage: player.playing ? "pause.fill" : "play.fill", prominent: true
            ) { player.playing ? player.pause() : player.resume() }
            PlayerIconButton("player_next", systemImage: "forward.end.fill", action: model.playNext)
          }
          HStack(spacing: 12) {
            ToggleButton(
              "player_shuffle", systemImage: "shuffle", selected: model.shufflePlayback
            ) { model.shufflePlayback.toggle() }
            ToggleButton(
              model.repeatPlayback == .one ? "player_repeat_one" : "player_repeat",
              systemImage: model.repeatPlayback == .one ? "repeat.1" : "repeat",
              selected: model.repeatPlayback != .off
            ) {
              model.repeatPlayback =
                switch model.repeatPlayback {
                case .off: .all
                case .all: .one
                case .one: .off
                }
            }
            Menu {
              ForEach([0.75, 1, 1.25, 1.5, 2], id: \.self) { value in
                Button("\(value, specifier: "%g")×") { player.setSpeed(Float(value)) }
              }
            } label: {
              Label("\(player.speed, specifier: "%g")×", systemImage: "speedometer")
                .frame(minWidth: 44, minHeight: 44)
            }.buttonStyle(.bordered)
          }
          Toggle("player_auto_next", isOn: $model.autoPlayNext)
          HStack {
            Image(systemName: "speaker.fill")
            Slider(
              value: Binding(
                get: { Double(player.volume) },
                set: { player.setVolume(Float($0)) }), in: 0...1
            )
            .accessibilityLabel(Text("player_volume"))
            Image(systemName: "speaker.wave.3.fill")
          }
          VStack(alignment: .leading, spacing: 10) {
            Label("player_queue", systemImage: "music.note.list").font(.headline)
            ForEach(model.playbackQueue) { queued in
              HStack {
                Button {
                  model.play(queued, queue: model.playbackQueue)
                } label: {
                  HStack {
                    Image(systemName: queued.id == job.id ? "speaker.wave.2.fill" : "music.note")
                    Text(queued.preferredName).lineLimit(1)
                    Spacer()
                  }.frame(minHeight: 44)
                }.buttonStyle(.plain)
                if queued.id != job.id {
                  Button {
                    model.removeFromPlaybackQueue(queued.id)
                  } label: {
                    Image(systemName: "xmark").frame(width: 44, height: 44)
                  }.accessibilityLabel(Text("player_remove_queue"))
                }
              }
              if queued.id != model.playbackQueue.last?.id { Divider() }
            }
          }.padding(18).background(VocalStyle.card(.dark), in: RoundedRectangle(cornerRadius: 20))
          if player.failed { Text("processing_error_service").foregroundStyle(.red) }
          if let messageKey = model.messageKey {
            Text(LocalizedStringKey(messageKey)).foregroundStyle(.secondary)
          }
        } else {
          ContentUnavailableView("player_empty", systemImage: "music.note")
            .frame(maxWidth: .infinity).padding(.vertical, 80)
        }
      }.padding(20).frame(maxWidth: 680).frame(maxWidth: .infinity)
    }
    .background(VocalStyle.background(.dark).ignoresSafeArea())
    .preferredColorScheme(.dark)
    .sheet(item: $export) { item in
      AudioExportPicker(file: item.url) { _ in export = nil }
    }
  }
}

private struct PlayerIconButton: View {
  let title: LocalizedStringKey
  let systemImage: String
  let prominent: Bool
  let action: () -> Void
  init(
    _ title: LocalizedStringKey, systemImage: String, prominent: Bool = false,
    action: @escaping () -> Void
  ) {
    self.title = title
    self.systemImage = systemImage
    self.prominent = prominent
    self.action = action
  }
  var body: some View {
    Button(action: action) {
      Image(systemName: systemImage).font(.title2)
        .frame(width: prominent ? 62 : 48, height: prominent ? 62 : 48)
    }
    .buttonStyle(.borderedProminent).buttonBorderShape(.circle)
    .tint(prominent ? VocalStyle.teal : Color.secondary.opacity(0.24))
    .accessibilityLabel(Text(title))
  }
}

private struct ToggleButton: View {
  let title: LocalizedStringKey
  let systemImage: String
  let selected: Bool
  let action: () -> Void
  init(
    _ title: LocalizedStringKey, systemImage: String, selected: Bool, action: @escaping () -> Void
  ) {
    self.title = title
    self.systemImage = systemImage
    self.selected = selected
    self.action = action
  }
  var body: some View {
    Button(action: action) { Image(systemName: systemImage).frame(width: 44, height: 44) }
      .buttonStyle(.bordered).tint(selected ? VocalStyle.teal : .secondary)
      .accessibilityLabel(Text(title)).accessibilityValue(Text(selected ? "on" : "off"))
  }
}
