import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
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
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { formatDateTime } from "@/lib/format";
import { useVisibleInterval } from "@/hooks/use-visible-interval";
import { createWorker, listWorkers } from "./workers-api";
import { WorkerKeyDialog } from "./worker-key-dialog";
import { WorkerRegistrationDialog } from "./worker-registration-dialog";
import { workerCapacityLabel } from "./worker-status";

export function WorkersPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { can, reauthenticate } = useAdminSession();
  const [params, setParams] = useSearchParams();
  const state = params.get("state") ?? "all";
  const online = params.get("online") ?? "all";
  const cursor = params.get("cursor");
  const [createOpen, setCreateOpen] = useState(false);
  const [key, setKey] = useState<{ workerId: string; value: string } | null>(
    null,
  );
  const workers = useQuery({
    queryKey: ["workers", state, online, cursor],
    queryFn: () =>
      listWorkers(client, {
        state: state === "all" ? undefined : state,
        online: online === "all" ? undefined : online === "true",
        cursor,
      }),
  });
  useVisibleInterval(() => void workers.refetch(), 15_000);
  const change = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== "all") next.set(name, value);
    else next.delete(name);
    if (name !== "cursor") next.delete("cursor");
    setParams(next);
  };
  const create = useMutation({
    mutationFn: (input: { id: string; label: string; reason: string }) =>
      createWorker(client, { ...input, operationId: createOperationId() }),
    onSuccess: async (result) => {
      setKey({ workerId: result.worker.id, value: result.rawKey });
      await queryClient.invalidateQueries({ queryKey: ["workers"] });
    },
  });
  return (
    <div className="space-y-6">
      <PageHeader
        title="Workers"
        description="Fleet registration, capacity and assignment ownership. Offline workers can still own unfinished work."
        actions={
          can("workers.manage") ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus aria-hidden="true" /> Register worker
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-wrap gap-2">
        <Select value={state} onValueChange={(value) => change("state", value)}>
          <SelectTrigger className="w-44" aria-label="Filter worker state">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All states</SelectItem>
            <SelectItem value="enabled">Enabled</SelectItem>
            <SelectItem value="draining">Draining</SelectItem>
            <SelectItem value="revoked">Revoked</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={online}
          onValueChange={(value) => change("online", value)}
        >
          <SelectTrigger
            className="w-44"
            aria-label="Filter worker connectivity"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Online and offline</SelectItem>
            <SelectItem value="true">Online</SelectItem>
            <SelectItem value="false">Offline</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {workers.isLoading ? (
        <LoadingState />
      ) : workers.isError ? (
        <ErrorState
          error={workers.error}
          retry={() => void workers.refetch()}
        />
      ) : workers.data?.items.length ? (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Worker</TableHead>
                  <TableHead>Registration</TableHead>
                  <TableHead>Capacity</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead>Current job</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workers.data.items.map((worker) => (
                  <TableRow key={worker.id}>
                    <TableCell>
                      <Link
                        className="font-medium text-primary hover:underline"
                        to={`/workers/${encodeURIComponent(worker.id)}`}
                      >
                        {worker.label}
                      </Link>
                      <div className="font-mono text-xs text-muted-foreground">
                        {worker.id}
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge value={worker.state} />
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        value={worker.online ? "online" : "offline"}
                      />
                      <div className="mt-1 text-xs text-muted-foreground">
                        {workerCapacityLabel(worker)}
                      </div>
                    </TableCell>
                    <TableCell>{formatDateTime(worker.lastSeenAt)}</TableCell>
                    <TableCell>
                      {worker.activeJobId && can("jobs.read") ? (
                        <Link
                          className="font-mono text-xs text-primary hover:underline"
                          to={`/jobs/${worker.activeJobId}`}
                        >
                          {worker.activeJobId}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">
                          {worker.activeJobId ?? "None"}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          title="No workers"
          description="No workers match the selected filters."
        />
      )}
      <CursorPagination
        cursor={cursor}
        nextCursor={workers.data?.nextCursor ?? null}
        pending={workers.isFetching}
        onCursorChange={(value) => change("cursor", value ?? "")}
      />
      <WorkerRegistrationDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        reauthenticate={reauthenticate}
        onSubmit={(input) => create.mutateAsync(input).then(() => undefined)}
      />
      <WorkerKeyDialog
        value={key?.value ?? null}
        workerId={key?.workerId ?? null}
        onClear={() => setKey(null)}
      />
    </div>
  );
}
