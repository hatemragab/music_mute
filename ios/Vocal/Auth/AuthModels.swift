import Foundation

enum ProviderID: String, Codable, CaseIterable, Identifiable, Sendable {
  case password
  case google = "google.com"
  case apple = "apple.com"

  var id: String { rawValue }
  var isUsableOnIOS: Bool { self == .password || self == .apple }
}

struct IdentitySnapshot: Equatable, Sendable {
  let uid: String
  let email: String?
  let emailVerified: Bool
  let providers: Set<ProviderID>
}

struct InstallationMetadata: Codable, Equatable, Sendable {
  let platform: String
  let appVersion: String
  let buildNumber: Int
  let metadataRevision: Int64
  let osVersion: String
  let deviceModel: String?
}

struct InstallationReport: Codable, Equatable, Sendable {
  let installationId: String
  let platform: String
  let appVersion: String
  let buildNumber: Int
  let metadataRevision: Int64
  let osVersion: String
  let deviceModel: String?

  var metadata: InstallationMetadata {
    InstallationMetadata(
      platform: platform, appVersion: appVersion, buildNumber: buildNumber,
      metadataRevision: metadataRevision, osVersion: osVersion, deviceModel: deviceModel)
  }
}

struct AccountProfile: Codable, Equatable, Sendable {
  let id: String
  let displayName: String
  let email: String?
  let emailVerified: Bool
  let providers: [ProviderID]
}

struct VersionTransition: Codable, Equatable, Sendable {
  let appVersion: String
  let buildNumber: Int
  let metadataRevision: Int64
  let observedAt: Date
}

struct RegisteredDevice: Codable, Equatable, Identifiable, Sendable {
  var id: String { installationId }
  let installationId: String
  let platform: String
  let appVersion: String
  let buildNumber: Int
  let metadataRevision: Int64
  let osVersion: String
  let deviceModel: String?
  let firstSeenAt: Date
  let lastSeenAt: Date
  let versionHistory: [VersionTransition]
  var sessionStatus: String? = nil
}

struct DevicePage: Codable, Equatable, Sendable {
  let items: [RegisteredDevice]
  let nextCursor: String?
}

struct PlatformPolicy: Codable, Equatable, Sendable {
  let minimumBuild: Int?
  let latestBuild: Int?
  let downloadUrl: URL?
}

struct PolicyPlatforms: Codable, Equatable, Sendable {
  let android: PlatformPolicy
  let ios: PlatformPolicy
}

struct AppPolicy: Codable, Equatable, Sendable {
  let requireVerifiedEmail: Bool
  let platforms: PolicyPlatforms
  let revision: Int64
  let updatedAt: Date
}

struct ProcessingAccess: Codable, Equatable, Sendable {
  let allowed: Bool
  let reason: String?
  let downloadUrl: URL?
}

struct SessionResponse: Codable, Equatable, Sendable {
  let user: AccountProfile
  let device: RegisteredDevice
  let policy: AppPolicy
  let access: ProcessingAccess
}

struct ProfileSyncResponse: Codable, Equatable, Sendable {
  let user: AccountProfile
  let policy: AppPolicy
}

struct AccountRecoveryRequest: Codable, Equatable, Sendable {
  let id: String
  let status: String
  let reason: String?
  let requestedAt: Date
  let reviewedAt: Date?
  let reviewReason: String?
  let revision: Int64
}

struct AccountRecoveryDeletion: Codable, Equatable, Sendable {
  let requestId: String
  let requestedAt: Date?
  let recoverUntil: Date?
  let phase: String?
  let failureCode: String?
  let recoveryAvailable: Bool
}

struct AccountRecoveryStatus: Codable, Equatable, Sendable {
  let accountStatus: String
  let deletion: AccountRecoveryDeletion?
  let request: AccountRecoveryRequest?
}

enum MailOutcome: String, Codable, Sendable {
  case accepted
  case alreadyVerified = "already_verified"
}

struct MailResponse: Codable, Sendable {
  let status: MailOutcome
}

enum AuthFailure: Error, Equatable, Sendable {
  case cancelled
  case invalidInput
  case invalidCredentials
  case weakPassword
  case accountDisabled
  case accountDeletionPending
  case accountRecoveryExpired
  case collision
  case providerAlreadyLinked
  case providerMissing
  case recentLoginRequired
  case offline
  case rateLimited(retryAt: Date)
  case profileSyncRequired
  case deviceConflict
  case serviceUnavailable
  case sessionExpired
  case configuration
  case malformedResponse
  case unknown

  var messageKey: LocalizedStringKeyName {
    switch self {
    case .cancelled: return "auth_cancelled"
    case .invalidInput: return "auth_invalid_input"
    case .invalidCredentials: return "auth_invalid_credentials"
    case .weakPassword: return "auth_weak_password"
    case .accountDisabled: return "auth_account_disabled"
    case .accountDeletionPending: return "auth_account_deletion_pending"
    case .accountRecoveryExpired: return "auth_account_recovery_expired"
    case .collision: return "auth_collision"
    case .providerAlreadyLinked: return "auth_provider_linked"
    case .providerMissing: return "auth_provider_missing"
    case .recentLoginRequired: return "auth_recent_login"
    case .offline: return "auth_offline"
    case .rateLimited: return "auth_rate_limited"
    case .profileSyncRequired: return "auth_profile_sync_required"
    case .deviceConflict: return "auth_device_conflict"
    case .serviceUnavailable: return "auth_service_unavailable"
    case .sessionExpired: return "auth_session_expired"
    case .configuration: return "auth_configuration"
    case .malformedResponse: return "auth_service_unavailable"
    case .unknown: return "auth_unknown_error"
    }
  }
}

typealias LocalizedStringKeyName = String

extension JSONDecoder {
  static func authDecoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let wholeSeconds = ISO8601DateFormatter()
    wholeSeconds.formatOptions = [.withInternetDateTime]
    decoder.dateDecodingStrategy = .custom { decoder in
      let container = try decoder.singleValueContainer()
      let value = try container.decode(String.self)
      guard let date = fractional.date(from: value) ?? wholeSeconds.date(from: value) else {
        throw DecodingError.dataCorruptedError(
          in: container, debugDescription: "Invalid ISO-8601 date")
      }
      return date
    }
    return decoder
  }
}
