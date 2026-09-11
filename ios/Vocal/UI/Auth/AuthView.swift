import AuthenticationServices
import SwiftUI

private enum AuthFormMode { case login, register, recovery }

struct AuthView: View {
  @ObservedObject var model: AuthSessionModel
  @State private var mode: AuthFormMode = .login
  @State private var email = ""
  @State private var password = ""
  @State private var confirmation = ""
  @State private var showsPassword = false

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          VStack(alignment: .leading, spacing: 8) {
            Text("app_name").font(.title3.bold()).foregroundStyle(VocalStyle.teal)
            Text(titleKey).font(.largeTitle.bold())
            Text(bodyKey).foregroundStyle(.secondary)
          }

          if let receipt = model.deletionReceipt {
            Text("auth_delete_accepted")
            Text(receipt.requestId).font(.caption).textSelection(.enabled)
          } else if model.deletionUncertain {
            Text("auth_delete_uncertain").foregroundStyle(.orange)
          }
          if let url = accountResourceURL("MUSICMUTE_ACCOUNT_DELETION_URL") {
            Link("deletion_help", destination: url)
          }
          if let url = accountResourceURL("MUSICMUTE_PRIVACY_URL") {
            Link("privacy_policy", destination: url)
          }
          VStack(spacing: 16) {
            TextField("auth_email", text: $email)
              .textContentType(.emailAddress).keyboardType(.emailAddress)
              .textInputAutocapitalization(.never).autocorrectionDisabled()
              .textFieldStyle(.roundedBorder).accessibilityIdentifier("authEmail")

            if mode != .recovery {
              passwordField("auth_password", value: $password, contentType: passwordContentType)
              if mode == .register {
                passwordField(
                  "auth_confirm_password", value: $confirmation,
                  contentType: .newPassword)
              }
              Toggle("auth_show_password", isOn: $showsPassword).font(.subheadline)
            }
          }

          if let failure = model.lastFailure, failure != .cancelled {
            Label(LocalizedStringKey(failure.messageKey), systemImage: "exclamationmark.circle")
              .font(.subheadline).foregroundStyle(.red)
              .accessibilityIdentifier("authError")
          }
          if mode == .recovery, model.recoveryAccepted {
            Label("auth_reset_accepted", systemImage: "envelope.badge")
              .font(.subheadline).foregroundStyle(VocalStyle.teal)
          }
          if model.logoutAllUncertain {
            Label("auth_logout_all_uncertain", systemImage: "exclamationmark.triangle")
              .font(.subheadline).foregroundStyle(.orange)
          }

          TimelineView(.periodic(from: .now, by: 1)) { context in
            Button(actionKey) { submit() }
              .buttonStyle(PrimaryButtonStyle())
              .disabled(
                model.isBusy || email.isEmpty || (mode != .recovery && password.isEmpty)
                  || resetCoolingDown(at: context.date)
              )
              .accessibilityIdentifier("authSubmit")
          }

          if mode == .login {
            AppleAuthorizationButton(type: .signIn) { Task { await model.signInApple() } }
              .frame(height: 52).disabled(model.isBusy)
              .accessibilityIdentifier("signInWithApple")
            Button("auth_forgot_password") { switchMode(.recovery) }
              .frame(maxWidth: .infinity, minHeight: 44)
            Button("auth_create_account") { switchMode(.register) }
              .frame(maxWidth: .infinity, minHeight: 44)
          } else {
            Button("auth_back_to_login") { switchMode(.login) }
              .frame(maxWidth: .infinity, minHeight: 44)
          }
        }
        .padding(24).frame(maxWidth: 560)
      }
      .navigationTitle("app_name").navigationBarTitleDisplayMode(.inline)
    }
    .accessibilityIdentifier(mode == .login ? "loginScreen" : "secondaryAuthScreen")
  }

  private var titleKey: LocalizedStringKey {
    switch mode {
    case .login: return "auth_login_title"
    case .register: return "auth_register_title"
    case .recovery: return "auth_recovery_title"
    }
  }

  private var bodyKey: LocalizedStringKey {
    switch mode {
    case .login: return "auth_login_body"
    case .register: return "auth_register_body"
    case .recovery: return "auth_recovery_body"
    }
  }

  private var actionKey: LocalizedStringKey {
    switch mode {
    case .login: return "auth_sign_in"
    case .register: return "auth_register"
    case .recovery: return "auth_send_reset"
    }
  }

  private var passwordContentType: UITextContentType {
    mode == .register ? .newPassword : .password
  }

  private func resetCoolingDown(at date: Date) -> Bool {
    mode == .recovery && (model.resetCooldownUntil ?? .distantPast) > date
  }

  @ViewBuilder private func passwordField(
    _ title: LocalizedStringKey, value: Binding<String>, contentType: UITextContentType
  ) -> some View {
    if showsPassword {
      TextField(title, text: value).textContentType(contentType).textFieldStyle(.roundedBorder)
    } else {
      SecureField(title, text: value).textContentType(contentType).textFieldStyle(.roundedBorder)
    }
  }

  private func submit() {
    let submittedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
    let submittedPassword = password
    let submittedConfirmation = confirmation
    Task {
      switch mode {
      case .login:
        await model.signInEmail(email: submittedEmail, password: submittedPassword)
      case .register:
        await model.registerEmail(
          email: submittedEmail, password: submittedPassword, confirmation: submittedConfirmation)
      case .recovery:
        await model.requestPasswordReset(email: submittedEmail)
      }
      password = ""
      confirmation = ""
    }
  }

  private func switchMode(_ value: AuthFormMode) {
    password = ""
    confirmation = ""
    showsPassword = false
    mode = value
  }
}

struct AppleAuthorizationButton: UIViewRepresentable {
  let type: ASAuthorizationAppleIDButton.ButtonType
  let action: () -> Void

  func makeCoordinator() -> Coordinator { Coordinator(action: action) }

  func makeUIView(context: Context) -> ASAuthorizationAppleIDButton {
    let button = ASAuthorizationAppleIDButton(type: type, style: .black)
    button.cornerRadius = 16
    button.addTarget(
      context.coordinator, action: #selector(Coordinator.invoke), for: .touchUpInside)
    return button
  }

  func updateUIView(_ uiView: ASAuthorizationAppleIDButton, context: Context) {
    context.coordinator.action = action
  }

  final class Coordinator: NSObject {
    var action: () -> Void
    init(action: @escaping () -> Void) { self.action = action }
    @objc func invoke() { action() }
  }
}
