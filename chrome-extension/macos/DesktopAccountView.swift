import Foundation
import SwiftUI

struct DesktopAccountView: View {
  @ObservedObject var account: DesktopAccountModel
  @ObservedObject var workspace: DesktopWorkspace
  @State private var mode = "Sign in"
  @State private var name = ""
  @State private var email = ""
  @State private var password = ""
  @State private var confirmation = ""
  @State private var securityPassword = ""
  @State private var newPassword = ""
  @State private var confirmNewPassword = ""
  @State private var confirmLogoutAll = false
  @State private var confirmDeletion = false
  @State private var selectedProvider: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      if let failure = account.failure {
        Label(LocalizedStringKey(failure.message), systemImage: "exclamationmark.circle")
          .foregroundStyle(Brand.amber)
          .textSelection(.enabled).accessibilityIdentifier("account_error")
      }
      if let notice = account.notice {
        Label(LocalizedStringKey(notice), systemImage: "info.circle").foregroundStyle(
          Brand.secondary
        )
        .textSelection(.enabled).accessibilityIdentifier("account_notice")
      }
      if account.restoring {
        ProgressView("Restoring your saved account…")
          .accessibilityIdentifier("account_restoring")
        Text("If macOS asks, allow MusicMute to access your saved sign-in.")
          .desktopFont(.caption).foregroundStyle(Brand.secondary)
      } else {
        if account.signedIn { signedIn } else { signIn }
      }
      if account.busy && !account.restoring {
        ProgressView("Working securely…").accessibilityIdentifier("account_loading")
      }
    }
    .disabled(account.busy || account.restoring)
    .overlay(alignment: .bottomTrailing) {
      if account.busy && account.googleSignInActive {
        Button("Cancel Google sign-in") { account.cancelSignIn() }.buttonStyle(.bordered).disabled(
          false)
      }
    }
    .confirmationDialog("Sign out on every device?", isPresented: $confirmLogoutAll) {
      Button("Sign out everywhere", role: .destructive) { Task { await account.logout(all: true) } }
    } message: {
      Text("Every MusicMute account session will be revoked. This Mac will pause account uploads.")
    }
    .confirmationDialog("Request account deletion?", isPresented: $confirmDeletion) {
      Button("Request deletion", role: .destructive) {
        let value = securityPassword
        securityPassword = ""
        Task { await account.deleteAccount(password: value) }
      }
    } message: {
      Text(
        "Your account enters the server’s recovery period. Account records, access, and private file media follow the deletion policy. Video-link artifacts already contributed to the shared cache remain available for reuse."
      )
    }
  }
  private var signIn: some View {
    VStack(alignment: .leading, spacing: 16) {
      Label("ONE ACCOUNT, YOUR VOICE LIBRARY", systemImage: "person.crop.circle").desktopFont(
        .caption, weight: .semibold
      )
      .foregroundStyle(Brand.accent)
      Text("Listen on your Mac and mobile").desktopFont(.title2, weight: .semibold)
      Text(
        "Processing runs on this Mac by default. Signing in lets MusicMute save your original and voice-only audio to your account in the background."
      )
      .foregroundStyle(Brand.secondary).fixedSize(horizontal: false, vertical: true)
      if account.configuration == nil {
        Label(
          "Account setup is required for this build. Local YouTube processing is available in Chrome.",
          systemImage: "gear.badge.questionmark"
        )
        .foregroundStyle(Brand.amber).accessibilityIdentifier("account_configuration_required")
      }
      Picker("Account action", selection: $mode) {
        ForEach(["Sign in", "Create account", "Reset password"], id: \.self) {
          Text(LocalizedStringKey($0))
        }
      }.pickerStyle(.segmented).accessibilityIdentifier("auth_mode")
      VStack(spacing: 12) {
        if mode == "Create account" {
          TextField("Full name", text: $name).textContentType(.name).accessibilityIdentifier(
            "auth_name")
        }
        TextField("Email", text: $email).textContentType(.emailAddress).accessibilityIdentifier(
          "auth_email")
        if mode != "Reset password" {
          SecureField("Password", text: $password).textContentType(
            mode == "Create account" ? .newPassword : .password
          )
          .accessibilityIdentifier("auth_password")
        }
        if mode == "Create account" {
          SecureField("Confirm password", text: $confirmation).textContentType(.newPassword)
            .accessibilityIdentifier("auth_confirmation")
        }
      }.textFieldStyle(.roundedBorder)
      TimelineView(.periodic(from: .now, by: 1)) { context in
        let cooldown = max(0, Int(ceil(account.resetRetryAt?.timeIntervalSince(context.date) ?? 0)))
        Button(
          LocalizedStringKey(
            mode == "Reset password"
              ? cooldown > 0 ? "Try again in \(cooldown)s" : "Send reset link" : mode
          )
        ) {
          let suppliedPassword = password
          let suppliedConfirmation = confirmation
          password = ""
          confirmation = ""
          Task {
            if mode == "Create account" {
              await account.register(
                name: name, email: email, password: suppliedPassword,
                confirmation: suppliedConfirmation)
            } else if mode == "Reset password" {
              await account.resetPassword(email: email)
            } else {
              await account.signIn(email: email, password: suppliedPassword)
            }
          }
        }.buttonStyle(.borderedProminent).tint(Brand.accent)
          .disabled(
            account.configuration == nil || email.isEmpty
              || (mode != "Reset password" && password.isEmpty)
              || (mode == "Reset password" && cooldown > 0)
          )
          .accessibilityIdentifier("auth_submit")
      }
      if mode != "Reset password" {
        Button {
          Task { await account.signInGoogle() }
        } label: {
          GoogleSignInLabel("Continue with Google")
        }.buttonStyle(.bordered).disabled(!account.googleConfigured).accessibilityIdentifier(
          "auth_google")
        if !account.googleConfigured {
          Text("Google sign-in needs this build's registered desktop OAuth client.").desktopFont(
            .caption
          )
          .foregroundStyle(Brand.secondary)
        }
      }
      Text("Credentials stay in macOS Keychain. Diagnostics stay on this Mac.").desktopFont(
        .caption
      )
      .foregroundStyle(Brand.secondary)
    }.padding(24).background(Brand.surface, in: RoundedRectangle(cornerRadius: 20)).frame(
      maxWidth: 620, alignment: .leading)
  }
  private var signedIn: some View {
    VStack(alignment: .leading, spacing: 20) {
      accountProfileCard
      DesktopUsageView(workspace: workspace)
      if account.user?.emailVerified == false
        || account.access["reason"].string.map(safeIdentifier) == true
      {
        VStack(alignment: .leading, spacing: 12) {
          if account.user?.emailVerified == false {
            Label(
              "Verify your email to enable account processing and transfers.",
              systemImage: "envelope.badge"
            )
            .foregroundStyle(Brand.amber)
            ViewThatFits(in: .horizontal) {
              HStack {
                verificationActions
              }
              VStack(alignment: .leading) {
                verificationActions
              }
            }
            .buttonStyle(.bordered)
          }
          if let reason = account.access["reason"].string, safeIdentifier(reason) {
            Label(
              "Cloud access: \(reason.replacingOccurrences(of: "_", with: " ").lowercased())",
              systemImage: "exclamationmark.cloud"
            )
            .desktopFont(.callout).foregroundStyle(Brand.amber)
          }
        }
        .padding(18)
        .background(Brand.raised, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Brand.border))
        .accessibilityIdentifier("account_attention")
      }
      GroupBox("Sign-in methods") {
        VStack(alignment: .leading, spacing: 12) {
          ForEach(account.user?.providers ?? [], id: \.self) { provider in
            HStack {
              Label(
                provider == "google.com"
                  ? "Google" : provider == "password" ? "Email and password" : provider,
                systemImage: "checkmark.shield")
              Spacer()
              if (account.user?.providers.count ?? 0) > 1 {
                Button("Unlink") { selectedProvider = provider }.disabled(!canReauthenticate)
              }
            }
          }
          SecureField("Current password for security changes", text: $securityPassword)
            .textContentType(.password)
          if account.user?.providers.contains("google.com") == true {
            Text("Leave the password empty to confirm security changes with Google.").desktopFont(
              .caption
            )
            .foregroundStyle(Brand.secondary)
          }
          if account.user?.providers.contains("google.com") == false {
            Button {
              Task { await account.signInGoogle(link: true) }
            } label: {
              GoogleSignInLabel("Link Google")
            }
            .disabled(!account.googleConfigured)
          }
          if account.user?.providers.contains("password") == false {
            SecureField("Add password", text: $newPassword).textContentType(.newPassword)
            SecureField("Confirm password", text: $confirmNewPassword).textContentType(.newPassword)
            Button("Add email sign-in") {
              let value = newPassword
              let confirmation = confirmNewPassword
              newPassword = ""
              confirmNewPassword = ""
              Task { await account.linkPassword(value, confirmation: confirmation) }
            }.disabled(newPassword.count < 6 || newPassword != confirmNewPassword)
          }
        }.padding(12).textFieldStyle(.roundedBorder)
      }
      .confirmationDialog(
        "Remove this sign-in method?",
        isPresented: Binding(
          get: { selectedProvider != nil }, set: { if !$0 { selectedProvider = nil } })
      ) {
        if let provider = selectedProvider {
          Button("Unlink method", role: .destructive) {
            let value = securityPassword
            securityPassword = ""
            selectedProvider = nil
            Task { await account.unlink(provider, password: value) }
          }
        }
      } message: {
        Text("Your other sign-in method remains available.")
      }
      GroupBox("Devices") {
        VStack(alignment: .leading, spacing: 12) {
          Button("View device history") { Task { await account.loadAccountDetails() } }
          ForEach(Array(account.devices.enumerated()), id: \.offset) { _, device in
            HStack {
              VStack(alignment: .leading) {
                Text(device["device_model"].string ?? device["platform"].string ?? "Device")
                Text(device["last_seen_at"].string ?? "").desktopFont(.caption).foregroundStyle(
                  Brand.secondary)
              }
              Spacer()
              if let id = device["installation_id"].string, id != account.installationId {
                Button("Hide from history") { Task { await account.hideDevice(id) } }
              } else {
                Text("This Mac").desktopFont(.caption).foregroundStyle(Brand.accent)
              }
            }
          }
        }.padding(12)
      }
      GroupBox("Account security") {
        VStack(alignment: .leading, spacing: 12) {
          HStack {
            Button("Sign out on this Mac") { Task { await account.logout() } }
            Button("Sign out everywhere") { confirmLogoutAll = true }
          }
          Button("Check account recovery") { Task { await account.loadRecovery() } }
          if let status = account.recovery["account_status"].string {
            Text("Account status: \(status)").foregroundStyle(Brand.secondary)
          }
          if account.recovery["deletion"]["recovery_available"].bool == true {
            Button("Request recovery") { Task { await account.requestRecovery() } }.buttonStyle(
              .bordered)
          }
          Button("Delete account", role: .destructive) { confirmDeletion = true }.disabled(
            !canReauthenticate || account.deletionPending)
          Text(
            "Security changes require recent sign-in. The server controls deletion and recovery eligibility."
          ).desktopFont(.caption).foregroundStyle(Brand.secondary)
        }.padding(12)
      }
    }.frame(maxWidth: 900, alignment: .leading)
  }
  private var accountProfileCard: some View {
    ViewThatFits(in: .horizontal) {
      HStack(alignment: .center, spacing: 18) {
        accountAvatar
        accountIdentity
        Spacer(minLength: 24)
        connectionControls
      }
      VStack(alignment: .leading, spacing: 18) {
        ViewThatFits(in: .horizontal) {
          HStack(alignment: .center, spacing: 16) {
            accountAvatar
            accountIdentity
          }
          VStack(alignment: .leading, spacing: 12) {
            accountAvatar
            accountIdentity
          }
        }
        connectionControls
      }
    }
    .padding(22)
    .background(
      LinearGradient(
        colors: [Brand.accent.opacity(0.11), Brand.surface],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
      ),
      in: RoundedRectangle(cornerRadius: 20, style: .continuous)
    )
    .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Brand.border))
    .accessibilityIdentifier("account_profile_card")
  }
  private var accountAvatar: some View {
    Text(
      DesktopAccountPresentation.initials(
        name: account.user?.displayName,
        email: account.user?.email
      )
    )
    .desktopFont(.title2, weight: .semibold)
    .foregroundStyle(Brand.accent)
    .frame(width: 58, height: 58)
    .background(Brand.accent.opacity(0.13), in: Circle())
    .overlay(Circle().stroke(Brand.accent.opacity(0.28)))
    .accessibilityHidden(true)
  }
  private var accountIdentity: some View {
    VStack(alignment: .leading, spacing: 5) {
      accountDisplayName
        .desktopFont(.title2, weight: .semibold)
        .fixedSize(horizontal: false, vertical: true)
      accountEmail
        .desktopFont(.callout)
        .foregroundStyle(Brand.secondary)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
    }
  }
  private var accountDisplayName: Text {
    let value = account.user?.displayName.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return value.isEmpty ? Text("MusicMute account") : Text(verbatim: value)
  }
  private var accountEmail: Text {
    guard let value = account.user?.email?.trimmingCharacters(in: .whitespacesAndNewlines),
      !value.isEmpty
    else { return Text("Signed-in account") }
    return Text(verbatim: value)
  }
  private var connectionControls: some View {
    VStack(alignment: .leading, spacing: 9) {
      Label(
        LocalizedStringKey(account.online ? "Account connected" : "Account reconnecting"),
        systemImage: account.online ? "checkmark.circle.fill" : "arrow.triangle.2.circlepath"
      )
      .desktopFont(.callout, weight: .semibold)
      .foregroundStyle(account.online ? Brand.mint : Brand.amber)
      .accessibilityIdentifier("account_connection_status")
      if !account.online {
        Text("Local playback stays available while MusicMute reconnects.")
          .desktopFont(.caption)
          .foregroundStyle(Brand.secondary)
          .fixedSize(horizontal: false, vertical: true)
        Button("Reconnect account") { Task { await account.reconnect() } }
          .buttonStyle(.bordered)
          .accessibilityIdentifier("account_reconnect")
      }
      SettingsLink {
        Label("Theme & Text", systemImage: "paintbrush")
      }
      .buttonStyle(.bordered)
      .accessibilityIdentifier("account_theme_settings")
    }
  }
  @ViewBuilder private var verificationActions: some View {
    TimelineView(.periodic(from: .now, by: 1)) { context in
      let cooldown = max(
        0, Int(ceil(account.verificationRetryAt?.timeIntervalSince(context.date) ?? 0)))
      Button {
        Task { await account.sendVerification() }
      } label: {
        if cooldown > 0 {
          Text("Resend in \(cooldown)s")
        } else {
          Text("Send verification email")
        }
      }
      .disabled(cooldown > 0)
    }
    Button("I verified my email") { Task { await account.recheckVerification() } }
  }
  private var canReauthenticate: Bool {
    !securityPassword.isEmpty
      || (account.googleConfigured && account.user?.providers.contains("google.com") == true)
  }
}

