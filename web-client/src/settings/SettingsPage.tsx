import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { useState } from "react";
import { useSignedIn } from "../auth/AuthProvider";
import { useI18n } from "../i18n";
import { readConfig } from "../config";
import { ACCENTS, accentFor, saveAccent } from "./accent";

interface Usage {
  processing: {
    limitSeconds: number;
    usedSeconds: number;
    remainingSeconds: number;
  };
  availability: { status: string; reason: string | null };
  period: { nextResetAt: string };
  storage: { retainedBytes: number; limitBytes: number };
}
export function SettingsPage() {
  const { api, user } = useSignedIn();
  const { t, lang, setLang, number, date } = useI18n();
  const usage = useQuery({
    queryKey: [user.uid, "usage"],
    queryFn: ({ signal }) => api.get<Usage>("/processing-usage", signal),
    staleTime: 60_000,
  });
  const [accent, setAccent] = useState(() => accentFor(user.uid));
  const apiOrigin = readConfig().apiOrigin;
  function selectAccent(color: string) {
    setAccent(color);
    saveAccent(user.uid, color);
  }
  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">{t("brand")}</p>
          <h1>{t("settings")}</h1>
        </div>
      </header>
      <section className="panel">
        <h2>{t("language")}</h2>
        <div className="filter-row" role="group" aria-label={t("language")}>
          <button
            type="button"
            className={lang === "en" ? "selected" : ""}
            onClick={() => setLang("en")}
          >
            {t("english")}
          </button>
          <button
            type="button"
            className={lang === "ar" ? "selected" : ""}
            onClick={() => setLang("ar")}
          >
            {t("arabic")}
          </button>
        </div>
      </section>
      <section className="panel">
        <h2>{t("accent")}</h2>
        <div className="accent-row" role="radiogroup" aria-label={t("accent")}>
          {ACCENTS.map((color) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={accent.toLowerCase() === color.toLowerCase()}
              aria-label={color}
              className="accent-swatch"
              style={{ backgroundColor: color }}
              onClick={() => selectAccent(color)}
            >
              {accent.toLowerCase() === color.toLowerCase() ? "✓" : ""}
            </button>
          ))}
        </div>
        <input
          aria-label={t("accent")}
          type="color"
          value={accent}
          onChange={(event) => selectAccent(event.target.value)}
        />
      </section>
      <section className="panel">
        <h2>{t("usage")}</h2>
        {usage.isPending && <p>{t("loading")}</p>}
        {usage.isError && (
          <p role="alert" className="notice">
            {t("requestFailed")}
          </p>
        )}
        {usage.data && (
          <>
            <p>
              {t("processing")}: {number(usage.data.processing.usedSeconds)} /{" "}
              {number(usage.data.processing.limitSeconds)} {t("seconds")}
            </p>
            <progress
              max={usage.data.processing.limitSeconds || 1}
              value={usage.data.processing.usedSeconds}
            />
            <p>
              {number(usage.data.processing.remainingSeconds)} {t("seconds")} ·{" "}
              {date(usage.data.period.nextResetAt)}
            </p>
            {usage.data.availability.status !== "available" && (
              <p className="notice">
                {usage.data.availability.reason || t("processingUnavailable")}
              </p>
            )}
          </>
        )}
      </section>
      <section className="panel settings-links">
        <h2>{t("account")}</h2>
        <Link to="/account">{t("manage")} →</Link>
        <h2>{t("about")}</h2>
        <p>{t("installNotice")}</p>
        <div className="action-row">
          <a
            href={`${apiOrigin}/privacy`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("privacy")}
          </a>
          <a
            href={`${apiOrigin}/delete-account`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("deleteAccount")}
          </a>
        </div>
      </section>
    </div>
  );
}
