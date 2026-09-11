import SwiftUI

struct LinkedMethodsView: View {
  @ObservedObject var model: AuthSessionModel
  @State private var password = ""
  @State private var confirmation = ""
  @State private var appleConsent = false
  @State private var pendingUnlink: ProviderID?

  private var providers: Set<ProviderID> {
    Set(model.profile?.providers ?? Array(model.identity?.providers ?? []))
  }

  var body: some View {
    Form {
      Section("auth_linked_methods") {
        ForEach(ProviderID.allCases) { provider in
          HStack {
            Label(label(provider), systemImage: icon(provider))
            Spacer()
            Text(providers.contains(provider) ? "auth_linked" : "auth_not_linked")
              .foregroundStyle(.secondary)
          }
          if provider == .google {
            Text("auth_manage_google_android").font(.caption).foregroundStyle(.secondary)
          }
        }
      }

      if !providers.contains(.password) {
        Section {
          if let email = model.profile?.email ?? model.identity?.email,
            providers.contains(.apple)
          {
            Text(String(format: String(localized: "auth_password_email_format"), email))
              .font(.subheadline).foregroundStyle(.secondary)
            if email.lowercased().hasSuffix("@privaterelay.appleid.com") {
              Text("auth_apple_relay_password").font(.caption).foregroundStyle(.secondary)
            }
            SecureField("auth_new_password", text: $password).textContentType(.newPassword)
            SecureField("auth_confirm_password", text: $confirmation).textContentType(.newPassword)
            Button("auth_add_password_action") {
              let value = password
              Task {
                guard value == confirmation else { return }
                await model.linkPassword(password: value)
                password = ""
                confirmation = ""
              }
            }
            .disabled(model.isBusy || password.count < 6 || password != confirmation)
          } else {
            Text(
              (model.profile?.email ?? model.identity?.email) == nil
                ? "auth_password_unavailable" : "auth_link_password_unavailable"
            ).foregroundStyle(.secondary)
          }
        } header: {
          Text("auth_add_password")
        } footer: {
          Text("auth_add_password_reauth")
        }
      }

      if !providers.contains(.apple) {
        Section("auth_link_apple") {
          Toggle("auth_apple_link_consent", isOn: $appleConsent)
          if providers.contains(.password) {
            SecureField("auth_current_password", text: $password).textContentType(.password)
            AppleAuthorizationButton(type: .continue) {
              let value = password
              Task {
                await model.linkApple(password: value)
                password = ""
                appleConsent = false
              }
            }
            .frame(height: 50).disabled(model.isBusy || password.isEmpty || !appleConsent)
          } else {
            Text("auth_link_apple_unavailable").foregroundStyle(.secondary)
          }
        }
      }

      Section("auth_remove_method") {
        if providers.contains(.apple) {
          if providers.contains(.password) {
            SecureField("auth_current_password", text: $password).textContentType(.password)
          }
          Button("auth_unlink_apple", role: .destructive) { pendingUnlink = .apple }
            .disabled(model.isBusy || !canUnlink(.apple))
        }
        if providers.contains(.password) {
          Button("auth_unlink_password", role: .destructive) { pendingUnlink = .password }
            .disabled(model.isBusy || !canUnlink(.password))
        }
        Text("auth_unlink_warning").font(.caption).foregroundStyle(.secondary)
      }

      if model.profileSyncPending {
        Section {
          Label("auth_sync_pending", systemImage: "arrow.triangle.2.circlepath")
          Button("retry") { Task { await model.refreshAccount() } }
        }
      }
      if let failure = model.lastFailure, failure != .cancelled {
        Section {
          Label(LocalizedStringKey(failure.messageKey), systemImage: "exclamationmark.circle")
            .foregroundStyle(.red)
        }
      }
    }
    .navigationTitle("auth_linked_methods")
    .confirmationDialog("auth_unlink_confirm", isPresented: unlinkDialog) {
      Button("auth_remove_method", role: .destructive) {
        guard let provider = pendingUnlink else { return }
        let value = password
        pendingUnlink = nil
        Task {
          await model.unlink(provider, password: value)
          password = ""
        }
      }
    }
  }

  private var unlinkDialog: Binding<Bool> {
    Binding(
      get: { pendingUnlink != nil },
      set: { if !$0 { pendingUnlink = nil } })
  }

  private func canUnlink(_ provider: ProviderID) -> Bool {
    let remaining = providers.subtracting([provider]).filter(\.isUsableOnIOS)
    if provider == .apple, remaining.contains(.password) { return !password.isEmpty }
    return !remaining.isEmpty
  }

  private func label(_ provider: ProviderID) -> LocalizedStringKey {
    switch provider {
    case .password: return "auth_method_password"
    case .apple: return "auth_method_apple"
    case .google: return "auth_method_google"
    }
  }

  private func icon(_ provider: ProviderID) -> String {
    switch provider {
    case .password: return "key"
    case .apple: return "apple.logo"
    case .google: return "g.circle"
    }
  }
}
