import Foundation

enum URLImportFailure: Error, Equatable {
  case invalidURL, unsupportedSite, singleItemRequired
  case server(String)

  var messageKey: String {
    switch self {
    case .invalidURL: return "url_import_invalid"
    case .unsupportedSite: return "url_import_unsupported"
    case .singleItemRequired: return "url_import_single"
    case .server(let code):
      switch code {
      case "IMPORT_UNSUPPORTED_PROVIDER", "IMPORT_UNSUPPORTED_AUDIO_SOURCE":
        return "url_import_unsupported"
      case "IMPORT_INVALID_URL": return "url_import_invalid"
      case "IMPORT_SINGLE_ITEM_REQUIRED": return "url_import_single"
      case "IMPORT_TOO_LARGE", "IMPORT_TOO_LONG", "IMPORT_INVALID_AUDIO":
        return "processing_error_input"
      case "IMPORT_QUEUE_FULL": return "processing_error_rate"
      default: return "url_import_failed"
      }
    }
  }
}

enum SupportedAudioSites {
  private struct Catalog: Decodable {
    let schemaVersion: Int
    let blockedQueryKeys: [String]
    let sites: [Site]
  }
  private struct Site: Decodable {
    let name: String
    let rules: [Rule]
  }
  private struct Rule: Decodable {
    let host: String
    let path: String
    let requiredQuery: [String: String]
  }
  private static let catalog: Catalog? = {
    guard let url = Bundle.main.url(forResource: "supported-audio-sites", withExtension: "json"),
      let data = try? Data(contentsOf: url),
      let result = try? JSONDecoder().decode(Catalog.self, from: data), result.schemaVersion == 1
    else { return nil }
    return result
  }()
  static var names: [String] { catalog?.sites.map(\.name) ?? [] }
  private static func matches(_ pattern: String, _ value: String) -> Bool {
    value.range(of: "^(?:\(pattern))$", options: .regularExpression) != nil
  }

  /// Validate locally before token refresh, durable submission or any network request.
  static func canonical(_ raw: String) throws -> String {
    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard (1...2048).contains(value.utf16.count),
      value.unicodeScalars.allSatisfy({ (33...126).contains($0.value) && $0.value != 92 }),
      matches(#"(?i:https?)://[a-zA-Z0-9.-]+(?:/[^?#]*)?(?:\?[^#]*)?"#, value),
      value.range(of: #"%(?![a-fA-F0-9]{2})"#, options: .regularExpression) == nil,
      let parts = URLComponents(string: value), let scheme = parts.scheme?.lowercased(),
      let host = parts.host?.lowercased(), parts.port == nil, parts.user == nil,
      parts.password == nil, parts.fragment == nil
    else { throw URLImportFailure.invalidURL }
    let path = parts.percentEncodedPath.isEmpty ? "/" : parts.percentEncodedPath
    guard
      path.range(
        of: #"(?:^|/)\.{1,2}(?:/|$)|%(?:2e|2f|5c|0[0-9a-f]|1[0-9a-f]|7f)"#,
        options: [.regularExpression, .caseInsensitive]) == nil
    else { throw URLImportFailure.invalidURL }
    var query: [String: String] = [:]
    for pair in (parts.percentEncodedQuery ?? "").split(separator: "&") {
      let values = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
      guard
        let name = String(values[0]).replacingOccurrences(of: "+", with: " ")
          .removingPercentEncoding,
        let content = (values.count > 1 ? String(values[1]) : "")
          .replacingOccurrences(of: "+", with: " ").removingPercentEncoding,
        query[name] == nil,
        (name + content).unicodeScalars.allSatisfy({ $0.value >= 32 && $0.value != 127 })
      else { throw URLImportFailure.invalidURL }
      query[name] = content
    }
    guard let catalog else { throw URLImportFailure.unsupportedSite }
    if catalog.blockedQueryKeys.contains(where: { query[$0] != nil }) {
      throw URLImportFailure.singleItemRequired
    }
    guard
      catalog.sites.contains(where: { site in
        site.rules.contains { rule in
          matches(rule.host, host) && matches(rule.path, path)
            && rule.requiredQuery.allSatisfy { matches($0.value, query[$0.key] ?? "") }
        }
      })
    else { throw URLImportFailure.unsupportedSite }
    return "\(scheme)://\(host)\(path)" + (parts.percentEncodedQuery.map { "?\($0)" } ?? "")
  }
}