struct GoogleSignInLabel: View {
  let title: LocalizedStringKey

  init(_ title: LocalizedStringKey) {
    self.title = title
  }

  var body: some View {
    HStack(spacing: 8) {
      GoogleGMark()
      Text(title)
    }
  }
}

private struct GoogleGMark: View {
  private static let image: NSImage? = {
    guard let url = Bundle.main.url(forResource: "GoogleG", withExtension: "svg") else {
      return nil
    }
    return NSImage(contentsOf: url)
  }()

  var body: some View {
    Group {
      if let image = Self.image {
        Image(nsImage: image)
          .resizable()
          .interpolation(.high)
          .renderingMode(.original)
      } else {
        Image(systemName: "g.circle.fill")
          .resizable()
          .foregroundStyle(.primary)
      }
    }
    .frame(width: 18, height: 18)
    .accessibilityHidden(true)
  }
}

struct DesktopAccountPresentation {
  static func initials(name: String?, email: String?) -> String {
    let trimmedName = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let emailName = email?.split(separator: "@", maxSplits: 1).first.map(String.init) ?? ""
    let source = trimmedName.isEmpty ? emailName : trimmedName
    let words = source.split(whereSeparator: { $0.isWhitespace })
    if let first = words.first?.first {
      let last = words.count > 1 ? words.last?.first : words.first?.dropFirst().first
      return ([first] + (last.map { [$0] } ?? [])).map(String.init).joined().uppercased()
    }
    return "M"
  }
}

