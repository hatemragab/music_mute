import { useLiveQuery } from "../realtime/RealtimeProvider";
import { Link, useNavigate } from "react-router";
import { useEffect, useState, type FormEvent } from "react";
import { jobsApi } from "../api/jobs";
import type { MediaImportView, ProcessingPolicyView } from "../api/types";
import { useSignedIn } from "../auth/AuthProvider";
import { friendlyError, statusLabel, useI18n } from "../i18n";
import { activeStatuses, JobCard, useJobs } from "../jobs/JobsUI";
import { supportedAudioSites, supportedAudioUrl } from "../site-policy/source";
import { AudioUpload } from "./AudioUpload";
import { SoloSignalMark } from "../brand/SoloSignalMark";

export function HomePage() {
  const { api, user, session } = useSignedIn();
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const jobs = useJobs();
  const policy = useLiveQuery<ProcessingPolicyView>(
    [user.uid, "processing-policy"],
    "policy",
  );
  const [mode, setMode] = useState<"url" | "audio">("url");
  const [url, setUrl] = useState("");
  const [rights, setRights] = useState(false);
  const [trim, setTrim] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const storageKey = `musicmute.web.import.${user.uid}`;
  const requestKey = `${storageKey}.request`;
  const [importId, setImportId] = useState<string | null>(() =>
    sessionStorage.getItem(storageKey),
  );
  const importQuery = useLiveQuery<MediaImportView>(
    [user.uid, "import", importId],
    "import",
    { id: importId ?? "" },
    !!importId,
  );
  useEffect(() => {
    const current = importQuery.data;
    if (current?.status === "submitted" && current.jobId) {
      sessionStorage.removeItem(storageKey);
      sessionStorage.removeItem(requestKey);
      navigate(`/jobs/${current.jobId}`);
    }
  }, [importQuery.data, navigate, requestKey, storageKey, user.uid]);

  async function submitUrl(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!rights) {
      setError(t("missingRights"));
      return;
    }
    let source: string;
    try {
      source = supportedAudioUrl(url);
    } catch (error) {
      setError(friendlyError(error, t));
      return;
    }
    setBusy(true);
    try {
      const fingerprint = `${source}:${trim}`;
      let requestId = crypto.randomUUID() as string;
      try {
        const previous = JSON.parse(
          sessionStorage.getItem(requestKey) || "null",
        ) as { fingerprint?: string; requestId?: string } | null;
        if (previous?.fingerprint === fingerprint && previous.requestId)
          requestId = previous.requestId;
      } catch {
        /* discard malformed local state */
      }
      sessionStorage.setItem(
        requestKey,
        JSON.stringify({ fingerprint, requestId }),
      );
      const result: MediaImportView = await jobsApi(api).createImport(
        source,
        trim,
        requestId,
      );
      sessionStorage.setItem(storageKey, result.importId);
      setImportId(result.importId);
    } catch (error) {
      setError(friendlyError(error, t));
    } finally {
      setBusy(false);
    }
  }
  const recent =
    jobs.data?.pages
      .flatMap((page) => page.items)
      .filter((job) => activeStatuses.has(job.status))
      .slice(0, 3) ?? [];
  const allowed = session.access.allowed && policy.data?.acceptNewJobs === true;
  return (
    <div className="page-stack">
      <header className="home-summary">
        <SoloSignalMark className="home-mark" />
        <div>
          <p className="eyebrow">{t("brand")}</p>
          <h1>{t("startNewTrack")}</h1>
          <p>{t("welcomeBody")}</p>
        </div>
      </header>
      {!navigator.onLine && (
        <p className="notice" role="status">
          {t("networkOffline")}
        </p>
      )}
      {!session.access.allowed && (
        <div className="notice" role="alert">
          {session.access.reason === "EMAIL_VERIFICATION_REQUIRED"
            ? t("verificationRequired")
            : session.access.reason}
        </div>
      )}
      {policy.data && !policy.data.acceptNewJobs && (
        <div className="notice" role="alert">
          {(lang === "ar" ? policy.data.messageAr : policy.data.messageEn) ||
            t("processingUnavailable")}
        </div>
      )}
      {policy.isError && (
        <div className="notice" role="alert">
          {t("processingUnavailable")}{" "}
          <button type="button" onClick={() => void policy.refetch()}>
            {t("retry")}
          </button>
        </div>
      )}
      <section className="panel intake">
        <div className="tab-row" role="tablist" aria-label={t("source")}>
          <button
            role="tab"
            aria-selected={mode === "url"}
            className={mode === "url" ? "selected" : ""}
            onClick={() => setMode("url")}
          >
            {t("useLink")}
          </button>
          <button
            role="tab"
            aria-selected={mode === "audio"}
            className={mode === "audio" ? "selected" : ""}
            onClick={() => setMode("audio")}
          >
            {t("uploadAudio")}
          </button>
        </div>
        {mode === "url" ? (
          <form onSubmit={submitUrl} className="intake-form">
            <h2>{t("importUrl")}</h2>
            <p>
              {t("supportedSites")}: {supportedAudioSites.join(", ")}.{" "}
              {t("audioAvailability")}
            </p>
            <label>
              {t("url")}
              <input
                type="url"
                dir="ltr"
                autoComplete="url"
                required
                maxLength={2048}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://…"
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={trim}
                onChange={(event) => setTrim(event.target.checked)}
              />
              {t("trim")}
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={rights}
                onChange={(event) => setRights(event.target.checked)}
              />
              {t("rights")}
            </label>
            {error && (
              <p role="alert" className="notice">
                {error}
              </p>
            )}
            <button
              className="primary"
              disabled={!allowed || busy || !!importId}
              type="submit"
            >
              {busy ? t("loading") : t("startImport")}
            </button>
          </form>
        ) : (
          <AudioUpload allowed={allowed} policy={policy.data} />
        )}
        {importId && (
          <div className="import-state" role="status">
            {importQuery.data?.status !== "failed" &&
              importQuery.data?.status !== "submitted" && (
                <>
                  <span className="spinner" aria-hidden="true" />
                  {t("importPending")} ·{" "}
                </>
              )}
            {importQuery.data?.status
              ? statusLabel(importQuery.data.status, lang)
              : t("loading")}
            {importQuery.data?.status === "failed" && (
              <>
                <p role="alert">{friendlyError(importQuery.data.error, t)}</p>
                <button
                  onClick={() => {
                    sessionStorage.removeItem(storageKey);
                    sessionStorage.removeItem(requestKey);
                    setImportId(null);
                  }}
                >
                  {t("close")}
                </button>
              </>
            )}
          </div>
        )}
      </section>
      <section>
        <div className="section-heading">
          <h2>{t("recentActivity")}</h2>
          <Link to="/jobs">{t("all")} →</Link>
        </div>
        {jobs.isPending ? (
          <p>{t("loading")}</p>
        ) : recent.length ? (
          <div className="job-grid">
            {recent.map((job) => (
              <JobCard key={job.id} job={job} />
            ))}
          </div>
        ) : (
          <div className="empty-state">{t("noJobs")}</div>
        )}
      </section>
    </div>
  );
}
