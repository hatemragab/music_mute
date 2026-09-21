import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowLeft,
  Ban,
  CirclePause,
  Gauge,
  HeartPulse,
  Play,
} from "lucide-react";
import { Link, useParams } from "react-router";

import { createOperationId } from "@/api/api-client";
import { DASHBOARD_POLL_INTERVAL_MS } from "@/app/polling";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useVisibleInterval } from "@/hooks/use-visible-interval";
import { formatBytes, formatDateTime } from "@/lib/format";
import {
  changeWorkerMachineState,
  getWorkerDiagnostics,
  getWorkerMachine,
  requestWorkerBenchmark,
  requestWorkerDoctor,
} from "./worker-api";
import {
  boundedDiagnosticLines,
  redactPrivateDiagnosticText,
  workerContactState,
} from "./worker-status";
import type { WorkerMachineDetail } from "./worker-types";

type MachineAction =
  "pause" | "drain" | "resume" | "revoke" | "doctor" | "benchmark";

const actionCopy: Record<
  MachineAction,
  { title: string; description: string; label: string; destructive?: boolean }
> = {
  pause: {
    title: "Pause worker machine",
    description: "New claims stop immediately. Active work is not terminated.",
    label: "Pause machine",
  },
  drain: {
    title: "Drain worker machine",
    description: "Stop new claims and allow active attempts to finish.",
    label: "Start draining",
  },
  resume: {
    title: "Resume worker machine",
    description:
      "The machine becomes eligible for new claims after policy sync.",
    label: "Resume machine",
  },
  revoke: {
    title: "Revoke worker machine",
    description:
      "This invalidates the machine credential and expires active leases. It cannot be undone from the dashboard.",
    label: "Revoke machine",
    destructive: true,
  },
  doctor: {
    title: "Request runtime doctor",
    description:
      "Queue bounded service, storage, model, provider and FFmpeg checks for this machine.",
    label: "Request doctor",
  },
  benchmark: {
    title: "Request one benchmark",
    description:
      "Queue one iteration of the first qualified recipe. The command defers while a slot is busy.",
    label: "Request benchmark",
  },
};

