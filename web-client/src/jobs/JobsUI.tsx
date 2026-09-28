import { useMutation } from "@tanstack/react-query";
import { Music2 } from "lucide-react";
import { useLiveJobs, useLiveQuery } from "../realtime/RealtimeProvider";
import { Link, useNavigate, useParams } from "react-router";
import { useState } from "react";
import { jobsApi } from "../api/jobs";
import type { JobView } from "../api/types";
import { useSignedIn } from "../auth/AuthProvider";
import { friendlyError, statusLabel, useI18n } from "../i18n";
import { usePlayer } from "../player/PlayerProvider";
import { downloadJobArtifact } from "./artifacts";
import { trackTitle } from "../player/playback";
import { QueuePosition } from "./QueuePosition";

export const activeStatuses = new Set([
  "awaiting_upload",
  "queued",
  "validating",
  "processing",
  "uploading_result",
  "interrupted",
  "cancel_requested",
]);

export const useJobs = useLiveJobs;

export function JobCard({ job, queue }: { job: JobView; queue?: JobView[] }) {
  const { t, date, lang } = useI18n();
  const player = usePlayer();
  return (
    <article className="job-card">
      <div className="job-card-top">
        <span className="job-icon" aria-hidden="true">
          <Music2 />
        </span>
        <div className="job-card-name">
          <h3>
            <Link to={`/jobs/${job.id}`} dir="auto">
              {trackTitle(job, t("untitledTrack"))}
            </Link>
          </h3>
          <small>{date(job.createdAt)}</small>
        </div>
        <span className={`status status-${job.status}`}>
          {statusLabel(job.status, lang)}
        </span>
      </div>
      <QueuePosition job={job} />
      {job.processingProgress && (
        <div className="job-progress">
          <span>{statusLabel(job.processingProgress.phase, lang)}</span>
          {job.processingProgress.phasePercent !== null && (
            <progress
              max="100"
              value={job.processingProgress.phasePercent}
              aria-label={t("progress")}
            />
          )}
        </div>
      )}
      {job.error && (
        <p className="notice" role="alert">
          {friendlyError(job.error, t)}
        </p>
      )}
      <div className="card-actions">
        <Link className="subtle-button" to={`/jobs/${job.id}`}>
          {t("details")}
        </Link>
        {job.canDownloadOutput && (
          <button type="button" onClick={() => void player.play(job, queue)}>
            {t("play")}
          </button>
        )}
      </div>
    </article>
  );
}

export function JobsPage() {
  const { t } = useI18n();
  const query = useJobs();
  const shown = (query.data?.pages.flatMap((page) => page.items) ?? []).filter(
    (job) => activeStatuses.has(job.status),
  );
  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">{t("processing")}</p>
          <h1>{t("jobs")}</h1>
        </div>
      </header>
      {query.isPending && <p>{t("loading")}</p>}
      {query.isError && (
        <p role="alert" className="notice">
          {t("requestFailed")}
        </p>
      )}
      {!query.isPending && !query.isError && shown.length === 0 && (
        <div className="empty-state">{t("noJobs")}</div>
      )}
      <div className="job-grid">
        {shown.map((job) => (
          <JobCard
            key={job.id}
            job={job}
            queue={shown.filter((item) => item.canDownloadOutput)}
          />
        ))}
      </div>
      {query.hasNextPage && (
        <button
          type="button"
          className="secondary"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? t("loading") : t("loadMore")}
        </button>
      )}
    </div>
  );
}

