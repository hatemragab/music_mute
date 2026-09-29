import { useLiveQuery } from "@/realtime/hooks";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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

import {
  createOperationId,
  OperationOutcomeUnknownError,
} from "@/api/api-client";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBytes, formatDateTime } from "@/lib/format";
import {
  changeWorkerMachineState,
  requestWorkerBenchmark,
  requestWorkerDoctor,
} from "./worker-api";
import {
  boundedDiagnosticLines,
  redactPrivateDiagnosticText,
  workerContactState,
} from "./worker-status";
import { workerRecipeLabel } from "./worker-recipes";
import {
  WorkerCommandHistory,
  WorkerReadinessPanel,
} from "./worker-insight-panels";
import type { WorkerMachineDetail } from "./worker-types";

type MachineAction =
  | "pause"
  | "drain"
  | "resume"
  | "revoke"
  | "doctor"
  | "runtime"
  | "engine"
  | "benchmark";

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
  runtime: {
    title: "Request runtime snapshot",
    description:
      "Check the supervisor and scratch storage. Updated workers also report uptime, process memory, host memory and disk capacity. No inference benchmark is started.",
    label: "Request runtime snapshot",
  },
  engine: {
    title: "Request engine checks",
    description:
      "Run the packaged model, GPU provider and FFmpeg probe. These components are validated together; a shared failure may leave individual checks incomplete.",
    label: "Request engine checks",
  },
  benchmark: {
    title: "Request one benchmark",
    description:
      "Queue one Kim Vocal 2 qualification pass. The command defers while a slot is busy.",
    label: "Request benchmark",
  },
};