struct DesktopUsageAmount: Equatable, Sendable {
  let used: Int64
  let remaining: Int64
  let limit: Int64

  var progressFraction: Double {
    guard limit > 0 else { return used > 0 ? 1 : 0 }
    return min(1, Double(used) / Double(limit))
  }
}

struct DesktopUsagePresentation: Equatable, Sendable {
  static let maximumSafeInteger: Double = 9_007_199_254_740_991

  let processing: DesktopUsageAmount
  let resetAt: Date

  static func parse(_ value: DesktopJSON) -> Self? {
    guard
      let processing = processingAmount(value["processing"]),
      let reset = value["period"]["next_reset_at"].string.flatMap(rfc3339Date)
    else { return nil }
    return Self(processing: processing, resetAt: reset)
  }

  static func nonnegativeSafeInteger(_ value: DesktopJSON) -> Int64? {
    guard case .number(let number) = value, number.isFinite, number >= 0,
      number <= maximumSafeInteger, number.rounded(.towardZero) == number
    else { return nil }
    return Int64(number)
  }

  static func rfc3339Date(_ value: String) -> Date? {
    guard value.utf8.count >= 20, value.utf8.count <= 40,
      value.unicodeScalars.allSatisfy(\.isASCII),
      value.range(
        of: #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$"#,
        options: .regularExpression) != nil
    else { return nil }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions =
      value.contains(".")
      ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
    guard let date = formatter.date(from: value),
      let lowerBound = DateComponents(
        calendar: Calendar(identifier: .gregorian), timeZone: TimeZone(secondsFromGMT: 0),
        year: 2000, month: 1, day: 1
      ).date,
      let upperBound = DateComponents(
        calendar: Calendar(identifier: .gregorian), timeZone: TimeZone(secondsFromGMT: 0),
        year: 2101, month: 1, day: 1
      ).date,
      date >= lowerBound, date < upperBound
    else { return nil }
    return date
  }

