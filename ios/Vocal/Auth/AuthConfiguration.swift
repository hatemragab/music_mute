import Foundation

struct AuthConfiguration: Sendable {
  let apiOrigin: URL

  static func load(bundle: Bundle = .main) throws -> AuthConfiguration {
    guard
      let raw = bundle.object(forInfoDictionaryKey: "MusicMuteAPIBaseURL") as? String,
      !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      let url = URL(string: raw),
      let scheme = url.scheme?.lowercased(),
      url.host != nil,
      url.user == nil,
      url.password == nil,
      url.query == nil,
      url.fragment == nil,
      url.path.isEmpty || url.path == "/"
    else { throw AuthFailure.configuration }

    #if DEBUG
      let isLoopback = url.host == "localhost" || url.host == "127.0.0.1" || url.host == "::1"
      guard scheme == "https" || (scheme == "http" && isLoopback) else {
        throw AuthFailure.configuration
      }
    #else
      guard scheme == "https" else { throw AuthFailure.configuration }
    #endif

    var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    components?.path = ""
    guard let origin = components?.url else { throw AuthFailure.configuration }
    return AuthConfiguration(apiOrigin: origin)
  }

  func endpoint(_ path: String) throws -> URL {
    guard path.hasPrefix("/"),
      let url = URL(string: path, relativeTo: apiOrigin)?.absoluteURL,
      url.scheme == apiOrigin.scheme, url.host == apiOrigin.host, url.port == apiOrigin.port
    else { throw AuthFailure.configuration }
    return url
  }
}