export function JobDetailPage() {
  const { id = "" } = useParams();
  const { api, user } = useSignedIn();
  const { t, date, lang } = useI18n();
  const navigate = useNavigate();
  const player = usePlayer();
  const query = useLiveQuery<JobView>([user.uid, "job", id], "job", { id });
  const [actionError, setActionError] = useState("");
  const mutate = useMutation({
    mutationFn: async (kind: "cancel" | "retry" | "rename" | "delete") => {
      if (kind === "cancel") {
        if (!confirm(t("cancelConfirm"))) return;
        await jobsApi(api).cancel(id);
      }
      if (kind === "retry") await jobsApi(api).retry(id, crypto.randomUUID());
      if (kind === "rename") {
        const name = prompt(
          t("renamePrompt"),
          query.data?.displayName || query.data?.sourceTitle || "",
        );
        if (name?.trim()) await jobsApi(api).rename(id, name.trim());
      }
      if (kind === "delete") {
        if (!confirm(t("deleteConfirm"))) return;
        await jobsApi(api).delete(id);
        navigate("/jobs");
      }
    },
    onError: (error) => setActionError(friendlyError(error, t)),
  });
  async function download(artifact: "input" | "output") {
    try {
      await downloadJobArtifact(api, id, artifact);
    } catch (error) {
      setActionError(friendlyError(error, t));
    }
  }
  if (query.isPending)
    return (
      <div className="page-stack">
        <p>{t("loading")}</p>
      </div>
    );
  if (query.isError || !query.data)
    return (
      <div className="page-stack">
        <p role="alert" className="notice">
          {t("requestFailed")}
        </p>
        <button onClick={() => void query.refetch()}>{t("retry")}</button>
      </div>
    );
  const job = query.data;
  return (
    <div className="page-stack">
      <Link to="/jobs">← {t("backToJobs")}</Link>
      <header className="page-heading">
        <div>
          <p className="eyebrow">{t("details")}</p>
          <h1 dir="auto">{trackTitle(job, t("untitledTrack"))}</h1>
        </div>
        <span className={`status status-${job.status}`}>
          {statusLabel(job.status, lang)}
        </span>
      </header>
      <section className="panel detail-grid">
        <div>
          <h2>{t("status")}</h2>
          <p>{statusLabel(job.status, lang)}</p>
          <QueuePosition job={job} />
          <p>
            {t("created")}: {date(job.createdAt)}
          </p>
          <p>
            {t("source")}: {job.sourceKind || t("file")}
          </p>
          <p className="identifier" dir="ltr">
            {job.id}
          </p>
        </div>
        <div className="wave-art compact" aria-hidden="true" />
      </section>
      {job.processingProgress && (
        <section className="panel">
          <h2>{t("progress")}</h2>
          <p>{statusLabel(job.processingProgress.phase, lang)}</p>
          {job.processingProgress.phasePercent !== null && (
            <progress max="100" value={job.processingProgress.phasePercent} />
          )}
        </section>
      )}
      {job.error && (
        <p role="alert" className="notice">
          {friendlyError(job.error, t)}
        </p>
      )}
      {actionError && (
        <p role="alert" className="notice">
          {actionError}
        </p>
      )}
      <div className="action-row">
        {job.canDownloadOutput && (
          <>
            <button
              className="primary"
              type="button"
              onClick={() => void player.play(job)}
            >
              {t("play")}
            </button>
            <button type="button" onClick={() => void download("output")}>
              {t("download")} {t("outputTrack")}
            </button>
          </>
        )}
        {job.canDownloadInput && (
          <button type="button" onClick={() => void download("input")}>
            {t("download")} {t("inputTrack")}
          </button>
        )}
        {activeStatuses.has(job.status) && (
          <button
            type="button"
            disabled={mutate.isPending}
            onClick={() => mutate.mutate("cancel")}
          >
            {t("cancelJob")}
          </button>
        )}
        {job.status === "failed" && (
          <button
            type="button"
            disabled={mutate.isPending}
            onClick={() => mutate.mutate("retry")}
          >
            {t("retryJob")}
          </button>
        )}
        <button
          type="button"
          disabled={mutate.isPending}
          onClick={() => mutate.mutate("rename")}
        >
          {t("rename")}
        </button>
        <button
          className="danger"
          type="button"
          disabled={mutate.isPending}
          onClick={() => mutate.mutate("delete")}
        >
          {t("deleteJob")}
        </button>
      </div>
    </div>
  );
}