  static func countLabel(_ value: Int64, locale: Locale) -> String {
    let formatter = NumberFormatter()
    formatter.locale = locale
    formatter.numberStyle = .decimal
    formatter.maximumFractionDigits = 0
    formatter.usesGroupingSeparator = true
    return formatter.string(from: NSNumber(value: value)) ?? String(value)
  }

  static func byteLabel(_ value: Int64, locale: Locale) -> String {
    value.formatted(
      .byteCount(
        style: .file,
        allowedUnits: .all,
        spellsOutZero: false,
        includesActualByteCount: false
      )
      .locale(locale))
  }

  static func durationLabel(seconds: Int64, locale: Locale) -> String {
    if seconds > Int64(UInt32.max) {
      let numberFormatter = NumberFormatter()
      numberFormatter.locale = locale
      numberFormatter.numberStyle = .decimal
      numberFormatter.maximumFractionDigits = 0
      let formatter = MeasurementFormatter()
      formatter.locale = locale
      formatter.unitOptions = .providedUnit
      formatter.unitStyle = .short
      formatter.numberFormatter = numberFormatter
      return formatter.string(
        from: Measurement(value: Double(seconds / 3_600), unit: UnitDuration.hours))
    }
    let formatter = DateComponentsFormatter()
    formatter.unitsStyle = .abbreviated
    formatter.maximumUnitCount = 2
    formatter.allowedUnits =
      seconds >= 3_600 ? [.hour, .minute] : seconds >= 60 ? [.minute, .second] : [.second]
    var calendar = Calendar(identifier: .gregorian)
    calendar.locale = locale
    formatter.calendar = calendar
    return formatter.string(from: TimeInterval(seconds)) ?? countLabel(seconds, locale: locale)
  }

