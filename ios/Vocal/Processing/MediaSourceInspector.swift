import AVFoundation

struct MediaSourceInspection {
  let asset: AVURLAsset
  let track: AVAssetTrack
  let duration: Double
  let hasVideo: Bool
}

enum MediaSourceInspector {
  static func selectTrack(ids: [CMPersistentTrackID], defaultID: CMPersistentTrackID?) throws
    -> CMPersistentTrackID
  {
    guard !ids.isEmpty else { throw AudioInputPreparationError.noAudio }
    if let defaultID, ids.contains(defaultID) { return defaultID }
    guard ids.count == 1 else { throw AudioInputPreparationError.defaultTrackUnavailable }
    return ids[0]
  }

  static func inspect(_ url: URL, policy: ProcessingMediaPolicy) async throws
    -> MediaSourceInspection
  {
    let asset = AVURLAsset(url: url)
    let tracks = try await asset.loadTracks(withMediaType: .audio)
    guard tracks.count <= 16 else { throw AudioInputPreparationError.defaultTrackUnavailable }
    // Enabled flags come from the container track headers. Never guess using
    // language, stream order, or the user's preferred audio language.
    let enabled = tracks.filter { $0.isEnabled }
    let defaultID = enabled.count == 1 ? enabled[0].trackID : nil
    let id = try selectTrack(ids: tracks.map(\.trackID), defaultID: defaultID)
    guard let track = tracks.first(where: { $0.trackID == id }) else {
      throw AudioInputPreparationError.defaultTrackUnavailable
    }
    let descriptions = try await track.load(.formatDescriptions)
    guard !descriptions.isEmpty,
      descriptions.allSatisfy({ description in
        guard let format = CMAudioFormatDescriptionGetStreamBasicDescription(description) else {
          return false
        }
        return (1...2).contains(format.pointee.mChannelsPerFrame)
          && format.pointee.mSampleRate.isFinite
          && (8000...192000).contains(format.pointee.mSampleRate)
      })
    else {
      throw AudioInputPreparationError.unsupportedFormat
    }
    let range = try await track.load(.timeRange)
    let hasVideo = !(try await asset.loadTracks(withMediaType: .video)).isEmpty
    let duration: Double
    if !hasVideo, tracks.count == 1, let audioFile = try? AVAudioFile(forReading: url) {
      duration = Double(audioFile.length) / audioFile.fileFormat.sampleRate
    } else {
      duration = range.duration.seconds
    }
    guard duration.isFinite, duration > 0 else { throw AudioInputPreparationError.durationUnknown }
    guard duration <= policy.maxDuration else {
      throw AudioInputPreparationError.tooLong
    }
    return MediaSourceInspection(
      asset: asset, track: track, duration: duration,
      hasVideo: hasVideo)
  }
}
