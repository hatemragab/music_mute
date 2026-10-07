import { useLiveQuery } from "@/realtime/hooks";
import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { Link, useSearchParams } from "react-router";

import { CursorPagination } from "@/components/cursor-pagination";
import { RefreshButton } from "@/components/refresh-button";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from "@/components/page";
import { StatusBadge } from "@/components/status-badge";
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
import { formatDateTime } from "@/lib/format";
import { WorkerPolicyPanel } from "./worker-policy-panel";
import { WorkerFleetSummary } from "./worker-insight-panels";
import { workerContactState } from "./worker-status";
import {
  WORKER_MACHINE_STATUSES,
  type WorkerMachine,
  type WorkerMachineStatus,
  type WorkerPlatform,
} from "./worker-types";

const platformLabel: Record<WorkerPlatform, string> = {
  "darwin-arm64": "macOS ARM64",
  "windows-amd64": "Windows x64",
};

export function WorkerFleetPage() {
  const [activeTab, setActiveTab] = useState("machines");
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
  const machines = useLiveQuery({
    queryKey: ["worker-machines", filters],
    resource: "admin.workers",
    params: filters,
    enabled: activeTab === "machines",
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
        description="Manage registered machines, watch current work and control bounded fleet capacity. Approve new Mac registrations from user detail."
        actions={
          activeTab === "machines" ? (
            <RefreshButton
              label="Refresh worker fleet"
              refreshing={machines.isFetching}
              onRefresh={() => void machines.refetch()}
            />
          ) : null
        }
      />
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList aria-label="Worker fleet sections">
          <TabsTrigger value="machines">Machines</TabsTrigger>
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
          {machines.data && !machines.isError && (
            <WorkerFleetSummary data={machines.data} />
          )}
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
              description="Adjust the filters. To register a new Mac, allow worker registration on its user detail page and have MusicMute Local open and connected."
            />
          )}
        </TabsContent>
        <TabsContent value="policy">
          <WorkerPolicyPanel />
        </TabsContent>
      </Tabs>
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
              const contact = workerContactState(machine, Date.parse(asOf));
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