  static func resetLabel(
    _ date: Date, locale: Locale, timeZone: TimeZone = .autoupdatingCurrent
  ) -> String {
    date.formatted(
      Date.FormatStyle(
        date: .abbreviated, time: .shortened, locale: locale, timeZone: timeZone))
  }

  private static func processingAmount(_ object: DesktopJSON) -> DesktopUsageAmount? {
    guard let used = nonnegativeSafeInteger(object["used_seconds"]),
      let reserved = nonnegativeSafeInteger(object["reserved_seconds"]),
      nonnegativeSafeInteger(object["released_seconds"]) != nil,
      let remaining = nonnegativeSafeInteger(object["remaining_seconds"]),
      let limit = nonnegativeSafeInteger(object["limit_seconds"]),
      remaining == max(0, limit - used - reserved)
    else { return nil }
    return DesktopUsageAmount(used: used, remaining: remaining, limit: limit)
  }
}

private struct DesktopUsageView: View {
  @ObservedObject var workspace: DesktopWorkspace

  var body: some View {
    VStack(alignment: .leading, spacing: 22) {
      Text("Usage").desktopFont(.title2, weight: .semibold)
      if workspace.usage == .null {
        emptyState
      } else if let presentation = DesktopUsagePresentation.parse(workspace.usage) {
        DesktopProcessingUsageView(
          amount: presentation.processing,
          resetAt: presentation.resetAt
        )
        if !workspace.cloudConnected {
          Label("Reconnecting to your live allowance…", systemImage: "arrow.clockwise")
            .desktopFont(.caption)
            .foregroundStyle(Brand.amber)
            .accessibilityIdentifier("allowance_reconnecting")
        }
      } else {
        Label(
          "Allowance details are temporarily unavailable.", systemImage: "exclamationmark.shield"
        )
        .desktopFont(.callout)
        .foregroundStyle(Brand.amber)
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Brand.amber.opacity(0.07), in: RoundedRectangle(cornerRadius: 14))
        .accessibilityIdentifier("allowance_invalid")
      }
    }
    .padding(24)
    .background(Brand.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Brand.border))
    .accessibilityIdentifier("account_allowance")
  }

  private var emptyState: some View {
    HStack(spacing: 12) {
      if workspace.cloudConnected { ProgressView().controlSize(.small) }
      Image(systemName: workspace.cloudConnected ? "clock" : "arrow.clockwise")
        .foregroundStyle(workspace.cloudConnected ? Brand.secondary : Brand.amber)
        .accessibilityHidden(true)
      Group {
        if workspace.cloudConnected {
          Text("Waiting for your account allowance…")
        } else {
          Text("Reconnecting to your live allowance…")
        }
      }
      .foregroundStyle(Brand.secondary)
    }
    .padding(16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Brand.raised, in: RoundedRectangle(cornerRadius: 14))
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("allowance_waiting")
  }
}

