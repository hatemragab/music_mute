import Foundation
import Sentry

enum SentryMonitoring {
  static func start() {
    let bundle = Bundle.main
    guard bundle.object(forInfoDictionaryKey: "MusicMuteSentryEnabled") as? String == "YES",
      let dsn = bundle.object(forInfoDictionaryKey: "MusicMuteSentryDSN") as? String,
      let url = URL(string: dsn), url.scheme == "https", url.host != nil,
      url.user != nil
    else { return }

    SentrySDK.start { options in
      options.dsn = dsn
      options.environment = "production"
      let version =
        bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
      let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
      options.releaseName = "musicmute-ios@\(version)"
      options.dist = build
      options.maxBreadcrumbs = 0
      options.tracesSampleRate = 0
      options.sendDefaultPii = false
      options.attachScreenshot = false
      options.attachViewHierarchy = false
      options.enableAutoSessionTracking = false
      options.beforeSend = { event in
        event.user = nil
        event.request = nil
        event.breadcrumbs = []
        event.extra = [:]
        event.context = [:]
        event.tags = ["component": "ios"]
        event.message = nil
        if let exceptions = event.exceptions {
          for exception in exceptions {
            exception.value = "Application failure"
          }
        }
        return event
      }
    }
  }
}
