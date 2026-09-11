import FirebaseCore
import FirebaseMessaging
import Foundation
import UIKit
import UserNotifications

func nativeProcessingPushTransportEnabled() -> Bool {
  #if targetEnvironment(simulator)
    return false
  #else
    return ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil
      && ProcessInfo.processInfo.environment["FIREBASE_AUTH_EMULATOR_HOST"] == nil
      && FirebaseApp.app()?.options.projectID?.hasPrefix("demo-") != true
  #endif
}

@MainActor func firebaseProcessingToken() async -> String? {
  guard nativeProcessingPushTransportEnabled(), Messaging.messaging().apnsToken != nil else {
    return nil
  }
  Messaging.messaging().isAutoInitEnabled = true
  // Firebase 12.18's register API returns an installation ID; this backend accepts FCM tokens.
  return try? await Messaging.messaging().token()
}

/// One retained UN/FCM delegate, installed after Firebase configuration. No second UIApplication delegate.
@MainActor
final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate, MessagingDelegate {
  private(set) static var active: NotificationDelegate?
  private let coordinator: PushRegistrationCoordinator
  private let transportEnabled: Bool

  init(
    coordinator: PushRegistrationCoordinator,
    transportEnabled: Bool = nativeProcessingPushTransportEnabled()
  ) {
    self.coordinator = coordinator
    self.transportEnabled = transportEnabled
    super.init()
  }

  func install() {
    Self.active = self
    UNUserNotificationCenter.current().delegate = self
    if transportEnabled { Messaging.messaging().delegate = self }
  }

  func refreshAuthorization() async {
    let settings = await UNUserNotificationCenter.current().notificationSettings()
    let granted =
      settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
    coordinator.permissionChanged(granted: granted)
    if granted && transportEnabled { UIApplication.shared.registerForRemoteNotifications() }
    coordinator.foreground()
  }

  /// Invoke from a contextual user action; permission is never required to use processing.
  func requestPermission() async {
    guard transportEnabled else { return }
    _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [
      .alert, .sound, .badge,
    ])
    await refreshAuthorization()
  }

  func didRegisterAPNsToken(_ data: Data) {
    guard transportEnabled, !data.isEmpty else { return }
    // FirebaseAppDelegateProxyEnabled is NO: forwarding happens only here.
    Messaging.messaging().apnsToken = data
    coordinator.apnsTokenReady()
  }

  func didFailAPNsRegistration() { coordinator.apnsRegistrationFailed() }

  func receiveForeground(_ userInfo: [AnyHashable: Any]) -> UNNotificationPresentationOptions {
    coordinator.receivedMessage(userInfo)
    return []
  }

  nonisolated func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?)
  {
    Task { @MainActor [weak self] in self?.coordinator.receivedFCMToken(fcmToken) }
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    let hint = processingJobHint(notification.request.content.userInfo)
    await MainActor.run { [weak self] in if let hint { self?.coordinator.receivedMessage(hint) } }
    return []  // Never duplicate the backend's visible notification with a local/foreground alert.
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse
  ) async {
    guard response.actionIdentifier != UNNotificationDismissActionIdentifier,
      let hint = processingJobHint(response.notification.request.content.userInfo)
    else { return }
    await MainActor.run { [weak self] in self?.coordinator.rememberTap(hint) }
  }
}
