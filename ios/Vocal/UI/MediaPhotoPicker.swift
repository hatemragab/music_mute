import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The system picker grants access only to the single selected video.
struct MediaPhotoPicker: UIViewControllerRepresentable {
  var maxSourceBytes: Int64
  var completion: (Result<URL?, Error>) -> Void
  func makeCoordinator() -> Coordinator {
    Coordinator(maxSourceBytes: maxSourceBytes, completion: completion)
  }
  func makeUIViewController(context: Context) -> PHPickerViewController {
    var configuration = PHPickerConfiguration()
    configuration.filter = .videos
    configuration.selectionLimit = 1
    configuration.preferredAssetRepresentationMode = .current
    let picker = PHPickerViewController(configuration: configuration)
    picker.delegate = context.coordinator
    return picker
  }
  func updateUIViewController(_ controller: PHPickerViewController, context: Context) {}
  final class Coordinator: NSObject, PHPickerViewControllerDelegate {
    let maxSourceBytes: Int64
    let completion: (Result<URL?, Error>) -> Void
    private var completed = false
    private var delivered = false
    private var providerProgress: Progress?
    private func deliver(_ result: Result<URL?, Error>) {
      guard !delivered else {
        if case .success(let url) = result, let url { PreparedMediaCleanup.discardPhotoCopy(url) }
        return
      }
      delivered = true
      completion(result)
    }
    init(maxSourceBytes: Int64, completion: @escaping (Result<URL?, Error>) -> Void) {
      self.maxSourceBytes = maxSourceBytes
      self.completion = completion
    }
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
      guard !completed else { return }
      completed = true
      guard let result = results.first else {
        deliver(.success(nil))
        return
      }
      providerProgress = result.itemProvider.loadFileRepresentation(
        forTypeIdentifier: UTType.movie.identifier
      ) { url, error in
        let outcome = Result<URL?, Error> {
          if let error { throw error }
          guard let url else { throw AudioInputPreparationError.accessDenied }
          // Provider URLs expire at callback return. Copy bounded bytes, never Data(contentsOf:).
          let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
          guard size > 0, Int64(size) <= self.maxSourceBytes else {
            throw AudioInputPreparationError.invalidSize
          }
          let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "MusicMutePhotoImport", isDirectory: true)
          try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
          guard
            let free = try root.resourceValues(forKeys: [
              .volumeAvailableCapacityForImportantUsageKey
            ]).volumeAvailableCapacityForImportantUsage,
            free >= Int64(size) + 16_000_000
          else { throw AudioInputPreparationError.storage }
          let directory = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
          try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
          let target = directory.appendingPathComponent(url.lastPathComponent)
          let input = try FileHandle(forReadingFrom: url)
          defer { try? input.close() }
          guard FileManager.default.createFile(atPath: target.path, contents: nil) else {
            throw AudioInputPreparationError.storage
          }
          do {
            let output = try FileHandle(forWritingTo: target)
            defer { try? output.close() }
            var bytes = 0
            while let data = try input.read(upToCount: 65_536), !data.isEmpty {
              bytes += data.count
              guard Int64(bytes) <= self.maxSourceBytes else {
                throw AudioInputPreparationError.invalidSize
              }
              try output.write(contentsOf: data)
            }
            guard bytes == size else { throw AudioInputPreparationError.unreadable }
            try output.synchronize()
            return target
          } catch {
            PreparedMediaCleanup.discardPhotoCopy(target)
            throw error
          }
        }
        DispatchQueue.main.async { self.deliver(outcome) }
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in
        guard let self, !self.delivered else { return }
        self.providerProgress?.cancel()
        self.deliver(.failure(AudioInputPreparationError.interrupted))
      }
    }
  }
}
