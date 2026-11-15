import AVFoundation
import MediaPlayer

@MainActor final class AudioPlayer: NSObject, ObservableObject, AVAudioPlayerDelegate {
  @Published private(set) var currentID: UUID?
  @Published private(set) var playing = false
  @Published private(set) var loading = false
  @Published private(set) var position: Double = 0
  @Published private(set) var duration: Double = 0
  @Published var failed = false
  private var player: AVAudioPlayer?
  private var title = ""
  private var timer: Timer?
  private var notifications: [NSObjectProtocol] = []
  private var remoteTargets: [(MPRemoteCommand, Any)] = []
  private var resumeAfterInterruption = false

  override init() {
    super.init()
    notifications.append(
      NotificationCenter.default.addObserver(
        forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
      ) { [weak self] notification in
        Task { @MainActor in self?.interruption(notification) }
      })
    notifications.append(
      NotificationCenter.default.addObserver(
        forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
      ) { [weak self] notification in
        if let raw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
          AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable
        {
          Task { @MainActor in self?.pause() }
        }
      })
    let commands = MPRemoteCommandCenter.shared()
    remoteTargets.append(
      (
        commands.playCommand,
        commands.playCommand.addTarget { [weak self] _ in
          Task { @MainActor in self?.resume() }
          return .success
        }
      ))
    remoteTargets.append(
      (
        commands.pauseCommand,
        commands.pauseCommand.addTarget { [weak self] _ in
          Task { @MainActor in self?.pause() }
          return .success
        }
      ))
    remoteTargets.append(
      (
        commands.togglePlayPauseCommand,
        commands.togglePlayPauseCommand.addTarget { [weak self] _ in
          Task { @MainActor in
            guard let self else { return }
            self.playing ? self.pause() : self.resume()
          }
          return .success
        }
      ))
    remoteTargets.append(
      (
        commands.changePlaybackPositionCommand,
        commands.changePlaybackPositionCommand.addTarget { [weak self] event in
          guard let event = event as? MPChangePlaybackPositionCommandEvent else {
            return .commandFailed
          }
          Task { @MainActor in self?.seek(to: event.positionTime) }
          return .success
        }
      ))
  }

  func toggle(_ record: AudioRecord, file: URL?) {
    guard let file else {
      failed = true
      return
    }
    failed = false
    if currentID != record.id || player == nil {
      pause()
      loading = true
      do {
        let audio = try AVAudioPlayer(contentsOf: file)
        audio.delegate = self
        guard audio.prepareToPlay() else { throw AudioFailure.invalidAudio }
        player = audio
        currentID = record.id
        title = record.title
        duration = audio.duration
        position = 0
        loading = false
        resume()
      } catch {
        player = nil
        loading = false
        failed = true
      }
    } else if playing {
      pause()
    } else {
      if position >= duration - 0.1 { seek(to: 0) }
      resume()
    }
  }

  func resume() {
    guard let player else { return }
    do {
      try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
      try AVAudioSession.sharedInstance().setActive(true)
      playing = player.play()
      failed = !playing
      timer?.invalidate()
      if playing {
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
          Task { @MainActor in
            guard let self else { return }
            self.position = self.player?.currentTime ?? 0
            self.updateNowPlaying()
          }
        }
      }
      updateNowPlaying()
    } catch { failed = true }
  }
  func stopAndClear() {
    player?.stop()
    player = nil
    timer?.invalidate()
    timer = nil
    currentID = nil
    playing = false
    position = 0
    duration = 0
    title = ""
    resumeAfterInterruption = false
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  func pause() {
    player?.pause()
    playing = false
    loading = false
    timer?.invalidate()
    timer = nil
    position = player?.currentTime ?? position
    updateNowPlaying()
  }
  func seek(to value: Double) {
    guard value.isFinite else { return }
    position = max(0, min(value, duration))
    player?.currentTime = position
    updateNowPlaying()
  }
  nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    Task { @MainActor in
      guard self.player === player else { return }
      self.playing = false
      self.position = self.duration
      self.failed = !flag
      self.timer?.invalidate()
      self.timer = nil
      self.updateNowPlaying()
    }
  }
  nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
    Task { @MainActor in
      guard self.player === player else { return }
      self.pause()
      self.failed = true
    }
  }
  private func updateNowPlaying() {
    guard currentID != nil else { return }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = [
      MPMediaItemPropertyTitle: title, MPMediaItemPropertyPlaybackDuration: duration,
      MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
      MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
      MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
    ]
  }
  private func interruption(_ notification: Notification) {
    guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
      let type = AVAudioSession.InterruptionType(rawValue: raw)
    else { return }
    if type == .began {
      resumeAfterInterruption = playing
      pause()
    } else {
      let options = AVAudioSession.InterruptionOptions(
        rawValue: notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
      if resumeAfterInterruption && options.contains(.shouldResume) { resume() }
      resumeAfterInterruption = false
    }
  }
  deinit {
    timer?.invalidate()
    notifications.forEach(NotificationCenter.default.removeObserver)
    for (command, target) in remoteTargets { command.removeTarget(target) }
  }
}
