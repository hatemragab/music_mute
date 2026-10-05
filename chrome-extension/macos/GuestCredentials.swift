import Foundation
import Security

// A narrow stdin/stdout bridge keeps the guest bearer out of argv, cache files,
// diagnostics and the account credential namespace.
struct GuestCredential: Codable {
  let token: String
  let expiresAt: String

  enum CodingKeys: String, CodingKey {
    case token
    case expiresAt = "expires_at"
  }

  var valid: Bool {
    let date = ISO8601DateFormatter()
    date.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return token.range(of: "^[A-Za-z0-9_-]{43,128}\\z", options: .regularExpression) != nil
      && expiresAt.count <= 40
      && (date.date(from: expiresAt) != nil
        || ISO8601DateFormatter().date(from: expiresAt) != nil)
  }
}
struct GuestCredentialCommand: Decodable {
  let operation: String
  let credential: GuestCredential?
}

@main enum GuestCredentials {
  static func main() {
    do {
      var data = Data()
      while let chunk = try FileHandle.standardInput.read(upToCount: 4097 - data.count),
        !chunk.isEmpty
      {
        data.append(chunk)
        if data.count > 4096 { throw Failure.invalid }
      }
      guard CommandLine.arguments.count == 1,
        data.count <= 4096,
        let command = try? JSONDecoder().decode(GuestCredentialCommand.self, from: data),
        ["load", "save", "validate"].contains(command.operation)
      else { throw Failure.invalid }
      var query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.hatem.musicmute.local.youtube-guest",
        kSecAttrAccount as String: "youtube-guest-session",
        kSecAttrSynchronizable as String: false,
      ]
      switch command.operation {
      case "save", "validate":
        guard let credential = command.credential, credential.valid else { throw Failure.invalid }
        if command.operation == "save" {
          let attributes: [String: Any] = [
            kSecValueData as String: try JSONEncoder().encode(credential),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
          ]
          let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
          if status == errSecItemNotFound {
            guard
              SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
                == errSecSuccess
            else { throw Failure.unavailable }
          } else if status != errSecSuccess {
            throw Failure.unavailable
          }
        }
        FileHandle.standardOutput.write(Data("null\n".utf8))
      default:
        guard command.credential == nil else { throw Failure.invalid }
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
          FileHandle.standardOutput.write(Data("null\n".utf8))
          return
        }
        guard status == errSecSuccess, let data = result as? Data, data.count <= 4096,
          let credential = try? JSONDecoder().decode(GuestCredential.self, from: data),
          credential.valid
        else { throw Failure.unavailable }
        FileHandle.standardOutput.write(try JSONEncoder().encode(credential))
      }
    } catch {
      FileHandle.standardError.write(Data("GUEST_CREDENTIALS_UNAVAILABLE\n".utf8))
      exit(1)
    }
  }
  enum Failure: Error { case invalid, unavailable }
}
