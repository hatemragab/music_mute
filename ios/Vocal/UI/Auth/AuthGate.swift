import SwiftUI

struct AuthGate<Content: View>: View {
  @ObservedObject var model: AuthSessionModel
  @ViewBuilder let content: () -> Content

  var body: some View {
    Group {
      switch model.phase {
      case .restoring, .authenticating, .bootstrapping:
        GlowSplashView()
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

}

private struct GlowSplashView: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var pulse = false
  private let green = Color(red: 67 / 255, green: 200 / 255, blue: 62 / 255)

  var body: some View {
    ZStack {
      Color(red: 14 / 255, green: 16 / 255, blue: 21 / 255).ignoresSafeArea()
      ZStack {
        Circle()
          .fill(
            RadialGradient(
              colors: [green.opacity(0.22), .clear], center: .center,
              startRadius: 0, endRadius: 130)
          )
          .frame(width: 260, height: 260)
          .accessibilityHidden(true)
        VStack(spacing: 24) {
          HStack(spacing: 8) {
            ForEach(Array([24.0, 49, 70, 49, 24].enumerated()), id: \.offset) { _, height in
              Capsule().fill(green).frame(width: 7, height: height)
            }
          }
          .frame(width: 76, height: 76)
          .accessibilityHidden(true)
          Text("app_name")
            .font(.system(size: 30, weight: .semibold))
            .foregroundStyle(.white)
        }
      }
    }
    .overlay(alignment: .bottom) {
      Capsule().fill(green)
        .frame(width: 40, height: 3)
        .opacity(reduceMotion || pulse ? 1 : 0.35)
        .animation(
          reduceMotion ? nil : .easeInOut(duration: 1).repeatForever(autoreverses: true),
          value: pulse
        )
        .padding(.bottom, 64)
        .accessibilityLabel(Text("auth_restoring"))
        .onAppear { pulse = true }
    }
    .accessibilityIdentifier("authSplash")
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
