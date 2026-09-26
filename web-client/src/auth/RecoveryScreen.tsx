import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useAuth } from "./AuthProvider";
import { friendlyError, statusLabel, useI18n } from "../i18n";

interface RecoveryStatus {
  accountStatus: string;
  deletion: { recoverUntil: string; recoveryAvailable: boolean } | null;
  request: { status: string } | null;
}
export function RecoveryScreen() {
  const { state, logout, retry } = useAuth();
  const { t, date, lang } = useI18n();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (state.phase !== "recovery") return null;
  const { api, user } = state;
  return (
    <RecoveryContent
      api={api}
      uid={user.uid}
      error={error}
      setError={setError}
      busy={busy}
      setBusy={setBusy}
      logout={logout}
      retry={retry}
      t={t}
      date={date}
      lang={lang}
    />
  );
}

function RecoveryContent({
  api,
  uid,
  error,
  setError,
  busy,
  setBusy,
  logout,
  retry,
  t,
  date,
  lang,
}: {
  api: Extract<
    ReturnType<typeof useAuth>["state"],
    { phase: "recovery" }
  >["api"];
  uid: string;
  error: string;
  setError: (value: string) => void;
  busy: boolean;
  setBusy: (value: boolean) => void;
  logout: () => Promise<void>;
  retry: () => void;
  t: ReturnType<typeof useI18n>["t"];
  date: ReturnType<typeof useI18n>["date"];
  lang: ReturnType<typeof useI18n>["lang"];
}) {
  const status = useQuery({
    queryKey: [uid, "recovery"],
    queryFn: ({ signal }) =>
      api.get<RecoveryStatus>("/users/me/account-recovery", signal),
  });
  async function request() {
    setBusy(true);
    setError("");
    try {
      await api.post("/users/me/account-recovery", {});
      await status.refetch();
    } catch (error) {
      setError(friendlyError(error, t));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="center-state">
      <div className="panel recovery-panel">
        <h1>{t("recovery")}</h1>
        <p>{t("accountDeletionPending")}</p>
        {status.isPending && <p>{t("loading")}</p>}
        {status.data?.deletion?.recoverUntil && (
          <p>{date(status.data.deletion.recoverUntil)}</p>
        )}
        {status.data?.request && (
          <p>{statusLabel(status.data.request.status, lang)}</p>
        )}
        {error && (
          <p role="alert" className="notice">
            {error}
          </p>
        )}
        <div className="action-row">
          {status.data?.deletion?.recoveryAvailable && !status.data.request && (
            <button
              className="primary"
              disabled={busy}
              onClick={() => void request()}
            >
              {t("recoverAccount")}
            </button>
          )}
          <button onClick={() => void status.refetch()}>{t("refresh")}</button>
          <button onClick={retry}>{t("retry")}</button>
          <button onClick={() => void logout()}>{t("signOut")}</button>
        </div>
      </div>
    </main>
  );
}
