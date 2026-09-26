import { useAuth } from "./AuthProvider";
import { friendlyError, useI18n } from "../i18n";

export function StartupScreen() {
  const { state, retry } = useAuth();
  const { t, lang, setLang } = useI18n();
  if (state.phase !== "restoring" && state.phase !== "error") return null;
  const failed = state.phase === "error";

  return (
    <main className="startup-page">
      <div className="startup-topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            M
          </span>
          <span>{t("brand")}</span>
        </div>
        <div className="auth-language" role="group" aria-label={t("language")}>
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
      </div>
      <section className="startup-card" aria-labelledby="startup-title">
        <div
          className={`startup-art${failed ? " startup-art-error" : ""}`}
          aria-hidden="true"
        >
          <span className="startup-orbit" />
          <span className="startup-emblem">M</span>
          <span className="startup-bars">
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
        </div>
        <p className="startup-eyebrow">{t("brand")}</p>
        <h1 id="startup-title">
          {t(failed ? "startupErrorTitle" : "startupTitle")}
        </h1>
        {failed ? (
          <>
            <p className="startup-description" role="alert">
              {friendlyError(new Error(state.message), t)}
            </p>
            <p className="startup-hint">{t("startupErrorDescription")}</p>
            <button
              className="primary startup-retry"
              type="button"
              onClick={retry}
            >
              {t("retry")}
            </button>
          </>
        ) : (
          <>
            <p className="startup-description">{t("startupDescription")}</p>
            <div className="startup-progress" role="status" aria-live="polite">
              <span className="startup-spinner" aria-hidden="true" />
              <span>
                {t(state.step === "auth" ? "startupAuth" : "startupSession")}
              </span>
            </div>
          </>
        )}
      </section>
      <p className="startup-footer">{t("tagline")}</p>
    </main>
  );
}
