import SwiftUI
import UIKit

struct ProcessedAudioShareSheet: UIViewControllerRepresentable {
  let file: URL
  let completion: () -> Void

  func makeUIViewController(context: Context) -> UIActivityViewController {
    let controller = UIActivityViewController(activityItems: [file], applicationActivities: nil)
    controller.view.accessibilityIdentifier = "processedAudioShareSheet"
    controller.completionWithItemsHandler = { _, _, _, _ in completion() }
    return controller
  }

  func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
