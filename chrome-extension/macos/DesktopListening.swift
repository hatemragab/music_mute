import AVFoundation
import Foundation

struct DesktopSilenceRange: Sendable, Equatable {
  let start: Double
  let end: Double
}

enum DesktopSilenceAnalysis {
  /// Streams small PCM buffers from an owned offline voice. It never allocates the full recording.
  static func ranges(url: URL) throws -> [DesktopSilenceRange] {
    let audio = try AVAudioFile(
      forReading: url, commonFormat: .pcmFormatFloat32, interleaved: false)
    let format = audio.processingFormat
    guard format.sampleRate >= 8000, format.sampleRate <= 192_000, format.channelCount <= 2,
      format.channelCount > 0, audio.length >= 0, Double(audio.length) / format.sampleRate <= 7200,
      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1024)
    else { throw DesktopAuthFailure.malformedResponse }
    var ranges: [DesktopSilenceRange] = []
    var silentStart: Double?
    var position = 0.0
    while audio.framePosition < audio.length {
      try Task.checkCancellation()
      try audio.read(into: buffer, frameCount: 1024)
      guard buffer.frameLength > 0, let channels = buffer.floatChannelData else { break }
      var sum = 0.0
      let frames = Int(buffer.frameLength)
      let count = Int(format.channelCount)
      for channel in 0..<count {
        for index in 0..<frames {
          let sample = Double(channels[channel][index])
          sum += sample * sample
        }
      }
      let rms = sqrt(sum / Double(max(1, frames * count)))
      let next = position + Double(frames) / format.sampleRate
      if rms < 0.00316227766 {
        if silentStart == nil { silentStart = position }
      } else if let start = silentStart {
        if position - start >= 0.4 {
          ranges.append(
            DesktopSilenceRange(start: start + 0.06, end: max(start + 0.06, position - 0.06)))
        }
        silentStart = nil
      }
      guard ranges.count <= 10_000 else { throw DesktopAuthFailure.malformedResponse }
      position = next
    }
    if let start = silentStart, position - start >= 0.4 {
      ranges.append(
        DesktopSilenceRange(start: start + 0.06, end: max(start + 0.06, position - 0.06)))
    }
    return ranges
  }
}
