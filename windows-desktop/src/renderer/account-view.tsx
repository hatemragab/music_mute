import { ModalDialog } from "./dialog.js";
import { t } from "./i18n.js";
import { useEffect, useState, type FormEvent } from "react";
import type {
  AccountCommand,
  AccountView,
  AccountDestructiveReview,
} from "../shared/account-contracts.js";
import { canUnlinkWindowsProvider } from "../shared/account-contracts.js";
type Mode = "signin" | "signup" | "reset";
type Confirmation =
  "logout-all" | "delete" | "unlink-password" | "unlink-google";
interface ReviewedConfirmation {
  action: Confirmation;
  review: AccountDestructiveReview;
}
export function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M43.61 24.46c0-1.36-.12-2.66-.35-3.92H24v7.43h11a9.45 9.45 0 0 1-4.08 6.2v5.16h6.63c3.88-3.57 6.06-8.83 6.06-14.87Z"
      />
      <path
        fill="#34A853"
        d="M24 44c5.53 0 10.17-1.83 13.55-4.97l-6.63-5.16c-1.83 1.23-4.17 1.96-6.92 1.96-5.32 0-9.83-3.59-11.43-8.42H5.72v5.32A20 20 0 0 0 24 44Z"
      />
      <path
        fill="#FBBC05"
        d="M12.57 27.41a12 12 0 0 1 0-7.66v-5.32H5.72a20 20 0 0 0 0 18.3l6.85-5.32Z"
      />
      <path
        fill="#EA4335"
        d="M24 12.17c3.01 0 5.71 1.03 7.83 3.06l5.87-5.88C34.16 6.04 29.53 4 24 4A20 20 0 0 0 5.72 14.43l6.85 5.32C14.17 14.92 18.68 12.17 24 12.17Z"
      />
    </svg>
  );
}
function useCooldown(seconds: number): number {
  const [remaining, setRemaining] = useState(seconds);
  useEffect(() => {
    setRemaining(seconds);
    if (seconds <= 0) return;
    const deadline = Date.now() + seconds * 1000;
    const timer = setInterval(
      () =>
        setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000))),
      1000,
    );
    return () => clearInterval(timer);
  }, [seconds]);
  return remaining;
}
const messages: Record<string, string> = {
  INVALID_LOGIN_CREDENTIALS: "The email or password is incorrect.",
  EMAIL_EXISTS: "This email already has an account. Sign in instead.",
  INVALID_EMAIL: "Enter a valid email address.",
  PASSWORD_CONFIRMATION_MISMATCH: "The passwords do not match.",
  PASSWORD_TOO_SHORT: "Use a password with at least 8 characters.",
  NETWORK_UNAVAILABLE:
    "Account services are offline. You can continue using local processing.",
  VAULT_UNAVAILABLE: "Windows could not access your saved sign-in. Try again.",
  VAULT_CORRUPT: "Your saved sign-in could not be read. Sign in again.",
  SESSION_CHANGED: "Your account changed. Review this action again.",
  FRESH_AUTH_REQUIRED:
    "Confirm your password or Google sign-in before continuing.",
  TOO_MANY_REQUESTS: "Please wait before trying again.",
  CONFIGURATION_REQUIRED: "Account setup is required for this build.",
  UNAUTHENTICATED: "Sign in again to use your account.",
  CANCELLED: "Sign-in was cancelled.",
  GOOGLE_SIGN_IN_TIMEOUT: "Google sign-in timed out. Try again.",
};
export function AccountPanel({
  view,
  unavailable,
  blocked = false,
  execute,
}: {
  view?: AccountView;
  unavailable?: string;
  blocked?: boolean;
  execute: (command: AccountCommand) => Promise<void>;
}) {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [securityPassword, setSecurityPassword] = useState("");
  const [linkPassword, setLinkPassword] = useState("");
  const [linkConfirmation, setLinkConfirmation] = useState("");
  const [confirm, setConfirm] = useState<ReviewedConfirmation>();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const verificationWait = useCooldown(view?.verificationCooldownSeconds ?? 0);
  const resetWait = useCooldown(view?.resetCooldownSeconds ?? 0);
  const busy = blocked || pending || view?.busy === true;
  const available = !!view && !unavailable;
  useEffect(() => {
    setPassword("");
    setConfirmation("");
    setSecurityPassword("");
    setLinkPassword("");
    setLinkConfirmation("");
    setConfirm(undefined);
    setEmail("");
    setName("");
  }, [view?.user?.id, view?.state, view?.destructiveReview?.generation]);
  const requestConfirmation = (action: Confirmation) => {
    if (!view?.destructiveReview) {
      setFailed(true);
      return;
    }
    setConfirm({ action, review: { ...view.destructiveReview } });
  };
  const send = async (command: AccountCommand) => {
    setPending(true);
    setFailed(false);
    try {
      await execute(command);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const command: AccountCommand =
      mode === "reset"
        ? { type: "RESET_PASSWORD", email }
        : mode === "signup"
          ? { type: "SIGN_UP_EMAIL", email, name, password, confirmation }
          : { type: "SIGN_IN_EMAIL", email, password };
    setPassword("");
    setConfirmation("");
    void send(command);
  };
  const confirmedAction = () => {
    if (!confirm) return;
    const reviewed = {
      expectedAccountId: confirm.review.accountId,
      expectedSessionGeneration: confirm.review.generation,
    };
    let command: AccountCommand;
    if (confirm.action === "logout-all")
      command = { type: "LOGOUT_ALL", confirmed: true, ...reviewed };
    else if (confirm.action === "delete")
      command = {
        type: "DELETE_ACCOUNT",
        confirmed: true,
        password: securityPassword,
        ...reviewed,
      };
    else if (
      confirm.action === "unlink-password" ||
      confirm.action === "unlink-google"
    )
      command = {
        type: "UNLINK_PROVIDER",
        provider:
          confirm.action === "unlink-password" ? "password" : "google.com",
        password: securityPassword,
        confirmed: true,
        ...reviewed,
      };
    else return;
    setSecurityPassword("");
    setConfirm(undefined);
    void send(command);
  };
  return (
    <section className="panel account-panel" aria-busy={busy}>
      <h2>{view?.user?.displayName || t("Your MusicMute account")}</h2>
      <p className="muted">
        {"" +
          t(
            "Local processing is available without an account. Sign in to save and listen across devices.",
          ) +
          ""}
      </p>
      {unavailable && (
        <p role="status">
          {unavailable === "CONFIGURATION_REQUIRED"
            ? t("Account setup is required for this build.")
            : t(
                "Your saved sign-in will be available after MusicMute's native helper is restored.",
              )}
        </p>
      )}
      {failed && (
        <p role="alert" className="error">
          {"" +
            t("MusicMute could not complete this account action. Try again.") +
            ""}
        </p>
      )}
      {view?.errorCode && (
        <p role="alert" className="error">
          {t(
            messages[view.errorCode] ??
              "This account action could not be completed. Review your account and try again.",
          )}
        </p>
      )}
      {view?.noticeCode && (
        <p role="status">
          {view.noticeCode === "VERIFICATION_SENT"
            ? t("Verification email sent. Check your inbox.")
            : ["PASSWORD_RESET_SENT", "PASSWORD_RESET_REQUESTED"].includes(
                  view.noticeCode,
                )
              ? t("Check your inbox for password reset instructions.")
              : t("Account updated.")}
        </p>
      )}
      {view?.state === "restoring" && (
        <p role="status">{"" + t("Restoring your saved account…") + ""}</p>
      )}
      {(!view || view.state === "signed-out") && (
        <>
          <div className="home-links" aria-label={t("Account action")}>
            {(
              [
                ["signin", t("Sign in")],
                ["signup", t("Create account")],
                ["reset", t("Reset password")],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                aria-pressed={mode === value}
                onClick={() => {
                  setMode(value);
                  setPassword("");
                  setConfirmation("");
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <form onSubmit={submit}>
            <fieldset disabled={!available || busy}>
              {mode === "signup" && (
                <label>
                  {"" + t("Full name") + ""}
                  <input
                    autoComplete="name"
                    value={name}
                    maxLength={100}
                    required
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
              )}
              <label>
                {"" + t("Email") + ""}
                <input
                  type="email"
                  autoComplete="email"
                  value={email}
                  maxLength={254}
                  required
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              {mode !== "reset" && (
                <label>
                  {"" + t("Password") + ""}
                  <input
                    type="password"
                    autoComplete={
                      mode === "signup" ? "new-password" : "current-password"
                    }
                    value={password}
                    required
                    maxLength={4096}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
              )}
              {mode === "signup" && (
                <label>
                  {"" + t("Confirm password") + ""}
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={confirmation}
                    required
                    maxLength={4096}
                    onChange={(event) => setConfirmation(event.target.value)}
                  />
                </label>
              )}
              <button
                type="submit"
                className="primary"
                disabled={mode === "reset" && resetWait > 0}
              >
                {mode === "reset"
                  ? resetWait > 0
                    ? `Try again in ${resetWait}s`
                    : t("Send reset email")
                  : mode === "signup"
                    ? t("Create your account")
                    : t("Sign in with email")}
              </button>
              {mode !== "reset" && (
                <button
                  type="button"
                  className="google-button"
                  onClick={() =>
                    void send({ type: "SIGN_IN_GOOGLE", link: false })
                  }
                >
                  <GoogleMark />
                  {"" + t("Sign in with Google") + ""}
                </button>
              )}
            </fieldset>
          </form>
        </>
      )}
      {view?.user && (
        <>
          <p>
            {view.user.email ?? t("Google account")} ·{" "}
            {view.user.emailVerified
              ? t("Email verified")
              : t("Email not verified")}
          </p>
          <p role="status">
            {view.online
              ? t("Account connected")
              : t("Account offline; local processing remains available")}
          </p>
          <fieldset disabled={!available || busy}>
            {!view.user.emailVerified && (
              <div className="home-links">
                <button
                  disabled={verificationWait > 0}
                  onClick={() => void send({ type: "SEND_VERIFICATION" })}
                >
                  {verificationWait > 0
                    ? `Resend in ${verificationWait}s`
                    : t("Send verification email")}
                </button>
                <button
                  onClick={() => void send({ type: "RECHECK_VERIFICATION" })}
                >
                  {"" + t("I verified my email") + ""}
                </button>
              </div>
            )}
            <button onClick={() => void send({ type: "RECONNECT" })}>
              {"" + t("Reconnect account") + ""}
            </button>
            <details>
              <summary>{"" + t("Sign-in methods and security") + ""}</summary>
              <p>
                {"" + t("Linked methods:") + ""}{" "}
                {view.user.providers
                  .map((provider) =>
                    provider === "password"
                      ? t("Email and password")
                      : provider === "google.com"
                        ? t("Google")
                        : t("Apple"),
                  )
                  .join(", ")}
              </p>
              {!view.user.providers.includes("google.com") && (
                <button
                  className="google-button"
                  onClick={() =>
                    void send({ type: "SIGN_IN_GOOGLE", link: true })
                  }
                >
                  <GoogleMark />
                  {"" + t("Link Google") + ""}
                </button>
              )}
              {!view.user.providers.includes("password") && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const command: AccountCommand = {
                      type: "LINK_PASSWORD",
                      password: linkPassword,
                      confirmation: linkConfirmation,
                    };
                    setLinkPassword("");
                    setLinkConfirmation("");
                    void send(command);
                  }}
                >
                  <label>
                    {"" + t("New password") + ""}
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={linkPassword}
                      required
                      maxLength={4096}
                      onChange={(event) => setLinkPassword(event.target.value)}
                    />
                  </label>
                  <label>
                    {"" + t("Confirm new password") + ""}
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={linkConfirmation}
                      required
                      maxLength={4096}
                      onChange={(event) =>
                        setLinkConfirmation(event.target.value)
                      }
                    />
                  </label>
                  <button>{"" + t("Link email and password") + ""}</button>
                </form>
              )}
              <label>
                {"" + t("Confirm current password") + ""}
                <input
                  type="password"
                  autoComplete="current-password"
                  value={securityPassword}
                  maxLength={4096}
                  onChange={(event) => setSecurityPassword(event.target.value)}
                />
              </label>
              <button
                onClick={() => {
                  const value = securityPassword;
                  setSecurityPassword("");
                  void send({ type: "REAUTHENTICATE", password: value });
                }}
              >
                {"" + t("Confirm identity") + ""}
              </button>
              {(canUnlinkWindowsProvider(view.user, "password") ||
                canUnlinkWindowsProvider(view.user, "google.com")) && (
                <div className="home-links">
                  {canUnlinkWindowsProvider(view.user, "password") && (
                    <button
                      onClick={() => requestConfirmation("unlink-password")}
                    >
                      {"" + t("Unlink password") + ""}
                    </button>
                  )}
                  {canUnlinkWindowsProvider(view.user, "google.com") && (
                    <button
                      onClick={() => requestConfirmation("unlink-google")}
                    >
                      {"" + t("Unlink Google") + ""}
                    </button>
                  )}
                </div>
              )}
            </details>
            <details>
              <summary>{"" + t("Your devices") + ""}</summary>
              <p>
                {t(
                  "Hiding a device entry does not sign out that device or stop its worker.",
                )}
              </p>
              <button onClick={() => void send({ type: "LOAD_DEVICES" })}>
                {"" + t("View devices") + ""}
              </button>
              <ul>
                {view.devices.map((device) => (
                  <li key={device.installationId}>
                    <bdi>{device.deviceModel ?? device.platform}</bdi> ·{" "}
                    <bdi>{device.appVersion}</bdi>{" "}
                    {device.current ? t("This Windows PC") : ""}
                    {!device.current && (
                      <button
                        onClick={() =>
                          void send({
                            type: "HIDE_DEVICE",
                            installationId: device.installationId,
                          })
                        }
                      >
                        {t("Hide from history")}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {view.nextDeviceCursor && (
                <button
                  onClick={() =>
                    void send({
                      type: "LOAD_DEVICES",
                      before: view.nextDeviceCursor!,
                    })
                  }
                >
                  {"" + t("More devices") + ""}
                </button>
              )}
            </details>
            <div className="home-links">
              <button onClick={() => void send({ type: "LOGOUT" })}>
                {"" + t("Sign out") + ""}
              </button>
              <button onClick={() => requestConfirmation("logout-all")}>
                {"" + t("Sign out everywhere") + ""}
              </button>
              <button
                className="danger"
                onClick={() => requestConfirmation("delete")}
              >
                {"" + t("Request account deletion") + ""}
              </button>
            </div>
          </fieldset>
        </>
      )}
      {confirm && (
        <ModalDialog
          label={t("Confirm account action")}
          busy={busy}
          onClose={() => {
            setConfirm(undefined);
            setSecurityPassword("");
          }}
        >
          <h3>
            {confirm.action === "delete"
              ? t("Request account deletion?")
              : confirm.action === "logout-all"
                ? t("Sign out on every device?")
                : t("Unlink this sign-in method?")}
          </h3>
          <p>
            {confirm.action === "delete"
              ? t(
                  "Your account enters the server's recovery period. Account access and private media follow the deletion policy. Shared video-link artifacts remain reusable.",
                )
              : confirm.action === "logout-all"
                ? t(
                    "All MusicMute account sessions will be revoked. Your independently enrolled worker keeps its own identity.",
                  )
                : t(
                    "Keep another working sign-in method. The server may require recent authentication.",
                  )}
          </p>
          <button disabled={busy} className="danger" onClick={confirmedAction}>
            {"" + t("Confirm action") + ""}
          </button>
          <button
            data-dialog-initial-focus
            disabled={busy}
            onClick={() => {
              setConfirm(undefined);
              setSecurityPassword("");
            }}
          >
            {"" + t("Keep account unchanged") + ""}
          </button>
        </ModalDialog>
      )}
      {view?.state === "deletion-pending" && (
        <section>
          <h3>{"" + t("Account deletion pending") + ""}</h3>
          <p>
            {"" +
              t("Account work is paused. Local processing remains available.") +
              ""}
          </p>
          <button
            disabled={busy}
            onClick={() => void send({ type: "LOAD_RECOVERY" })}
          >
            {"" + t("Check recovery status") + ""}
          </button>
          {view.recovery?.recoverUntil && (
            <p>
              {"" + t("Recovery deadline:") + ""}{" "}
              <time dateTime={view.recovery.recoverUntil}>
                {new Date(view.recovery.recoverUntil).toLocaleString()}
              </time>
            </p>
          )}
          {view.recovery?.recoveryAvailable && (
            <button
              disabled={busy}
              onClick={() => void send({ type: "REQUEST_RECOVERY" })}
            >
              {"" + t("Recover account") + ""}
            </button>
          )}
        </section>
      )}
      {busy && <p role="status">{"" + t("Working securely…") + ""}</p>}
      {view?.googleSignInActive && (
        <button onClick={() => void send({ type: "CANCEL_SIGN_IN" })}>
          {"" + t("Cancel Google sign-in") + ""}
        </button>
      )}
    </section>
  );
}
