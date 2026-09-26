import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { useEffect, useState, type FormEvent } from "react";
import { jobsApi } from "../api/jobs";
import type { MediaImportView } from "../api/types";
import { useSignedIn } from "../auth/AuthProvider";
import { friendlyError, statusLabel, useI18n } from "../i18n";
import { JobCard, useJobs } from "../jobs/JobsUI";
import { AudioUpload } from "./AudioUpload";

export function HomePage() {
  const { api, user, session } = useSignedIn();
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const jobs = useJobs();
  const policy = useQuery({
    queryKey: [user.uid, "processing-policy"],
    queryFn: ({ signal }) => jobsApi(api).policy(signal),
    staleTime: 60_000,
  });
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
  const importQuery = useQuery({
    queryKey: [user.uid, "import", importId],
    enabled: !!importId,
    queryFn: ({ signal }) => jobsApi(api).import(importId!, signal),
    refetchInterval: (query) =>
      document.visibilityState === "visible" &&
      query.state.data &&
      !["submitted", "failed"].includes(query.state.data.status)
        ? 4000
        : false,
  });
  useEffect(() => {
    const current = importQuery.data;
    if (current?.status === "submitted" && current.jobId) {
      sessionStorage.removeItem(storageKey);
      sessionStorage.removeItem(requestKey);
      void queryClient.invalidateQueries({ queryKey: [user.uid, "jobs"] });
      navigate(`/jobs/${current.jobId}`);
    }
  }, [
    importQuery.data,
    navigate,
    queryClient,
    requestKey,
    storageKey,
    user.uid,
  ]);

  async function submitUrl(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!rights) {
      setError(t("missingRights"));
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
        throw new Error();
    } catch {
      setError(t("url"));
      return;
    }
    setBusy(true);
    try {
      const fingerprint = `${parsed.toString()}:${trim}`;
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
        parsed.toString(),
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
  const recent = jobs.data?.pages[0]?.items.slice(0, 3) ?? [];
  const allowed = session.access.allowed && policy.data?.acceptNewJobs === true;
  return (
    <div className="page-stack">
      <section className="hero">
        <div>
          <p className="eyebrow">{t("brand")}</p>
          <h1>{t("welcome")}</h1>
          <p>{t("welcomeBody")}</p>
        </div>
        <div className="wave-art" aria-hidden="true" />
      </section>
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
            <span className="spinner" />
            {t("importPending")} ·{" "}
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
          <h2>{t("jobs")}</h2>
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
