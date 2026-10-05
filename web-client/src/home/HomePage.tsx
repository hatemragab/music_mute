import { useLiveQuery, useRealtime } from "../realtime/RealtimeProvider";
import { Link } from "react-router";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { jobsApi } from "../api/jobs";
import type { MediaImportView, ProcessingPolicyView } from "../api/types";
import { useSignedIn } from "../auth/AuthProvider";
import { friendlyError, statusLabel, useI18n } from "../i18n";
import { activeStatuses, JobCard, useJobs } from "../jobs/JobsUI";
import { supportedAudioSites, supportedAudioUrl } from "../site-policy/source";
import { AudioUpload } from "./AudioUpload";
import { SoloSignalMark } from "../brand/SoloSignalMark";

const retryableImportErrors = new Set([
  "OFFLINE",
  "SERVICE_UNAVAILABLE",
  "RATE_LIMITED",
  "IMPORT_QUEUE_FULL",
  "IMPORT_DEPENDENCY_FAILED",
  "IMPORT_DISK_FULL",
  "IMPORT_UPSTREAM_REFUSED",
  "IMPORT_SOURCE_UNAVAILABLE",
  "IMPORT_DISABLED",
  "PROCESSING_UNAVAILABLE",
]);
const requestIdPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

interface ImportSourceChoice {
  source: string;
  trimEnabled: boolean;
  rightsConfirmed: true;
}

