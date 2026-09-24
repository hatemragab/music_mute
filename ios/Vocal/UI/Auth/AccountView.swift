import SwiftUI

struct AccountView: View {
  @ObservedObject var model: AuthSessionModel
  @State private var confirmsDeletion = false
  @State private var deletionPassword = ""
  @State private var confirmsLocalLogout = false
  @State private var confirmsGlobalLogout = false

  var body: some View {
    List {
      Section("auth_account") {
        LabeledContent("auth_name", value: model.profile?.displayName ?? "—")
        LabeledContent("auth_email", value: model.profile?.email ?? model.identity?.email ?? "—")
        LabeledContent(
          "auth_verification",
          value: model.profile?.emailVerified == true
            ? String(localized: "auth_verified") : String(localized: "auth_not_verified"))
        if model.isOffline {
          Label("auth_offline_session", systemImage: "wifi.slash").foregroundStyle(.orange)
        }
        if model.profileSyncPending {
          Label("auth_sync_pending", systemImage: "arrow.triangle.2.circlepath")
            .foregroundStyle(.orange)
        }
      }

      if model.profile?.emailVerified != true {
        Section("auth_verify_email") {
          Text("auth_verify_body").font(.subheadline).foregroundStyle(.secondary)
          TimelineView(.periodic(from: .now, by: 1)) { context in
            Button("auth_send_verification") { Task { await model.requestVerification() } }
              .disabled(model.isBusy || verificationCoolingDown(at: context.date))
          }
          Button("auth_i_verified") { Task { await model.refreshAccount() } }
            .disabled(model.isBusy)
          if model.mailOutcome == .accepted {
            Text("auth_verification_accepted").font(.subheadline).foregroundStyle(VocalStyle.teal)
          }
        }
      }

      Section("auth_access_status") {
        if let access = model.access {
          if access.allowed {
            Label("auth_access_allowed", systemImage: "checkmark.circle").foregroundStyle(
              VocalStyle.teal)
          } else {
            Label(accessMessage, systemImage: "info.circle").foregroundStyle(.orange)
          }
        } else {
          Label("auth_access_unknown", systemImage: "questionmark.circle").foregroundStyle(
            .secondary)
        }
        Text("auth_access_local_audio").font(.caption).foregroundStyle(.secondary)
      }

      Section("auth_security") {
        NavigationLink("auth_linked_methods") { LinkedMethodsView(model: model) }
        NavigationLink("auth_devices") { DevicesView(model: model) }
      }

      Section {
        Button("auth_sign_out", role: .destructive) { confirmsLocalLogout = true }
          .disabled(model.isBusy)
        Button("auth_logout_all", role: .destructive) { confirmsGlobalLogout = true }
          .disabled(model.isBusy)
      } footer: {
        Text("auth_logout_all_body")
      }

      Section("auth_delete_account") {
        Text("auth_delete_scope")
        Button("auth_delete_account", role: .destructive) { confirmsDeletion = true }
          .disabled(model.isBusy).accessibilityIdentifier("deleteAccount")
        if let url = accountResourceURL("MUSICMUTE_PRIVACY_URL") {
          Link("privacy_policy", destination: url)
        }
        if let url = accountResourceURL("MUSICMUTE_ACCOUNT_DELETION_URL") {
          Link("deletion_help", destination: url)
        }
      }

      if let failure = model.lastFailure, failure != .cancelled {
        Section {
          Label(LocalizedStringKey(failure.messageKey), systemImage: "exclamationmark.circle")
            .foregroundStyle(.red)
        }
      }
    }
    .navigationTitle("auth_account")
    .alert("auth_delete_confirm", isPresented: $confirmsDeletion) {
      if model.identity?.providers.contains(.apple) != true {
        SecureField("auth_password", text: $deletionPassword)
      }
      Button("cancel", role: .cancel) { deletionPassword = "" }
      Button("auth_delete_account", role: .destructive) {
        let password = deletionPassword
        deletionPassword = ""
        Task { await model.deleteAccount(password: password) }
      }
    } message: {
      Text("auth_delete_scope")
    }
    .confirmationDialog("auth_sign_out_confirm", isPresented: $confirmsLocalLogout) {
      Button("auth_sign_out", role: .destructive) { Task { await model.signOut() } }
    }
    .confirmationDialog("auth_logout_all_confirm", isPresented: $confirmsGlobalLogout) {
      Button("auth_logout_all", role: .destructive) { Task { await model.logoutAll() } }
    }
  }

  private func verificationCoolingDown(at date: Date) -> Bool {
    (model.verificationCooldownUntil ?? .distantPast) > date
  }

  private var accessMessage: LocalizedStringKey {
    switch model.access?.reason {
    case "EMAIL_VERIFICATION_REQUIRED": return "auth_access_verify_required"
    case "APP_UPDATE_REQUIRED": return "auth_access_update_required"
    case "DEVICE_SYNC_REQUIRED": return "auth_access_device_required"
    default: return "auth_access_restricted"
    }
  }

}
