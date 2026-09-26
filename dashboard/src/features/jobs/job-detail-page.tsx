import { useLiveQuery, useRealtime } from "@/realtime/hooks";
import { useState, useSyncExternalStore } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { JobStageTimings } from "./job-stage-timings";
import { formatStageDuration } from "./job-timing-format";
import { ArrowLeft, Ban } from "lucide-react";
import { Link, useParams } from "react-router";

import { createOperationId } from "@/api/api-client";
import type { JobDetail } from "@/api/contracts";
import { useAdminSession, useApiClient } from "@/auth/admin-session";
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
import { cancelJob } from "./jobs-api";
import { JobMediaPanel } from "./job-media-panel";
import { JobSourceLink } from "./job-source-link";

export function JobDetailPage() {
  const { id = "" } = useParams();
  const client = useApiClient();
  const realtime = useRealtime();
  const connection = useSyncExternalStore(realtime.onState, realtime.getState);
  const queryClient = useQueryClient();
  const { can } = useAdminSession();
  const [cancelling, setCancelling] = useState(false);
  const job = useLiveQuery({
    queryKey: ["job", id],
    resource: "admin.job",
    params: { id },
    enabled: Boolean(id),
  });
  const mutate = useMutation({
    mutationFn: async ({
      current,
      reason,
    }: {
      current: JobDetail;
      reason: string;
    }) => {
      const command = {
        expectedRevision: current.revision,
        operationId: createOperationId(),
        reason,
      };
      return cancelJob(client, current.id, command);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["job", id] });
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
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
          <>
            {can("jobs.manage") && cancelEligible ? (
              <Button variant="outline" onClick={() => setCancelling(true)}>
                <Ban aria-hidden="true" /> Request cancellation
              </Button>
            ) : null}
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="space-y-4 p-5">
            <PageSection title="Job state">
              <StatusBadge value={data.status} />
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-muted-foreground">User</dt>
                  <dd>{data.userDisplayName ?? data.userId}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Queue position</dt>
                  <dd>
                    {data.status !== "queued"
                      ? "Not queued"
                      : connection !== "live"
                        ? "Reconnecting…"
                        : (data.queuePosition ??
                          "Waiting · position unavailable")}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Server total</dt>
                  <dd>
                    {data.serverStageTimings?.totalMs != null &&
                    !data.serverStageTimings.totalComplete
                      ? "At least "
                      : ""}
                    {formatStageDuration(data.serverStageTimings?.totalMs)}
                  </dd>
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
            <PageSection title="Stage durations">
              <JobStageTimings
                timings={data.serverStageTimings}
                workerTimings={data.workerStageTimings}
              />
            </PageSection>
          </CardContent>
        </Card>
      </div>
      <JobMediaPanel job={data} />
      <ReasonDialog
        open={cancelling}
        onOpenChange={(open) => {
          if (!open) setCancelling(false);
        }}
        title="Request job cancellation"
        description="Active jobs move to cancellation requested; inactive jobs are cancelled immediately."
        confirmLabel="Request cancellation"
        destructive
        summary={<p className="font-mono break-all">{data.id}</p>}
        onConfirm={(reason) =>
          mutate.mutateAsync({ current: data, reason }).then(() => undefined)
        }
      />
    </div>
  );
}
