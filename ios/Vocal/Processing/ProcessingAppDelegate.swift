import UIKit

final class ProcessingAppDelegate: NSObject, UIApplicationDelegate {
  func application(
    _ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    NotificationDelegate.active?.didRegisterAPNsToken(deviceToken)
  }

  func application(
    _ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    NotificationDelegate.active?.didFailAPNsRegistration()
  }

  func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    if BackgroundSourceTransferCoordinator.shared.handleBackgroundEvents(
      identifier: identifier, completionHandler: completionHandler)
    {
      return
    }
    if !BackgroundTransferCoordinator.shared.handleBackgroundEvents(
      identifier: identifier, completionHandler: completionHandler)
    {
      completionHandler()
    }
  }
}
