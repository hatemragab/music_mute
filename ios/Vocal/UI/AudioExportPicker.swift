import SwiftUI
import UIKit

struct AudioExportPicker: UIViewControllerRepresentable {
  let file: URL
  let completed: (Bool) -> Void
  func makeCoordinator() -> Coordinator { Coordinator(completed: completed) }
  func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
    let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
    picker.directoryURL =
      FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
    picker.delegate = context.coordinator
    return picker
  }
  func updateUIViewController(_ uiViewController: UIDocumentPickerViewController, context: Context)
  {}
  final class Coordinator: NSObject, UIDocumentPickerDelegate {
    let completed: (Bool) -> Void
    init(completed: @escaping (Bool) -> Void) { self.completed = completed }
    func documentPicker(
      _ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]
    ) { completed(!urls.isEmpty) }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
      completed(false)
    }
  }
}
