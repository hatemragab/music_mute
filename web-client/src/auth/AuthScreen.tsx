import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
} from "firebase/auth";
import { useState, type FormEvent } from "react";
import { auth } from "./AuthProvider";
import { friendlyError, useI18n } from "../i18n";

type Mode = "login" | "register" | "reset";
export function AuthScreen() {
  const { t, lang, setLang } = useI18n();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (mode === "register" && password !== confirm) {
      setMessage(t("passwordMismatch"));
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      if (mode === "reset") {
        await sendPasswordResetEmail(auth, email.trim());
        setMessage(t("resetSent"));
      } else if (mode === "register")
        await createUserWithEmailAndPassword(auth, email.trim(), password);
      else await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (error) {
      setMessage(friendlyError(error, t));
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    setBusy(true);
    setMessage("");
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (error) {
      setMessage(friendlyError(error, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-language">
        <button
          type="button"
          aria-pressed={lang === "en"}
          onClick={() => setLang("en")}
        >
          {t("english")}
        </button>
        <button
          type="button"
          aria-pressed={lang === "ar"}
          onClick={() => setLang("ar")}
        >
          {t("arabic")}
        </button>
      </div>
      <div className="auth-intro">
        <div className="brand-mark" aria-hidden="true">
          M
        </div>
        <h1>{t("brand")}</h1>
        <p>{t("tagline")}</p>
        <div className="wave-art" aria-hidden="true" />
      </div>
      <section className="auth-card" aria-labelledby="auth-title">
        <h2 id="auth-title">
          {t(
            mode === "login"
              ? "signIn"
              : mode === "register"
                ? "register"
                : "resetPassword",
          )}
        </h2>
        <form onSubmit={submit}>
          <label>
            {t("email")}
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          {mode !== "reset" && (
            <label>
              {t("password")}
              <input
                type="password"
                autoComplete={
                  mode === "register" ? "new-password" : "current-password"
                }
                minLength={6}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          )}
          {mode === "register" && (
            <label>
              {t("confirmPassword")}
              <input
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </label>
          )}
          {message && (
            <p role="alert" className="notice">
              {message}
            </p>
          )}
          <button className="primary" type="submit" disabled={busy}>
            {busy
              ? t("loading")
              : t(
                  mode === "reset"
                    ? "sendReset"
                    : mode === "register"
                      ? "register"
                      : "signIn",
                )}
          </button>
        </form>
        {mode !== "reset" && (
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={google}
          >
            {t("google")}
          </button>
        )}
        <div className="auth-links">
          {mode === "login" && (
            <>
              <button type="button" onClick={() => setMode("reset")}>
                {t("resetPassword")}
              </button>
              <button type="button" onClick={() => setMode("register")}>
                {t("switchToRegister")}
              </button>
            </>
          )}
          {mode !== "login" && (
            <button type="button" onClick={() => setMode("login")}>
              {t("switchToSignIn")}
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
