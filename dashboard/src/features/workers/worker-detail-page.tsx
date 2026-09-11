import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, RotateCw, ShieldX, Waves } from "lucide-react";
import { Link, useParams } from "react-router";

import { createOperationId } from "@/api/api-client";
import type { WorkerDetail } from "@/api/contracts";
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
import { formatDateTime } from "@/lib/format";
import { useVisibleInterval } from "@/hooks/use-visible-interval";
import { getWorker, releaseStoppedWorker, workerAction } from "./workers-api";
import { WorkerKeyDialog } from "./worker-key-dialog";
import {
  WorkerRecoveryDialog,
  type RecoveryEvidence,
} from "./worker-recovery-dialog";
import { workerCapacityLabel } from "./worker-status";

type Action = "drain" | "enable" | "rotate-key" | "revoke";

export function WorkerDetailPage() {
  const { id = "" } = useParams();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { can, reauthenticate } = useAdminSession();
  const [action, setAction] = useState<Action | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [rawKey, setRawKey] = useState<string | null>(null);
  const worker = useQuery({
    queryKey: ["worker", id],
    queryFn: () => getWorker(client, id),
    enabled: Boolean(id),
  });
  useVisibleInterval(() => void worker.refetch(), 15_000);
  const mutate = useMutation({
    mutationFn: ({
      current,
      action,
      reason,
    }: {
      current: WorkerDetail;
      action: Action;
      reason: string;
    }) =>
      workerAction(client, current.id, action, {
        expectedRevision: current.revision,
        operationId: createOperationId(),
        reason,
        ...(action === "revoke"
          ? { emergency: Boolean(current.activeAttemptId) }
          : {}),
      }),
    onSuccess: async (result) => {
      if ("rawKey" in result) setRawKey(result.rawKey);
      await queryClient.invalidateQueries({ queryKey: ["worker", id] });
      await queryClient.invalidateQueries({ queryKey: ["workers"] });
    },
  });
  const recover = useMutation({
    mutationFn: ({
      current,
      evidence,
    }: {
      current: WorkerDetail;
      evidence: RecoveryEvidence;
    }) => {
      const assignment = current.assignment;
      if (!assignment)
        throw new Error("The current assignment is no longer available.");
      return releaseStoppedWorker(client, current.id, {
        expectedRevision: current.revision,
        operationId: createOperationId(),
        reason: evidence.reason,
        jobId: assignment.jobId,
        attemptId: assignment.attemptId,
        sessionId: assignment.sessionId,
        generation: assignment.generation,
        stoppedAt: evidence.stoppedAt,
        stopEvidence: evidence.stopEvidence,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["worker", id] });
      await queryClient.invalidateQueries({ queryKey: ["workers"] });
    },
  });
  if (worker.isLoading) return <LoadingState />;
  if (worker.isError || !worker.data)
    return (
      <ErrorState error={worker.error} retry={() => void worker.refetch()} />
    );
  const data = worker.data;
  return (
    <div className="space-y-6">
      <Link
        to="/workers"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-4" /> Workers
      </Link>
      <PageHeader
        title={data.label}
        description={`Worker ${data.id}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {can("workers.manage") && data.state === "enabled" ? (
              <Button variant="outline" onClick={() => setAction("drain")}>
                <Waves aria-hidden="true" /> Drain
              </Button>
            ) : null}
            {can("workers.manage") &&
            data.state === "draining" &&
            !data.activeAttemptId ? (
              <Button variant="outline" onClick={() => setAction("enable")}>
                Enable
              </Button>
            ) : null}
            {can("workers.manage") &&
            data.state !== "revoked" &&
            !data.activeAttemptId ? (
              <Button variant="outline" onClick={() => setAction("rotate-key")}>
                <RotateCw aria-hidden="true" /> Rotate key
              </Button>
            ) : null}
            {can("workers.manage") && data.state !== "revoked" ? (
              <Button variant="destructive" onClick={() => setAction("revoke")}>
                <ShieldX aria-hidden="true" /> Revoke
              </Button>
            ) : null}
            {can("workers.recover") && data.assignment ? (
              <Button variant="destructive" onClick={() => setRecovering(true)}>
                Release stopped work
              </Button>
            ) : null}
          </div>
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="space-y-4 p-5">
            <PageSection title="State">
              <div className="flex flex-wrap gap-2">
                <StatusBadge value={data.state} />
                <StatusBadge value={data.online ? "online" : "offline"} />
                <StatusBadge value={data.slotState} />
              </div>
              <p className="text-sm text-muted-foreground">
                {workerCapacityLabel(data)}
              </p>
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-muted-foreground">Last seen</dt>
                  <dd>{formatDateTime(data.lastSeenAt)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Protocol</dt>
                  <dd>v{data.protocolVersion}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Revision</dt>
                  <dd className="font-mono">{data.revision}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Recovery</dt>
                  <dd>{data.recoveryRequired ? "Required" : "Not required"}</dd>
                </div>
              </dl>
            </PageSection>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <PageSection title="Current assignment">
              {data.assignment ? (
                <dl className="grid gap-3 text-sm">
                  <div>
                    <dt className="text-muted-foreground">Job</dt>
                    <dd>
                      {can("jobs.read") ? (
                        <Link
                          className="font-mono text-primary hover:underline"
                          to={`/jobs/${data.assignment.jobId}`}
                        >
                          {data.assignment.jobId}
                        </Link>
                      ) : (
                        <span className="font-mono">Restricted</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Attempt</dt>
                    <dd className="font-mono break-all">
                      {data.assignment.attemptId}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      Session / generation
                    </dt>
                    <dd className="font-mono break-all">
                      {data.assignment.sessionId} / {data.assignment.generation}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Lease observation</dt>
                    <dd>{formatDateTime(data.assignment.leaseExpiresAt)}</dd>
                  </div>
                </dl>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No active assignment.
                </p>
              )}
            </PageSection>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardContent className="p-5">
          <PageSection title="Recent safe events">
            {data.recentEvents.length ? (
              <ul className="divide-y">
                {data.recentEvents.map((event, index) => (
                  <li
                    className="flex items-center justify-between gap-4 py-3 text-sm"
                    key={`${event.id}-${index}`}
                  >
                    <div>
                      <p className="font-medium">{event.action}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDateTime(event.at)}
                      </p>
                    </div>
                    <StatusBadge value={event.outcome} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No recent events.</p>
            )}
          </PageSection>
        </CardContent>
      </Card>
      <ReasonDialog
        open={Boolean(action)}
        onOpenChange={(open) => {
          if (!open) setAction(null);
        }}
        title={`${action?.replace("-", " ") ?? "Worker"} confirmation`}
        description={
          action === "revoke"
            ? "Revoking credentials does not free or retry unfinished work."
            : action === "drain"
              ? "The current job can finish; no new work will be claimed."
              : "This action uses the latest observed worker revision."
        }
        confirmLabel={`Confirm ${action ?? "action"}`}
        destructive={action === "revoke"}
        freshAuth={action === "rotate-key" || action === "revoke"}
        onReauthenticate={reauthenticate}
        onConfirm={(reason) =>
          action
            ? mutate
                .mutateAsync({ current: data, action, reason })
                .then(() => undefined)
            : Promise.resolve()
        }
        summary={
          <p>
            {data.label} · revision {data.revision}
          </p>
        }
      />
      <WorkerRecoveryDialog
        worker={data}
        open={recovering}
        onOpenChange={setRecovering}
        reauthenticate={reauthenticate}
        onSubmit={(evidence) =>
          recover.mutateAsync({ current: data, evidence }).then(() => undefined)
        }
      />
      <WorkerKeyDialog
        value={rawKey}
        workerId={data.id}
        onClear={() => setRawKey(null)}
      />
    </div>
  );
}
