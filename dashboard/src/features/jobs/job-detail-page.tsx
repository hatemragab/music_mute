import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Ban, RefreshCw } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";

import { createOperationId } from "@/api/api-client";
import type { JobDetail } from "@/api/contracts";
import { useAdminSession, useApiClient } from "@/auth/admin-session";
import { CursorPagination } from "@/components/cursor-pagination";
import {
  ErrorState,
  LoadingState,
  PageHeader,
  PageSection,
} from "@/components/page";
import { ReasonDialog } from "@/components/reason-dialog";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime, formatDuration } from "@/lib/format";
import { useVisibleInterval } from "@/hooks/use-visible-interval";
import { cancelJob, getJob, getJobAttempts, retryJob } from "./jobs-api";
import { JobAttemptTimeline } from "./job-attempt-timeline";
import { JobMediaPanel } from "./job-media-panel";
import { JobSourceLink } from "./job-source-link";

type JobAction = "cancel" | "retry";

export function JobDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const attemptCursor = searchParams.get("attemptCursor");
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { can } = useAdminSession();
  const [action, setAction] = useState<JobAction | null>(null);
  const job = useQuery({
    queryKey: ["job", id],
    queryFn: () => getJob(client, id),
    enabled: Boolean(id),
  });
  const attempts = useQuery({
    queryKey: ["job-attempts", id, attemptCursor],
    queryFn: () => getJobAttempts(client, id, attemptCursor),
    enabled: Boolean(id),
  });
  useVisibleInterval(() => {
    void job.refetch();
    void attempts.refetch();
  }, 10_000);
  const mutate = useMutation({
    mutationFn: async ({
      current,
      action,
      reason,
    }: {
      current: JobDetail;
      action: JobAction;
      reason: string;
    }) => {
      const command = {
        expectedRevision: current.revision,
        operationId: createOperationId(),
        reason,
      };
      return action === "cancel"
        ? cancelJob(client, current.id, command)
        : retryJob(client, current.id, command);
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["job", id] });
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
      if ("newJobId" in result) navigate(`/jobs/${result.newJobId}`);
    },
  });
  if (job.isLoading) return <LoadingState />;
  if (job.isError || !job.data)
    return <ErrorState error={job.error} retry={() => void job.refetch()} />;
  const data = job.data;
  const cancelEligible = [
    "awaiting_upload",
    "queued",
    "validating",
    "processing",
    "uploading_result",
  ].includes(data.status);
  const retryEligible = data.status === "failed" && !data.recoveryRequired;
  return (
    <div className="space-y-6">
      <Link
        to="/jobs"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-4" /> Jobs
      </Link>
      <PageHeader
        title={data.displayName || `Job ${data.id.slice(-8)}`}
        description={data.id}
        actions={
          can("jobs.manage") ? (
            <div className="flex gap-2">
              {cancelEligible ? (
                <Button variant="outline" onClick={() => setAction("cancel")}>
                  <Ban aria-hidden="true" /> Request cancellation
                </Button>
              ) : null}
              {retryEligible ? (
                <Button onClick={() => setAction("retry")}>
                  <RefreshCw aria-hidden="true" /> Retry as new job
                </Button>
              ) : null}
            </div>
          ) : undefined
        }
      />
      {data.recoveryRequired ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
          <strong>Recovery required.</strong> Ordinary retry is unavailable
          until an authorized worker recovery records proof that the old process
          stopped.
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="space-y-4 p-5">
            <PageSection title="Job state">
              <div className="flex gap-2">
                <StatusBadge value={data.status} />
                {data.recoveryRequired ? (
                  <StatusBadge value="warning" label="Recovery required" />
                ) : null}
              </div>
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-muted-foreground">User</dt>
                  <dd>{data.userDisplayName ?? data.userId}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Worker</dt>
                  <dd>
                    {data.workerId ? (
                      can("workers.read") ? (
                        <Link
                          className="text-primary hover:underline"
                          to={`/workers/${data.workerId}`}
                        >
                          {data.workerId}
                        </Link>
                      ) : (
                        data.workerId
                      )
                    ) : (
                      "Unassigned"
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Queue position</dt>
                  <dd>{data.queuePosition ?? "Not queued"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Elapsed</dt>
                  <dd>{formatDuration(data.elapsedSeconds)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Created</dt>
                  <dd>{formatDateTime(data.createdAt)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Finished</dt>
                  <dd>{formatDateTime(data.finishedAt)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Source category</dt>
                  <dd>{data.source?.replaceAll("_", " ") ?? "Unavailable"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    Declared / measured audio
                  </dt>
                  <dd>
                    {formatDuration(data.declaredDurationSeconds)} /{" "}
                    {formatDuration(data.measuredDurationSeconds)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    Declared / measured bytes
                  </dt>
                  <dd>
                    {data.declaredBytes?.toLocaleString() ?? "Unavailable"} /{" "}
                    {data.measuredBytes?.toLocaleString() ?? "Unavailable"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    Estimated worker time
                  </dt>
                  <dd>
                    {data.estimatedWorkerSeconds == null
                      ? "Unavailable"
                      : formatDuration(data.estimatedWorkerSeconds)}
                  </dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-muted-foreground">Source URL</dt>
                  <dd>
                    <JobSourceLink
                      sourceUrl={data.sourceUrl}
                      className="break-all text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </dd>
                </div>
              </dl>
              {data.lastError ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
                  <strong>{data.lastError.code}</strong>
                  <p>
                    {data.lastError.message ??
                      "No safe error detail is available."}
                  </p>
                </div>
              ) : null}
            </PageSection>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <PageSection title="Stage timing">
              <ul className="space-y-3">
                {data.stageTimings.map((stage) => (
                  <li
                    key={stage.stage}
                    className="grid grid-cols-[1fr_auto] gap-3 border-b pb-2 text-sm"
                  >
                    <span className="capitalize">
                      {stage.stage.replaceAll("_", " ")}
                    </span>
                    <span className="font-mono text-muted-foreground">
                      {formatDuration(stage.durationSeconds)}
                    </span>
                  </li>
                ))}
              </ul>
            </PageSection>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardContent className="p-5">
          <PageSection
            title="Attempt history"
            description="Attempts are independent records; retry creates a new job."
          >
            {attempts.isLoading ? (
              <LoadingState rows={2} />
            ) : attempts.isError ? (
              <ErrorState
                error={attempts.error}
                retry={() => void attempts.refetch()}
              />
            ) : (
              <>
                <JobAttemptTimeline attempts={attempts.data?.items ?? []} />
              </>
            )}
            <CursorPagination
              cursor={attemptCursor}
              nextCursor={attempts.data?.nextCursor ?? null}
              pending={attempts.isFetching}
              onCursorChange={(value) => {
                const next = new URLSearchParams(searchParams);
                if (value) next.set("attemptCursor", value);
                else next.delete("attemptCursor");
                setSearchParams(next);
              }}
            />
          </PageSection>
        </CardContent>
      </Card>
      <JobMediaPanel job={data} />
      <ReasonDialog
        open={Boolean(action)}
        onOpenChange={(open) => {
          if (!open) setAction(null);
        }}
        title={
          action === "cancel"
            ? "Request job cancellation"
            : "Retry as a new job"
        }
        description={
          action === "cancel"
            ? "Processing jobs move to cancellation requested until the worker confirms a terminal state."
            : "The failed source remains unchanged. A successful retry opens the new queued job."
        }
        confirmLabel={
          action === "cancel" ? "Request cancellation" : "Create retry job"
        }
        destructive={action === "cancel"}
        summary={<p className="font-mono break-all">{data.id}</p>}
        onConfirm={(reason) =>
          action
            ? mutate
                .mutateAsync({ current: data, action, reason })
                .then(() => undefined)
            : Promise.resolve()
        }
      />
    </div>
  );
}
