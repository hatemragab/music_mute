import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { useState } from "react";
import { jobsApi } from "../api/jobs";
import type { JobView } from "../api/types";
import { useSignedIn } from "../auth/AuthProvider";
import { friendlyError, statusLabel, useI18n } from "../i18n";
import { usePlayer } from "../player/PlayerProvider";

const activeStatuses = new Set([
  "awaiting_upload",
  "queued",
  "validating",
  "processing",
  "uploading_result",
  "interrupted",
  "cancel_requested",
]);

export function useJobs() {
  const { api, user } = useSignedIn();
  return useInfiniteQuery({
    queryKey: [user.uid, "jobs"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => jobsApi(api).list(pageParam, signal),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: (query) =>
      document.visibilityState === "visible" &&
      query.state.data?.pages.some((page) =>
        page.items.some((job) => activeStatuses.has(job.status)),
      )
        ? 5000
        : false,
  });
}

export function JobCard({ job, queue }: { job: JobView; queue?: JobView[] }) {
  const { t, date, lang } = useI18n();
  const player = usePlayer();
  return (
    <article className="job-card">
      <div className="job-card-top">
        <span className="job-icon" aria-hidden="true">
          ♫
        </span>
        <div className="job-card-name">
          <h3>
            <Link to={`/jobs/${job.id}`} dir="auto">
              {job.displayName || job.sourceTitle || job.id}
            </Link>
          </h3>
          <small>{date(job.createdAt)}</small>
        </div>
        <span className={`status status-${job.status}`}>
          {statusLabel(job.status, lang)}
        </span>
      </div>
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
  const [filter, setFilter] = useState<"all" | "active" | "ready" | "failed">(
    "all",
  );
  const jobs = query.data?.pages.flatMap((page) => page.items) ?? [];
  const shown = jobs.filter(
    (job) =>
      filter === "all" ||
      (filter === "active"
        ? activeStatuses.has(job.status)
        : filter === "failed"
          ? ["failed", "cancelled"].includes(job.status)
          : job.status === "ready"),
  );
  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">{t("processing")}</p>
          <h1>{t("jobs")}</h1>
        </div>
        <button type="button" onClick={() => void query.refetch()}>
          {t("refresh")}
        </button>
      </header>
      <div className="filter-row" role="group" aria-label={t("status")}>
        {(["all", "active", "ready", "failed"] as const).map((item) => (
          <button
            key={item}
            type="button"
            className={filter === item ? "selected" : ""}
            onClick={() => setFilter(item)}
          >
            {t(
              item === "all"
                ? "filterAll"
                : item === "active"
                  ? "filterActive"
                  : item === "ready"
                    ? "filterReady"
                    : "filterFailed",
            )}
          </button>
        ))}
      </div>
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
            queue={jobs.filter((item) => item.canDownloadOutput)}
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
  const queryClient = useQueryClient();
  const player = usePlayer();
  const query = useQuery({
    queryKey: [user.uid, "job", id],
    queryFn: ({ signal }) => jobsApi(api).detail(id, signal),
    refetchInterval: (query) =>
      document.visibilityState === "visible" &&
      query.state.data &&
      activeStatuses.has(query.state.data.status)
        ? 4000
        : false,
  });
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
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [user.uid] });
    },
    onError: (error) => setActionError(friendlyError(error, t)),
  });
  async function download(artifact: "input" | "output") {
    try {
      const grant = await jobsApi(api).grant(id, artifact, crypto.randomUUID());
      const anchor = document.createElement("a");
      anchor.href = grant.url;
      anchor.rel = "noopener noreferrer";
      anchor.target = "_blank";
      anchor.click();
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
          <h1 dir="auto">{job.displayName || job.sourceTitle || job.id}</h1>
        </div>
        <span className={`status status-${job.status}`}>
          {statusLabel(job.status, lang)}
        </span>
      </header>
      <section className="panel detail-grid">
        <div>
          <h2>{t("status")}</h2>
          <p>{statusLabel(job.status, lang)}</p>
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