export function WorkerMachinePage() {
  const { id = "" } = useParams();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { can, reauthenticate } = useAdminSession();
  const [pendingAction, setPendingAction] = useState<MachineAction | null>(
    null,
  );
  const machine = useQuery({
    queryKey: ["worker-machine", id],
    queryFn: () => getWorkerMachine(client, id),
    enabled: Boolean(id),
  });
  const diagnostics = useQuery({
    queryKey: ["worker-diagnostics", id],
    queryFn: () => getWorkerDiagnostics(client, id),
    enabled: Boolean(id) && can("workers.logs.read"),
  });
  useVisibleInterval(() => {
    void machine.refetch();
    if (can("workers.logs.read")) void diagnostics.refetch();
  }, DASHBOARD_POLL_INTERVAL_MS.live);
  const mutation = useMutation({
    mutationFn: async ({
      action,
      reason,
      current,
    }: {
      action: MachineAction;
      reason: string;
      current: WorkerMachineDetail;
    }) => {
      const command = {
        operationId: createOperationId(),
        expectedRevision: current.machine.revision,
        reason,
      };
      if (action === "doctor")
        return requestWorkerDoctor(client, id, {
          ...command,
          checks: ["service", "storage", "model", "provider", "ffmpeg"],
        });
      if (action === "benchmark") {
        const recipeId = current.machine.capabilities
          .flatMap((capability) => capability.recipeIds)
          .at(0);
        if (!recipeId)
          throw new Error("This machine has no qualified benchmark recipe.");
        return requestWorkerBenchmark(client, id, {
          ...command,
          recipeId,
          iterations: 1,
        });
      }
      return changeWorkerMachineState(client, id, action, command);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["worker-machine", id] });
      await queryClient.invalidateQueries({ queryKey: ["worker-machines"] });
      setPendingAction(null);
    },
  });

  if (machine.isLoading) return <LoadingState />;
  if (machine.isError)
    return (
      <ErrorState error={machine.error} retry={() => void machine.refetch()} />
    );
  if (!machine.data) return null;
  const data = machine.data;
  const currentAttempt = data.attempts.find((attempt) =>
    ["claimed", "running", "uploading"].includes(attempt.state),
  );
  const recentError = data.attempts.find((attempt) =>
    ["failed", "lost"].includes(attempt.state),
  );
  const copy = pendingAction ? actionCopy[pendingAction] : null;

  return (
    <div className="space-y-6">
      <Link
        to="/workers"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-4" /> Back to worker fleet
      </Link>
      <PageHeader
        title={data.machine.label}
        description={`${data.machine.machineId} · revision ${data.machine.revision}`}
        actions={
          can("workers.manage") && data.machine.status !== "revoked" ? (
            <MachineActions data={data} onAction={setPendingAction} />
          ) : undefined
        }
      />
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardContent className="space-y-6 p-5">
            <PageSection title="Identity and runtime">
              <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Datum label="Machine state">
                  <StatusBadge value={data.machine.status} />
                </Datum>
                <Datum label="Contact">
                  <StatusBadge value={workerContactState(data.machine)} />
                </Datum>
                <Datum label="Last contact">
                  {formatDateTime(data.machine.lastSeenAt)}
                </Datum>
                <Datum label="Release">
                  {data.machine.runtime?.workerVersion ?? "Not reported"}
                </Datum>
                <Datum label="Protocol">
                  {data.machine.runtime?.protocolVersion ?? "Not reported"}
                </Datum>
                <Datum label="Provider runtime">
                  {data.machine.runtime?.providerRuntimeVersion ??
                    "Not reported"}
                </Datum>
                <Datum label="Policy revision">
                  desired {data.machine.desiredRevision} · applied{" "}
                  {data.machine.appliedRevision}
                </Datum>
                <Datum label="Group">{data.machine.groupId ?? "Default"}</Datum>
                <Datum label="Installation">
                  {data.installation?.phase ?? "Not available"}
                </Datum>
              </dl>
            </PageSection>
            <PageSection title="Session and capacity">
              {data.machine.session ? (
                <div className="rounded-lg border p-3 text-sm">
                  <p className="font-mono text-xs break-all">
                    Session {data.machine.session.sessionId}
                  </p>
                  <p className="text-muted-foreground">
                    Generation {data.machine.session.generation} · started{" "}
                    {formatDateTime(data.machine.session.startedAt)}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No active supervisor session.
                </p>
              )}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Slot</TableHead>
                    <TableHead>GPU</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Current attempt</TableHead>
                    <TableHead>Recipes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.slots.map((slot) => (
                    <TableRow key={slot._id}>
                      <TableCell>#{slot.slotIndex}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {slot.gpuId}
                      </TableCell>
                      <TableCell>
                        <StatusBadge value={slot.state} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {slot.currentAttemptId ?? "—"}
                      </TableCell>
                      <TableCell>{slot.allowedRecipeIds.length}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </PageSection>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-5 p-5">
            <PageSection title="Hardware">
              {data.machine.hardware ? (
                <dl className="space-y-3 text-sm">
                  <Datum label="OS">
                    {data.machine.hardware.os} {data.machine.hardware.osBuild}
                  </Datum>
                  <Datum label="CPU">{data.machine.hardware.cpu}</Datum>
                  <Datum label="Memory">
                    {formatBytes(data.machine.hardware.memoryBytes)}
                  </Datum>
                  {data.machine.hardware.gpus.map((gpu) => (
                    <Datum key={gpu.id} label={`GPU ${gpu.id}`}>
                      {gpu.name} · {gpu.driverVersion}
                    </Datum>
                  ))}
                </dl>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No accepted hardware report.
                </p>
              )}
            </PageSection>
            <PageSection title="Qualified capabilities">
              <ul className="space-y-2">
                {data.machine.capabilities.map((capability) => (
                  <li
                    key={`${capability.platform}:${capability.provider}:${capability.gpuId}`}
                    className="rounded-lg border p-3 text-sm"
                  >
                    <p className="font-medium">
                      {capability.platform} · {capability.provider}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      GPU {capability.gpuId} · up to {capability.maxSlots} slot
                      {capability.maxSlots === 1 ? "" : "s"}
                    </p>
                    <ul className="mt-2 space-y-1 font-mono text-xs">
                      {capability.recipeIds.map((recipe) => (
                        <li key={recipe}>{recipe}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </PageSection>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardContent className="space-y-6 p-5">
          <PageSection title="Current work and recent errors">
            <div className="grid gap-4 lg:grid-cols-2">
              <AttemptCard title="Current attempt" attempt={currentAttempt} />
              <AttemptCard
                title="Latest terminal error"
                attempt={recentError}
              />
            </div>
            <AttemptHistory data={data} />
          </PageSection>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-6 p-5">
          <PageSection
            title="Diagnostics and commands"
            description="Rendering is capped and private URL-like text is redacted again in the browser."
          >
            {!can("workers.logs.read") ? (
              <p className="text-sm text-muted-foreground">
                Your role can inspect machines but cannot read worker logs.
              </p>
            ) : diagnostics.isLoading ? (
              <LoadingState rows={2} />
            ) : diagnostics.isError ? (
              <ErrorState
                error={diagnostics.error}
                retry={() => void diagnostics.refetch()}
              />
            ) : (
              <DiagnosticList data={diagnostics.data?.items ?? []} />
            )}
            <CommandHistory commands={data.commands} />
          </PageSection>
        </CardContent>
      </Card>
      <ReasonDialog
        open={Boolean(pendingAction)}
        onOpenChange={(open) => !open && setPendingAction(null)}
        title={copy?.title ?? "Confirm worker operation"}
        description={copy?.description ?? "Confirm this worker operation."}
        confirmLabel={copy?.label ?? "Confirm"}
        destructive={copy?.destructive}
        freshAuth
        onReauthenticate={reauthenticate}
        summary={
          <p>
            Machine revision {data.machine.revision} · stale revisions are
            rejected
          </p>
        }
        onConfirm={(reason) =>
          pendingAction
            ? mutation
                .mutateAsync({ action: pendingAction, reason, current: data })
                .then(() => undefined)
            : Promise.resolve()
        }
      />
    </div>
  );
}

function MachineActions({
  data,
  onAction,
}: {
  data: WorkerMachineDetail;
  onAction(action: MachineAction): void;
}) {
  const status = data.machine.status;
  return (
    <>
      {status === "active" ? (
        <>
          <Button variant="outline" onClick={() => onAction("pause")}>
            <CirclePause aria-hidden="true" /> Pause
          </Button>
          <Button variant="outline" onClick={() => onAction("drain")}>
            <Activity aria-hidden="true" /> Drain
          </Button>
        </>
      ) : status === "paused" || status === "draining" ? (
        <Button variant="outline" onClick={() => onAction("resume")}>
          <Play aria-hidden="true" /> Resume
        </Button>
      ) : null}
      <Button variant="outline" onClick={() => onAction("doctor")}>
        <HeartPulse aria-hidden="true" /> Doctor
      </Button>
      <Button variant="outline" onClick={() => onAction("benchmark")}>
        <Gauge aria-hidden="true" /> Benchmark
      </Button>
      <Button variant="destructive" onClick={() => onAction("revoke")}>
        <Ban aria-hidden="true" /> Revoke
      </Button>
    </>
  );
}

function Datum({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 break-words text-sm">{children}</dd>
    </div>
  );
}

function AttemptCard({
  title,
  attempt,
}: {
  title: string;
  attempt: WorkerMachineDetail["attempts"][number] | undefined;
}) {
  return (
    <div className="rounded-lg border p-4">
      <h3 className="text-sm font-medium">{title}</h3>
      {attempt ? (
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <Datum label="Job">
            <Link
              className="font-mono text-xs text-primary hover:underline"
              to={`/jobs/${attempt.jobId}`}
            >
              {attempt.jobId}
            </Link>
          </Datum>
          <Datum label="State">
            <StatusBadge value={attempt.state} />
          </Datum>
          <Datum label="Stage">{attempt.stage}</Datum>
          <Datum label="Attempt">{attempt.attemptNumber ?? "—"}</Datum>
          {attempt.terminalCode ? (
            <Datum label="Code">{attempt.terminalCode}</Datum>
          ) : null}
          {attempt.terminalSummary ? (
            <Datum label="Summary">{attempt.terminalSummary}</Datum>
          ) : null}
        </dl>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">None</p>
      )}
    </div>
  );
}

function AttemptHistory({ data }: { data: WorkerMachineDetail }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Attempt</TableHead>
            <TableHead>Job</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Stage</TableHead>
            <TableHead>Finished</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.attempts.slice(0, 20).map((attempt) => (
            <TableRow key={attempt.attemptId}>
              <TableCell className="font-mono text-xs">
                {attempt.attemptId}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {attempt.jobId}
              </TableCell>
              <TableCell>
                <StatusBadge value={attempt.state} />
              </TableCell>
              <TableCell>{attempt.stage}</TableCell>
              <TableCell>{formatDateTime(attempt.finishedAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function DiagnosticList({
  data,
}: {
  data: Array<{
    id: string;
    kind: string;
    lines: string[];
    metrics: Array<{ name: string; value: number; unit: string }>;
    createdAt: string;
  }>;
}) {
  if (!data.length)
    return (
      <p className="text-sm text-muted-foreground">No diagnostics reported.</p>
    );
  return (
    <div className="space-y-3">
      {data.slice(0, 10).map((item) => (
        <details key={item.id} className="rounded-lg border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            {item.kind.replaceAll("_", " ")} · {formatDateTime(item.createdAt)}
          </summary>
          <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 p-3 text-xs">
            {boundedDiagnosticLines(item.lines, 20)
              .map(redactPrivateDiagnosticText)
              .join("\n") || "No log lines"}
          </pre>
          {item.metrics.length ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {item.metrics
                .slice(0, 20)
                .map(
                  (metric) => `${metric.name}: ${metric.value} ${metric.unit}`,
                )
                .join(" · ")}
            </p>
          ) : null}
        </details>
      ))}
    </div>
  );
}

function CommandHistory({
  commands,
}: {
  commands: WorkerMachineDetail["commands"];
}) {
  const ordered = useMemo(() => commands.slice(0, 20), [commands]);
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Recent commands</h3>
      {ordered.length ? (
        <ul className="space-y-2">
          {ordered.map((command) => (
            <li
              key={command.commandId}
              className="rounded-lg border p-3 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium capitalize">{command.kind}</span>
                <StatusBadge value={command.state} />
                <span className="text-xs text-muted-foreground">
                  {formatDateTime(command.requestedAt)}
                </span>
              </div>
              {command.summary ? (
                <p className="mt-2 text-muted-foreground">{command.summary}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No commands requested.</p>
      )}
    </div>
  );
}
