import SwiftUI

struct AuthGate<Content: View>: View {
  @ObservedObject var model: AuthSessionModel
  @ViewBuilder let content: () -> Content

  var body: some View {
    Group {
      switch model.phase {
      case .restoring, .authenticating:
        authProgress("auth_restoring")
      case .bootstrapping:
        authProgress("auth_setting_up")
      case .signedOut:
        AuthView(model: model)
      case .blocked:
        BootstrapRecoveryView(model: model)
      case .recoveryRequired:
        AccountRecoveryView(model: model)
      case .authenticated:
        content()
      }
    }
    .accessibilityIdentifier("authGate")
  }

  private func authProgress(_ key: LocalizedStringKey) -> some View {
    VStack(spacing: 20) {
      ProgressView().controlSize(.large)
      Text(key).font(.headline)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color(uiColor: .systemBackground))
  }
}

private struct AccountRecoveryView: View {
  @ObservedObject var model: AuthSessionModel
  @State private var reason = ""

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          Image(systemName: "arrow.counterclockwise.circle.fill")
            .font(.system(size: 44)).foregroundStyle(VocalStyle.teal)
          Text("account_recovery_title").font(.largeTitle.bold())
          Text("account_recovery_description").foregroundStyle(.secondary)
          if let deadline = model.accountRecovery?.deletion?.recoverUntil {
            VStack(alignment: .leading, spacing: 4) {
              Text("account_recovery_deadline").font(.caption).foregroundStyle(.secondary)
              Text(deadline.formatted(date: .long, time: .shortened)).font(.headline)
            }
            .padding().frame(maxWidth: .infinity, alignment: .leading)
            .background(VocalStyle.teal.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
          }
          switch (
            model.accountRecovery?.deletion?.recoveryAvailable,
            model.accountRecovery?.request?.status
          ) {
          case (false, _), (_, "expired"):
            Label("auth_account_recovery_expired", systemImage: "calendar.badge.exclamationmark")
              .foregroundStyle(.red)
          case (_, "pending"):
            Label("account_recovery_pending", systemImage: "clock.badge.checkmark")
              .foregroundStyle(.secondary)
          case (_, "rejected"):
            VStack(alignment: .leading, spacing: 8) {
              Label("account_recovery_rejected", systemImage: "xmark.circle")
                .foregroundStyle(.red)
              if let review = model.accountRecovery?.request?.reviewReason {
                Text(review).font(.callout).foregroundStyle(.secondary)
              }
            }
          default:
            VStack(alignment: .leading, spacing: 8) {
              Text("account_recovery_reason").font(.headline)
              TextField("account_recovery_optional", text: $reason, axis: .vertical)
                .lineLimit(3...6).textFieldStyle(.roundedBorder)
                .onChange(of: reason) { _, value in
                  if value.count > 500 { reason = String(value.prefix(500)) }
                }
                .accessibilityIdentifier("accountRecoveryReason")
            }
            Button("account_recovery_send") {
              Task { await model.requestAccountRecovery(reason: reason) }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(model.isBusy || model.accountRecovery?.deletion?.recoveryAvailable != true)
            .accessibilityIdentifier("accountRecoverySubmit")
          }
          if let failure = model.lastFailure {
            Text(LocalizedStringKey(failure.messageKey)).foregroundStyle(.red)
          }
          Button("account_recovery_refresh") {
            Task { await model.refreshAccountRecovery() }
          }
          .buttonStyle(.bordered).disabled(model.isBusy)
          Button("auth_sign_out", role: .destructive) { Task { await model.signOut() } }
            .frame(maxWidth: .infinity, minHeight: 44).disabled(model.isBusy)
          if model.isBusy { ProgressView().frame(maxWidth: .infinity) }
        }
        .padding(24)
      }
      .navigationTitle("app_name")
    }
    .task(id: model.accountRecovery?.request?.status) {
      while !Task.isCancelled, model.accountRecovery?.request?.status == "pending" {
        try? await Task.sleep(for: .seconds(15))
        guard !Task.isCancelled else { return }
        await model.refreshAccountRecovery()
      }
    }
    .accessibilityIdentifier("accountRecovery")
  }
}

private struct BootstrapRecoveryView: View {
  @ObservedObject var model: AuthSessionModel

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          Image(systemName: "exclamationmark.icloud")
            .font(.system(size: 42)).foregroundStyle(VocalStyle.teal)
          Text("auth_setup_failed_title").font(.largeTitle.bold())
          Text(LocalizedStringKey(model.lastFailure?.messageKey ?? "auth_service_unavailable"))
            .foregroundStyle(.secondary)
          Button("retry", action: { Task { await model.retryBootstrap() } })
            .buttonStyle(PrimaryButtonStyle()).disabled(model.isBusy)
          NavigationLink("auth_delete_account") { AccountView(model: model) }
          Button("auth_sign_out", role: .destructive) { Task { await model.signOut() } }
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .padding(24)
      }
      .navigationTitle("app_name")
    }
    .accessibilityIdentifier("bootstrapRecovery")
  }
}
