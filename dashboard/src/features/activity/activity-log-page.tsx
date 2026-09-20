import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";

import { useApiClient } from "@/auth/admin-session";
import { DateRangeFilter } from "@/components/date-range-filter";
import {
  createRange,
  parseDateRange,
  type DateRange,
} from "@/components/date-range";
import { CursorPagination } from "@/components/cursor-pagination";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from "@/components/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import { AuditEventDetail } from "./audit-event-detail";
import { listAudit, type AuditFilters } from "./activity-api";
import type { AuditEvent } from "@/api/contracts";

export function ActivityLogPage() {
  const client = useApiClient();
  const [params, setParams] = useSearchParams();
  const fallbackRange = useMemo(() => createRange(7), []);
  const from = params.get("from");
  const to = params.get("to");
  const range = useMemo(
    () => parseDateRange(from, to, fallbackRange),
    [fallbackRange, from, to],
  );
  const actorUid = params.get("actorUid") ?? "";
  const action = params.get("action") ?? "";
  const resource = params.get("resourceId") ?? "";
  const cursor = params.get("cursor");
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const filters = useMemo<AuditFilters>(
    () => ({
      ...range,
      actorUid: actorUid || undefined,
      action: action || undefined,
      resourceId: resource || undefined,
      cursor,
    }),
    [action, actorUid, cursor, range, resource],
  );
  const audit = useQuery({
    queryKey: ["audit", filters],
    queryFn: () => listAudit(client, filters),
  });
  const change = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    if (name !== "cursor") next.delete("cursor");
    setParams(next);
  };
  const setRange = (value: DateRange) => {
    const next = new URLSearchParams(params);
    next.set("from", value.from);
    next.set("to", value.to);
    next.delete("cursor");
    setParams(next);
  };
  return (
    <div className="space-y-6">
      <PageHeader
        title="Activity log"
        description="Owner-only, append-only administrative events with safe revision metadata."
      />
      <DateRangeFilter range={range} onChange={setRange} />
      <div className="grid gap-2 rounded-xl border bg-card p-3 md:grid-cols-3">
        <Input
          aria-label="Filter actor UID"
          placeholder="Actor UID"
          value={actorUid}
          onChange={(event) => change("actorUid", event.target.value)}
        />
        <Input
          aria-label="Filter action"
          placeholder="Action, e.g. jobs.cancel"
          value={action}
          onChange={(event) => change("action", event.target.value)}
        />
        <Input
          aria-label="Filter resource ID"
          placeholder="Resource ID"
          value={resource}
          onChange={(event) => change("resourceId", event.target.value)}
        />
      </div>
      {audit.isLoading ? (
        <LoadingState />
      ) : audit.isError ? (
        <ErrorState error={audit.error} retry={() => void audit.refetch()} />
      ) : audit.data?.items.length ? (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Resource</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {audit.data.items.map((event) => (
                  <TableRow key={`${event.id}-${event.action}-${event.at}`}>
                    <TableCell>{formatDateTime(event.at)}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {event.actorUid}
                    </TableCell>
                    <TableCell>{event.action}</TableCell>
                    <TableCell>
                      <div>{event.resourceType}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {event.resourceId}
                      </div>
                    </TableCell>
                    <TableCell>{event.outcome}</TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setSelected(event)}
                      >
                        Inspect
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          title="No activity"
          description="No audit events match the selected range and filters."
        />
      )}
      <CursorPagination
        cursor={cursor}
        nextCursor={audit.data?.nextCursor ?? null}
        pending={audit.isFetching}
        onCursorChange={(value) => change("cursor", value ?? "")}
      />
      <AuditEventDetail event={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