export function WorkerMachinePage() {
  const { id = "" } = useParams();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { can, reauthenticate } = useAdminSession();
  const [uncertain, setUncertain] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<MachineAction | null>(
    null,
  );
  const [diagnosticPage, setDiagnosticPage] = useState<{
    machineId: string;
    cursor: string | null;
  }>({ machineId: id, cursor: null });
  const diagnosticCursor =
    diagnosticPage.machineId === id ? diagnosticPage.cursor : null;
  const machine = useLiveQuery({
    queryKey: ["worker-machine", id],
    resource: "admin.worker",
    params: { id },
    enabled: Boolean(id),
  });
  const diagnostics = useLiveQuery({
    queryKey: ["worker-diagnostics", id, diagnosticCursor],
    resource: "admin.diagnostics",
    params: { id, cursor: diagnosticCursor, limit: 10 },
    enabled: Boolean(id) && can("workers.logs.read"),
  });
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
      if (uncertain)
        throw new Error(
          "Resolve the previous operation before issuing another command.",
        );
      if (["doctor", "runtime", "engine"].includes(action))
        return requestWorkerDoctor(client, id, {
          ...command,
          checks:
            action === "runtime"
              ? ["service", "storage"]
              : action === "engine"
                ? ["model", "provider", "ffmpeg"]
                : ["service", "storage", "model", "provider", "ffmpeg"],
        });
      if (action === "benchmark") {
        const recipeId = current.machine.capabilities
          .flatMap((capability) => capability.recipeIds)
          .find((recipe) => recipe === "kim-vocals-v2");
        if (!recipeId)
          throw new Error("This machine has no qualified benchmark recipe.");
        return requestWorkerBenchmark(client, id, {
          ...command,
          recipeId,
          iterations: 1,
        });
      }
      if (
        action === "pause" ||
        action === "drain" ||
        action === "resume" ||
        action === "revoke"
      )
        return changeWorkerMachineState(client, id, action, command);
      throw new Error("Unknown worker action.");
    },
    onError: (error) => {
      if (error instanceof OperationOutcomeUnknownError) {
        setUncertain(error.operationId);
        setPendingAction(null);
      }
    },
    onSuccess: async (result) => {
      setNotice(
        "commandId" in result
          ? `Command ${result.commandId} accepted. Follow its result in Recent commands.`
          : "Worker state updated.",
      );
      setDiagnosticPage({ machineId: id, cursor: null });
      await queryClient.invalidateQueries({ queryKey: ["worker-machine", id] });
      await queryClient.invalidateQueries({ queryKey: ["worker-machines"] });
      await queryClient.invalidateQueries({
        queryKey: ["worker-diagnostics", id],
      });
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
      />
      {can("workers.manage") && data.machine.status !== "revoked" ? (
        <MachineActions
          data={data}
          disabled={mutation.isPending || Boolean(uncertain)}
          onAction={setPendingAction}
        />
      ) : null}
      {notice && (
        <p role="status" className="break-words text-sm">
          {notice}
        </p>
      )}
      {uncertain && (
        <p role="alert" className="break-words text-sm text-destructive">
          Command outcome is unresolved. Further commands are disabled in this
          page session to prevent duplicates. Check recent history and operation{" "}
          {uncertain} before returning to this page.
        </p>
      )}
      <WorkerReadinessPanel data={data} />
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardContent className="space-y-6 p-5">
            <PageSection title="Identity and runtime">
              <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Datum label="Machine state">
                  <StatusBadge value={data.machine.status} />
                </Datum>
                <Datum label="Contact">
                  <StatusBadge
                    value={
                      data.asOf
                        ? workerContactState(
                            data.machine,
                            Date.parse(data.asOf),
                          )
                        : "unknown"
                    }
                  />
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
                    <ul className="mt-2 space-y-2 text-xs">
                      {capability.recipeIds.map((recipe) => (
                        <li key={recipe}>
                          <p className="font-medium text-foreground">
                            {workerRecipeLabel(recipe)}
                          </p>
                          <code className="break-all text-muted-foreground">
                            Recipe contract: {recipe}
                          </code>
                        </li>
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
            {can("workers.logs.read") ? (
              <CursorPagination
                key={id}
                cursor={diagnosticCursor}
                nextCursor={diagnostics.data?.nextCursor ?? null}
                pending={diagnostics.isFetching}
                onCursorChange={(cursor) =>
                  setDiagnosticPage({ machineId: id, cursor })
                }
              />
            ) : null}
            <WorkerCommandHistory commands={data.commands} />
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
  disabled,
}: {
  data: WorkerMachineDetail;
  disabled: boolean;
  onAction(action: MachineAction): void;
}) {
  const status = data.machine.status;
  const doctorPending = data.commands.some(
    (command) => command.kind === "doctor" && command.state === "pending",
  );
  const benchmarkUnavailable =
    data.commands.some(
      (command) => command.kind === "benchmark" && command.state === "pending",
    ) ||
    !data.machine.capabilities.some((capability) =>
      capability.recipeIds.includes("kim-vocals-v2"),
    );
  return (
    <fieldset
      disabled={disabled}
      className="flex flex-wrap gap-2"
      aria-label="Worker commands"
    >
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
      <Button
        variant="outline"
        disabled={doctorPending}
        onClick={() => onAction("runtime")}
      >
        <Activity aria-hidden="true" /> Runtime snapshot
      </Button>
      <Button
        variant="outline"
        disabled={doctorPending}
        onClick={() => onAction("engine")}
      >
        <HeartPulse aria-hidden="true" /> Engine checks
      </Button>
      <Button
        variant="outline"
        disabled={doctorPending}
        onClick={() => onAction("doctor")}
      >
        <HeartPulse aria-hidden="true" /> Doctor
      </Button>
      <Button
        variant="outline"
        disabled={benchmarkUnavailable}
        onClick={() => onAction("benchmark")}
      >
        <Gauge aria-hidden="true" /> Benchmark
      </Button>
      <Button variant="destructive" onClick={() => onAction("revoke")}>
        <Ban aria-hidden="true" /> Revoke
      </Button>
      {(doctorPending || benchmarkUnavailable) && (
        <p className="basis-full text-xs text-muted-foreground">
          A pending command blocks another of the same kind. Benchmark also
          requires the Kim Vocal 2 capability.
        </p>
      )}
    </fieldset>
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
