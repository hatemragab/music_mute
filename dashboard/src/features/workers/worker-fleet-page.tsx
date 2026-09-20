import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, RotateCcw } from "lucide-react";
import { Link, useSearchParams } from "react-router";

import { createOperationId } from "@/api/api-client";
import { useAdminSession, useApiClient } from "@/auth/admin-session";
import { CursorPagination } from "@/components/cursor-pagination";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from "@/components/page";
import { ReasonDialog } from "@/components/reason-dialog";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useVisibleInterval } from "@/hooks/use-visible-interval";
import { formatDateTime } from "@/lib/format";
import {
  listWorkerInvitations,
  listWorkerMachines,
  revokeWorkerInvitation,
} from "./worker-api";
import { WorkerEnrollmentDialog } from "./worker-enrollment-dialog";
import { WorkerPolicyPanel } from "./worker-policy-panel";
import { workerContactState } from "./worker-status";
import {
  WORKER_MACHINE_STATUSES,
  type WorkerInvitation,
  type WorkerMachine,
  type WorkerMachineStatus,
  type WorkerPlatform,
} from "./worker-types";

const platformLabel: Record<WorkerPlatform, string> = {
  "darwin-arm64": "macOS ARM64",
  "windows-amd64": "Windows x64",
};

export function WorkerFleetPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { can, reauthenticate } = useAdminSession();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "all";
  const platform = params.get("platform") ?? "all";
  const groupId = params.get("groupId") ?? "";
  const releaseVersion = params.get("releaseVersion") ?? "";
  const cursor = params.get("cursor");
  const filters = {
    status: status === "all" ? undefined : (status as WorkerMachineStatus),
    platform: platform === "all" ? undefined : (platform as WorkerPlatform),
    groupId: groupId || undefined,
    releaseVersion: releaseVersion || undefined,
    cursor,
    limit: 25,
  };
  const machines = useQuery({
    queryKey: ["worker-machines", filters],
    queryFn: () => listWorkerMachines(client, filters),
  });
  const invitations = useQuery({
    queryKey: ["worker-invitations"],
    queryFn: () => listWorkerInvitations(client),
    enabled: can("workers.enroll"),
  });
  useVisibleInterval(() => {
    void machines.refetch();
    if (can("workers.enroll")) void invitations.refetch();
  }, 15_000);

  const [revokeTarget, setRevokeTarget] = useState<WorkerInvitation | null>(
    null,
  );
  const revoke = useMutation({
    mutationFn: ({
      target,
      reason,
    }: {
      target: WorkerInvitation;
      reason: string;
    }) =>
      revokeWorkerInvitation(client, target.invitationId, {
        operationId: createOperationId(),
        expectedRevision: target.revision,
        reason,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["worker-invitations"] });
    },
  });
  const change = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== "all") next.set(name, value);
    else next.delete(name);
    if (name !== "cursor") next.delete("cursor");
    setParams(next);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Worker fleet"
        description="Enroll qualified machines, watch current work and control bounded fleet capacity without exposing worker credentials."
        actions={
          can("workers.enroll") ? (
            <WorkerEnrollmentDialog
              onCreated={() =>
                queryClient.invalidateQueries({
                  queryKey: ["worker-invitations"],
                })
              }
            />
          ) : undefined
        }
      />
      <Tabs defaultValue="machines">
        <TabsList aria-label="Worker fleet sections">
          <TabsTrigger value="machines">Machines</TabsTrigger>
          {can("workers.enroll") ? (
            <TabsTrigger value="enrollment">Enrollment</TabsTrigger>
          ) : null}
          <TabsTrigger value="policy">Policy</TabsTrigger>
        </TabsList>
        <TabsContent value="machines" className="space-y-4">
          <div className="grid gap-2 rounded-xl border bg-card p-3 sm:grid-cols-2 xl:grid-cols-4">
            <Select
              value={status}
              onValueChange={(value) => change("status", value)}
            >
              <SelectTrigger aria-label="Filter worker status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {WORKER_MACHINE_STATUSES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={platform}
              onValueChange={(value) => change("platform", value)}
            >
              <SelectTrigger aria-label="Filter worker platform">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All platforms</SelectItem>
                <SelectItem value="darwin-arm64">macOS ARM64</SelectItem>
                <SelectItem value="windows-amd64">Windows x64</SelectItem>
              </SelectContent>
            </Select>
            <Input
              aria-label="Filter by worker group"
              placeholder="Exact group"
              value={groupId}
              onChange={(event) => change("groupId", event.target.value)}
            />
            <Input
              aria-label="Filter by worker release"
              placeholder="Exact release, e.g. 0.1.3"
              value={releaseVersion}
              onChange={(event) => change("releaseVersion", event.target.value)}
            />
          </div>
          {machines.isLoading ? (
            <LoadingState />
          ) : machines.isError ? (
            <ErrorState
              error={machines.error}
              retry={() => void machines.refetch()}
            />
          ) : machines.data?.items.length ? (
            <MachineTable
              items={machines.data.items}
              asOf={machines.data.asOf}
              cursor={cursor}
              nextCursor={machines.data.nextCursor}
              pending={machines.isFetching}
              onCursorChange={(next) => change("cursor", next ?? "")}
            />
          ) : (
            <EmptyState
              title="No machines match"
              description="Adjust the filters or create a one-use enrollment invitation for a new machine."
            />
          )}
        </TabsContent>
        {can("workers.enroll") ? (
          <TabsContent value="enrollment" className="space-y-4">
            {invitations.isLoading ? (
              <LoadingState />
            ) : invitations.isError ? (
              <ErrorState
                error={invitations.error}
                retry={() => void invitations.refetch()}
              />
            ) : invitations.data?.items.length ? (
              <InvitationTable
                items={invitations.data.items}
                onRevoke={setRevokeTarget}
                replacementAction={
                  invitations.data.items.some(
                    (item) =>
                      item.installation?.phase === "failed" ||
                      item.installation?.phase === "expired",
                  ) ? (
                    <WorkerEnrollmentDialog
                      label="Create replacement"
                      onCreated={() =>
                        queryClient.invalidateQueries({
                          queryKey: ["worker-invitations"],
                        })
                      }
                    />
                  ) : null
                }
              />
            ) : (
              <EmptyState
                title="No invitations yet"
                description="Create a short-lived invitation when a native machine is ready to install."
              />
            )}
          </TabsContent>
        ) : null}
        <TabsContent value="policy">
          <WorkerPolicyPanel />
        </TabsContent>
      </Tabs>
      <ReasonDialog
        open={Boolean(revokeTarget)}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
        title="Revoke enrollment invitation"
        description="The installer will no longer be able to exchange this invitation. Already-consumed machine credentials are unaffected."
        confirmLabel="Revoke invitation"
        destructive
        freshAuth
        onReauthenticate={reauthenticate}
        summary={
          revokeTarget ? (
            <p className="font-mono break-all">{revokeTarget.invitationId}</p>
          ) : null
        }
        onConfirm={(reason) =>
          revokeTarget
            ? revoke
                .mutateAsync({ target: revokeTarget, reason })
                .then(() => setRevokeTarget(null))
            : Promise.resolve()
        }
      />
    </div>
  );
}