function sourceChoice(
  view: MediaImportView,
  key: string,
): ImportSourceChoice | null {
  try {
    if (
      typeof view.sourceUrl === "string" &&
      typeof view.trimEnabled === "boolean"
    )
      return {
        source: supportedAudioUrl(view.sourceUrl),
        trimEnabled: view.trimEnabled,
        rightsConfirmed: true,
      };
    const saved: unknown = JSON.parse(sessionStorage.getItem(key) || "null");
    if (
      saved &&
      typeof saved === "object" &&
      "source" in saved &&
      typeof saved.source === "string" &&
      "trimEnabled" in saved &&
      typeof saved.trimEnabled === "boolean" &&
      "rightsConfirmed" in saved &&
      saved.rightsConfirmed === true
    )
      return {
        source: supportedAudioUrl(saved.source),
        trimEnabled: saved.trimEnabled,
        rightsConfirmed: true,
      };
  } catch {
    /* Malformed or unsupported saved links cannot start provider work. */
  }
  return null;
}

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
  const submitting = useRef<AbortController | null>(null);
  useEffect(() => () => submitting.current?.abort(), [api, user.uid]);
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
  const importIdsRef = useRef(importIds);
  const [finishedImports, setFinishedImports] = useState<Set<string>>(
    new Set(),
  );
  const markFinished = useCallback((id: string) => {
    setFinishedImports((previous) => new Set([...previous, id]));
  }, []);
  const watchedImports = new Set(
    importIds.filter((id) => !finishedImports.has(id)).slice(0, 100),
  );
  function saveImportIds(update: (ids: string[]) => string[]) {
    const ids = [...new Set(update(importIdsRef.current))];
    if (ids.length) sessionStorage.setItem(storageKey, JSON.stringify(ids));
    else sessionStorage.removeItem(storageKey);
    importIdsRef.current = ids;
    setImportIds(ids);
  }
  function replaceImport(previousId: string, result: MediaImportView) {
    saveImportIds((ids) =>
      ids.map((id) => (id === previousId ? result.importId : id)),
    );
    setFinishedImports((previous) => {
      const next = new Set(previous);
      next.delete(previousId);
      next.delete(result.importId);
      return next;
    });
  }

  async function submitUrl(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || !allowed) return;
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
    const controller = new AbortController();
    submitting.current = controller;
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
        controller.signal,
      );
      if (controller.signal.aborted) return;
      sessionStorage.setItem(
        `${storageKey}.source.${result.importId}`,
        JSON.stringify({ source, trimEnabled: trim, rightsConfirmed: true }),
      );
      saveImportIds((ids) => [...ids, result.importId]);
      sessionStorage.removeItem(requestKey);
      setUrl((current) => (current === submittedDraft ? "" : current));
    } catch (error) {
      if (!controller.signal.aborted) setError(friendlyError(error, t));
    } finally {
      if (submitting.current === controller) submitting.current = null;
      if (!controller.signal.aborted) setBusy(false);
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
            allowed={allowed}
            onTerminal={markFinished}
            onRetried={(result) => replaceImport(id, result)}
            onClose={() => {
              sessionStorage.removeItem(`${storageKey}.source.${id}`);
              sessionStorage.removeItem(`${storageKey}.retry.${id}`);
              saveImportIds((ids) => ids.filter((value) => value !== id));
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
  allowed,
  onTerminal,
  onRetried,
  onClose,
}: {
  id: string;
  active: boolean;
  allowed: boolean;
  onTerminal: (id: string) => void;
  onRetried: (result: MediaImportView) => void;
  onClose: () => void;
}) {
  const { api, user } = useSignedIn();
  const { t, lang } = useI18n();
  const client = useRealtime();
  const [current, setCurrent] = useState<MediaImportView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [retryError, setRetryError] = useState<unknown>(null);
  const [retrying, setRetrying] = useState(false);
  const retryController = useRef<AbortController | null>(null);
  useEffect(() => () => retryController.current?.abort(), [api, user.uid]);
  const storageKey = `musicmute.web.import.${user.uid}`;
  const sourceKey = `${storageKey}.source.${id}`;
  const retryKey = `${storageKey}.retry.${id}`;
  const choice = current ? sourceChoice(current, sourceKey) : null;
  const retryable =
    current?.status === "failed" &&
    !current.jobId &&
    retryableImportErrors.has(current.error?.code || "") &&
    choice !== null;

  async function retryImport() {
    if (!allowed || !retryable || !choice || retryController.current) return;
    const controller = new AbortController();
    retryController.current = controller;
    setRetrying(true);
    setRetryError(null);
    try {
      const fingerprint = `${choice.source}:${choice.trimEnabled}`;
      let requestId: string = crypto.randomUUID();
      try {
        const saved = JSON.parse(
          sessionStorage.getItem(retryKey) || "null",
        ) as { fingerprint?: string; requestId?: string } | null;
        if (
          saved?.fingerprint === fingerprint &&
          saved.requestId &&
          requestIdPattern.test(saved.requestId)
        )
          requestId = saved.requestId;
      } catch {
        /* Replace malformed admission recovery identity before the explicit retry. */
      }
      sessionStorage.setItem(
        retryKey,
        JSON.stringify({ fingerprint, requestId }),
      );
      const result = await jobsApi(api).createImport(
        choice.source,
        choice.trimEnabled,
        requestId,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      sessionStorage.setItem(
        `${storageKey}.source.${result.importId}`,
        JSON.stringify(choice),
      );
      onRetried(result);
      sessionStorage.removeItem(retryKey);
      if (result.importId !== id) sessionStorage.removeItem(sourceKey);
    } catch (error) {
      if (!controller.signal.aborted) setRetryError(error);
    } finally {
      if (retryController.current === controller)
        retryController.current = null;
      if (!controller.signal.aborted) setRetrying(false);
    }
  }
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
    <div
      className="import-state"
      role="status"
      data-reload-blocked={retrying ? "true" : undefined}
    >
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
      {retryError != null && <p role="alert">{friendlyError(retryError, t)}</p>}
      {retryable && (
        <button
          type="button"
          disabled={!allowed || retrying}
          onClick={() => void retryImport()}
        >
          {retrying ? t("loading") : t("tryAgain")}
        </button>
      )}
      {current?.status === "submitted" && current.jobId && (
        <Link to={`/jobs/${current.jobId}`}>{t("details")}</Link>
      )}
      {terminal && (
        <button type="button" disabled={retrying} onClick={onClose}>
          {t("close")}
        </button>
      )}
    </div>
  );
}
