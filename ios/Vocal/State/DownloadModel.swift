import Foundation
import UIKit

@MainActor
final class DownloadModel: ObservableObject {
  @Published private(set) var records: [AudioRecord] = []
  @Published private(set) var loading = true
  @Published private(set) var storageError = false
  @Published var invalidURL = false
  @Published var urlText: String {
    didSet {
      guard oldValue != urlText else { return }
      defaults.set(urlText, forKey: "sourceURL")
      invalidURL = false
    }
  }
  private let defaults: UserDefaults
  private let service: any AudioDownloading
  private let history: HistoryStore
  private var tasks: [UUID: Task<Void, Never>] = [:]
  private var revision = 0
  private var leases: [UUID: UIBackgroundTaskIdentifier] = [:]

  init(service: any AudioDownloading, history: HistoryStore, defaults: UserDefaults = .standard) {
    self.service = service
    self.history = history
    self.defaults = defaults
    urlText = defaults.string(forKey: "sourceURL") ?? ""
  }

  func load() async {
    guard tasks.isEmpty else { return }
    loading = true
    do {
      records = try await history.load()
      for index in records.indices where records[index].status.isActive {
        records[index].status = .failed
        records[index].failure = .interrupted
      }
      storageError = false
      await persist()
    } catch { storageError = true }
    loading = false
  }

  @discardableResult func start() async -> Bool {
    guard !loading, !storageError else { return false }
    guard YouTubePreflight.isIndividualURL(urlText), let id = YouTubeURL.videoID(from: urlText)
    else {
      invalidURL = true
      return false
    }
    await enqueue(videoID: id)
    return true
  }

  func retry(_ record: AudioRecord) async {
    guard !storageError, !record.status.isActive else { return }
    await enqueue(videoID: record.videoID)
  }

  private func enqueue(videoID: String) async {
    if records.contains(where: { $0.videoID == videoID && $0.status.isActive }) { return }
    let record = AudioRecord(id: UUID(), videoID: videoID, createdAt: Date())
    records.insert(record, at: 0)
    await persist()
    guard !storageError, records.first(where: { $0.id == record.id })?.status.isActive == true
    else { return }
    let id = record.id
    leases[id] = UIApplication.shared.beginBackgroundTask(withName: "Vocal audio") { [weak self] in
      Task { @MainActor in self?.cancel(id, interrupted: true) }
    }
    tasks[id] = Task { [weak self] in
      guard let self else { return }
      defer {
        self.tasks[id] = nil
        self.endLease(id)
      }
      do {
        let audio = try await service.download(
          videoID: videoID, id: id,
          stage: { [weak self] status in Task { @MainActor in self?.stage(id, status) } },
          progress: { [weak self] value in Task { @MainActor in self?.progress(id, value) } })
        guard let index = index(id), records[index].status.isActive else {
          await service.discardAttempt(id)
          return
        }
        records[index].title = audio.title
        records[index].relativePath = audio.relativePath
        records[index].codec = audio.codec
        records[index].fileExtension = audio.fileExtension
        records[index].bitrate = audio.bitrate
        records[index].byteCount = audio.byteCount
        records[index].duration = audio.duration
        records[index].progress = 1
        records[index].status = .complete
      } catch {
        guard let index = index(id), records[index].status.isActive else { return }
        if Task.isCancelled {
          records[index].status = .cancelled
        } else {
          records[index].status = .failed
          records[index].failure = Self.failure(error)
        }
      }
      await persist()
    }
  }

  func cancel(_ id: UUID, interrupted: Bool = false) {
    guard let index = index(id), records[index].status.isActive else { return }
    records[index].status = interrupted ? .failed : .cancelled
    records[index].failure = interrupted ? .interrupted : nil
    tasks[id]?.cancel()
    endLease(id)
    Task { await persist() }
  }

  private func endLease(_ id: UUID) {
    if let lease = leases.removeValue(forKey: id), lease != .invalid {
      UIApplication.shared.endBackgroundTask(lease)
    }
  }
  private func index(_ id: UUID) -> Int? { records.firstIndex { $0.id == id } }
  private func stage(_ id: UUID, _ status: DownloadStatus) {
    guard let index = index(id), records[index].status.isActive else { return }
    records[index].status = status
    Task { await persist() }
  }
  private func progress(_ id: UUID, _ value: DownloadProgress) {
    guard let index = index(id), records[index].status.isActive else { return }
    records[index].progress = value.fraction ?? 0
    records[index].downloadedBytes = value.downloadedBytes
    records[index].totalBytes = value.totalBytes
  }
  private func persist() async {
    revision += 1
    do { try await history.save(records, revision: revision) } catch { storageError = true }
  }
  private static func failure(_ error: Error) -> AudioFailure {
    if let failure = error as? AudioFailure { return failure }
    if error is URLError { return .network }
    if (error as NSError).domain == NSCocoaErrorDomain { return .storage }
    return .unavailable
  }
}