function MachineTable({
  items,
  asOf,
  cursor,
  nextCursor,
  pending,
  onCursorChange,
}: {
  items: WorkerMachine[];
  asOf: string;
  cursor: string | null;
  nextCursor: string | null;
  pending: boolean;
  onCursorChange(cursor: string | null): void;
}) {
  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Machine</TableHead>
              <TableHead>Platform / GPU</TableHead>
              <TableHead>Runtime</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>Current job</TableHead>
              <TableHead>Recent error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((machine) => {
              const capability = machine.capabilities[0];
              const gpu = machine.hardware?.gpus.find(
                (item) => item.id === capability?.gpuId,
              );
              const contact = workerContactState(machine);
              return (
                <TableRow key={machine.machineId}>
                  <TableCell>
                    <Link
                      className="font-medium text-primary hover:underline"
                      to={`/workers/${encodeURIComponent(machine.machineId)}`}
                    >
                      {machine.label}
                      <ArrowUpRight
                        className="ml-1 inline size-3"
                        aria-hidden="true"
                      />
                    </Link>
                    <p className="max-w-52 truncate font-mono text-xs text-muted-foreground">
                      {machine.machineId}
                    </p>
                    {machine.groupId ? (
                      <p className="text-xs text-muted-foreground">
                        Group {machine.groupId}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <p>
                      {capability
                        ? platformLabel[capability.platform]
                        : "Unqualified"}
                    </p>
                    <p className="max-w-56 truncate text-xs text-muted-foreground">
                      {gpu?.name ?? capability?.provider ?? "No GPU report"}
                    </p>
                  </TableCell>
                  <TableCell>
                    <p>{machine.runtime?.workerVersion ?? "Not reported"}</p>
                    <p className="text-xs text-muted-foreground">
                      {capability?.provider ?? "No provider"} · protocol{" "}
                      {machine.runtime?.protocolVersion ?? "—"}
                    </p>
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={machine.status} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={contact} />
                    <p className="mt-1 whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(machine.lastSeenAt)}
                    </p>
                  </TableCell>
                  <TableCell>
                    {machine.currentAttempt ? (
                      <div>
                        <Link
                          className="font-mono text-xs text-primary hover:underline"
                          to={`/jobs/${encodeURIComponent(machine.currentAttempt.jobId)}`}
                        >
                          {machine.currentAttempt.jobId}
                        </Link>
                        <p className="text-xs text-muted-foreground">
                          {machine.currentAttempt.stage.replaceAll("_", " ")}
                        </p>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">Idle</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {machine.recentError ? (
                      <div className="max-w-64">
                        <p className="text-xs font-medium text-destructive">
                          {machine.recentError.code ?? "Worker attempt failed"}
                        </p>
                        <p className="line-clamp-2 text-xs text-muted-foreground">
                          {machine.recentError.summary ??
                            "No safe detail available"}
                        </p>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <div className="border-t px-4 py-2 text-xs text-muted-foreground">
          Snapshot {formatDateTime(asOf)}
        </div>
        <CursorPagination
          cursor={cursor}
          nextCursor={nextCursor}
          pending={pending}
          onCursorChange={onCursorChange}
        />
      </CardContent>
    </Card>
  );
}

function InvitationTable({
  items,
  onRevoke,
  replacementAction,
}: {
  items: WorkerInvitation[];
  onRevoke(item: WorkerInvitation): void;
  replacementAction: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <div className="flex items-center justify-between gap-3 border-b p-4">
          <div>
            <h2 className="font-semibold">
              Invitation and installation history
            </h2>
            <p className="text-sm text-muted-foreground">
              Secrets are never recoverable here; only lifecycle diagnostics
              remain.
            </p>
          </div>
          {replacementAction}
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Invitation</TableHead>
              <TableHead>State / expiry</TableHead>
              <TableHead>Installation</TableHead>
              <TableHead>Diagnostic</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.invitationId}>
                <TableCell>
                  <p className="max-w-56 truncate font-mono text-xs">
                    {item.invitationId}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    By {item.createdByUid}
                  </p>
                </TableCell>
                <TableCell>
                  <StatusBadge value={item.state} />
                  <p className="mt-1 whitespace-nowrap text-xs text-muted-foreground">
                    Expires {formatDateTime(item.expiresAt)}
                  </p>
                </TableCell>
                <TableCell>
                  {item.installation ? (
                    <>
                      <StatusBadge value={item.installation.phase} />
                      <p className="mt-1 whitespace-nowrap text-xs text-muted-foreground">
                        Seen {formatDateTime(item.installation.lastSeenAt)}
                      </p>
                    </>
                  ) : (
                    <span className="text-muted-foreground">Not started</span>
                  )}
                </TableCell>
                <TableCell>
                  <div className="max-w-80 text-xs">
                    {item.installation?.outcomeCode ? (
                      <p className="font-medium text-destructive">
                        {item.installation.outcomeCode}
                      </p>
                    ) : null}
                    <p className="line-clamp-2 text-muted-foreground">
                      {item.installation?.reportSummary ?? "No report yet"}
                    </p>
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  {item.state === "active" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onRevoke(item)}
                    >
                      Revoke
                    </Button>
                  ) : item.installation?.phase === "failed" ? (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <RotateCcw aria-hidden="true" className="size-3" /> Use
                      replacement
                    </span>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
