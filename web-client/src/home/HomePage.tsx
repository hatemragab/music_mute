import { useLiveQuery, useRealtime } from "../realtime/RealtimeProvider";
import { Link } from "react-router";
import { useCallback, useEffect, useState, type FormEvent } from "react";
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
  const [importIds, setImportIds] = useState<string[]>(() => {
    const saved = sessionStorage.getItem(storageKey);
    if (!saved) return [];
    try {
      const values: unknown = JSON.parse(saved);
      if (Array.isArray(values))
        return [
          ...new Set(
            values.filter(
              (id): id is string =>
                typeof id === "string" && /^[a-f0-9]{24}$/.test(id),
            ),
          ),
        ];
    } catch {
      /* restore the previous single-import format */
    }
    if (/^[a-f0-9]{24}$/.test(saved)) {
      sessionStorage.removeItem(requestKey);
      return [saved];
    }
    return [];
  });
  const [finishedImports, setFinishedImports] = useState<Set<string>>(
    new Set(),
  );
  const markFinished = useCallback((id: string) => {
    setFinishedImports((previous) => new Set([...previous, id]));
  }, []);
  const watchedImports = new Set(
    importIds.filter((id) => !finishedImports.has(id)).slice(0, 100),
  );
  function saveImportIds(ids: string[]) {
    if (ids.length) sessionStorage.setItem(storageKey, JSON.stringify(ids));
    else sessionStorage.removeItem(storageKey);
    setImportIds(ids);
  }

  async function submitUrl(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (!rights) {
      setError(t("missingRights"));
      return;
    }
    const submittedDraft = url;
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
      saveImportIds([...new Set([...importIds, result.importId])]);
      sessionStorage.removeItem(requestKey);
      setUrl((current) => (current === submittedDraft ? "" : current));
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
              disabled={!allowed || busy}
              type="submit"
            >
              {busy ? t("loading") : t("startImport")}
            </button>
          </form>
        ) : (
          <AudioUpload allowed={allowed} policy={policy.data} />
        )}
        {importIds.map((id) => (
          <ImportProgress
            key={id}
            id={id}
            active={watchedImports.has(id)}
            onTerminal={markFinished}
            onClose={() => {
              saveImportIds(importIds.filter((value) => value !== id));
            }}
          />
        ))}
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

function ImportProgress({
  id,
  active,
  onTerminal,
  onClose,
}: {
  id: string;
  active: boolean;
  onTerminal: (id: string) => void;
  onClose: () => void;
}) {
  const { user } = useSignedIn();
  const { t, lang } = useI18n();
  const client = useRealtime();
  const [current, setCurrent] = useState<MediaImportView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const terminal =
    current?.status === "failed" || current?.status === "submitted";
  useEffect(() => {
    if (!active || terminal) return;
    return client.watch("import", { id }, (result) => {
      if (result.error) setError(result.error);
      else {
        const value = result.data as MediaImportView;
        setCurrent(value);
        setError(null);
        if (["failed", "submitted"].includes(value.status)) onTerminal(id);
      }
    });
  }, [client, id, active, terminal, onTerminal, user.uid]);
  return (
    <div className="import-state" role="status">
      {!terminal && (
        <>
          <span className="spinner" aria-hidden="true" />
          {t("importPending")} ·{" "}
        </>
      )}
      {current?.status ? statusLabel(current.status, lang) : t("loading")}
      {error != null && <p role="alert">{friendlyError(error, t)}</p>}
      {current?.status === "failed" && (
        <p role="alert">{friendlyError(current.error, t)}</p>
      )}
      {current?.status === "submitted" && current.jobId && (
        <Link to={`/jobs/${current.jobId}`}>{t("details")}</Link>
      )}
      {terminal && <button onClick={onClose}>{t("close")}</button>}
    </div>
  );
}