private struct DesktopProcessingUsageView: View {
  @Environment(\.locale) private var locale

  let amount: DesktopUsageAmount
  let resetAt: Date

  var body: some View {
    let used = DesktopUsagePresentation.countLabel(amount.used, locale: locale)
    let limit = DesktopUsagePresentation.countLabel(amount.limit, locale: locale)
    let remaining = DesktopUsagePresentation.countLabel(amount.remaining, locale: locale)
    let reset = DesktopUsagePresentation.resetLabel(resetAt, locale: locale)

    VStack(alignment: .leading, spacing: 12) {
      Text("Processing: \(used) / \(limit) seconds")
        .desktopFont(.body, weight: .semibold)
        .fixedSize(horizontal: false, vertical: true)
      DesktopUsageProgressBar(value: amount.progressFraction)
      Text("\(remaining) seconds · \(reset)")
        .desktopFont(.body)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Text("Cloud processing"))
    .accessibilityValue(
      Text(
        "\(used) of \(limit) seconds used. \(remaining) seconds remaining. Resets \(reset)."
      )
    )
    .accessibilityIdentifier("allowance_processing")
  }
}

private struct DesktopUsageProgressBar: View {
  let value: Double

  var body: some View {
    GeometryReader { geometry in
      ZStack(alignment: .leading) {
        Capsule().fill(Brand.secondary.opacity(0.28))
        Capsule()
          .fill(Brand.accent)
          .frame(width: geometry.size.width * min(1, max(0, value)))
      }
    }
    .frame(height: 8)
    .accessibilityHidden(true)
  }
}
