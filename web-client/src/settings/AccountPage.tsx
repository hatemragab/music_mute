import {
  EmailAuthProvider,
  GoogleAuthProvider,
  linkWithCredential,
  linkWithPopup,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  reload,
  unlink,
} from "firebase/auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { DeviceView } from "../api/types";
import { useAuth, useSignedIn } from "../auth/AuthProvider";
import { friendlyError, useI18n } from "../i18n";

export function AccountPage() {
  const { api, user, session } = useSignedIn();
  const { logout, retry } = useAuth();
  const { t, date } = useI18n();
  const queryClient = useQueryClient();
  const devices = useQuery({
    queryKey: [user.uid, "devices"],
    queryFn: ({ signal }) =>
      api.get<{ items: DeviceView[]; nextCursor: string | null }>(
        "/users/me/devices?limit=50",
        signal,
      ),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (error) {
      setError(friendlyError(error, t));
    } finally {
      setBusy(false);
    }
  }
  async function removeDevice(id: string) {
    if (!confirm(t("removeDeviceConfirm"))) return;
    await action(async () => {
      await api.delete(`/users/me/devices/${encodeURIComponent(id)}`);
      await queryClient.invalidateQueries({ queryKey: [user.uid, "devices"] });
    });
  }
  async function requestDeletion() {
    if (!confirm(t("deleteAccountConfirm"))) return;
    await action(async () => {
      if (
        user.providerData.some((provider) => provider.providerId === "password")
      ) {
        if (!password) throw new Error(t("password"));
        await reauthenticateWithCredential(
          user,
          EmailAuthProvider.credential(user.email || "", password),
        );
      } else await reauthenticateWithPopup(user, new GoogleAuthProvider());
      await api.request("DELETE", "/users/me", {});
      setPassword("");
      retry();
    });
  }
  async function addPassword() {
    await action(async () => {
      if (!user.email || newPassword.length < 6) throw new Error(t("password"));
      await linkWithCredential(
        user,
        EmailAuthProvider.credential(user.email, newPassword),
      );
      setNewPassword("");
      setNotice(t("saved"));
    });
  }
  const providers = user.providerData.map((provider) => provider.providerId);
  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">{t("settings")}</p>
          <h1>{t("account")}</h1>
        </div>
      </header>
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      <section className="panel">
        <h2>{t("profile")}</h2>
        <p dir="auto">{session.user.displayName}</p>
        <p dir="ltr">{session.user.email}</p>
        <p>{session.user.emailVerified ? t("verified") : t("unverified")}</p>
        {!session.user.emailVerified && (
          <div className="action-row">
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await api.post("/auth/verification-emails", {});
                  setNotice(t("emailSent"));
                })
              }
            >
              {t("sendVerification")}
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await reload(user);
                  retry();
                })
              }
            >
              {t("refreshVerification")}
            </button>
          </div>
        )}
      </section>
      <section className="panel">
        <h2>{t("linked")}</h2>
        <p>
          {providers
            .map((provider) =>
              provider === "password"
                ? t("password")
                : provider === "google.com"
                  ? "Google"
                  : provider,
            )
            .join(", ")}
        </p>
        <div className="action-row">
          {!providers.includes("google.com") && (
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await linkWithPopup(user, new GoogleAuthProvider());
                  setNotice(t("saved"));
                })
              }
            >
              {t("google")}
            </button>
          )}
          {providers.includes("google.com") && providers.length > 1 && (
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await unlink(user, "google.com");
                  setNotice(t("saved"));
                })
              }
            >
              {t("delete")} Google
            </button>
          )}
          {providers.includes("password") && providers.length > 1 && (
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  if (!confirm(t("unlinkPasswordConfirm"))) return;
                  await unlink(user, "password");
                  setNotice(t("saved"));
                })
              }
            >
              {t("delete")} {t("password")}
            </button>
          )}
        </div>
        {!providers.includes("password") && (
          <div className="inline-form">
            <label>
              {t("password")}
              <input
                type="password"
                autoComplete="new-password"
                minLength={6}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </label>
            <button
              disabled={busy || newPassword.length < 6}
              onClick={() => void addPassword()}
            >
              {t("update")}
            </button>
          </div>
        )}
      </section>
      <section className="panel">
        <h2>{t("devices")}</h2>
        {devices.isPending && <p>{t("loading")}</p>}
        {devices.isError && (
          <p role="alert" className="notice">
            {t("requestFailed")}
          </p>
        )}
        {devices.data?.items.length === 0 && <p>{t("noDevices")}</p>}
        <div className="device-list">
          {devices.data?.items.map((device) => (
            <div key={device.installationId} className="device-row">
              <div>
                <strong>{device.deviceModel || device.platform}</strong>
                <small>
                  {device.platform} · {date(device.firstSeenAt)}
                </small>
                <small className="identifier" dir="ltr">
                  {device.installationId}
                </small>
              </div>
              <button
                disabled={busy}
                onClick={() => void removeDevice(device.installationId)}
              >
                {t("removeDevice")}
              </button>
            </div>
          ))}
        </div>
      </section>
      <section className="panel">
        <h2>{t("signOut")}</h2>
        <div className="action-row">
          <button disabled={busy} onClick={() => void action(logout)}>
            {t("signOut")}
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void action(async () => {
                if (!confirm(t("signOutAll"))) return;
                await api.post("/auth/session-revocations", {});
                await logout();
              })
            }
          >
            {t("signOutAll")}
          </button>
        </div>
      </section>
      <section className="panel danger-zone">
        <h2>{t("deleteAccount")}</h2>
        <p>{t("deleteAccountConfirm")}</p>
        {providers.includes("password") && (
          <label>
            {t("password")}
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
        )}
        <button
          className="danger"
          disabled={busy}
          onClick={() => void requestDeletion()}
        >
          {t("deleteAccount")}
        </button>
      </section>
    </div>
  );
}
