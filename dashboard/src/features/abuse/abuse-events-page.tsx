import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";

import type { AbuseEventType } from "@/api/contracts";
import { useApiClient } from "@/auth/admin-session";
import { CursorPagination } from "@/components/cursor-pagination";
import { DateRangeFilter } from "@/components/date-range-filter";
import {
  createRange,
  parseDateRange,
  type DateRange,
} from "@/components/date-range";
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
import { formatDateTime } from "@/lib/format";
import { listAbuseEvents, type AbuseEventFilters } from "./abuse-api";

const eventTypes: AbuseEventType[] = [
  "upload_grant_limit",
  "upload_attempt_limit",
  "invalid_upload_repeat",
  "cancel_after_upload_repeat",
  "client_retry_limit",
  "download_grant_limit",
  "download_bytes_limit",
  "processing_quota_limit",
  "queue_limit",
  "endpoint_rate_limit",
  "restriction_bypass_attempt",
  "service_safety_ceiling",
];

export function AbuseEventsPage() {
  const client = useApiClient();
  const [params, setParams] = useSearchParams();
  const fallbackRange = useMemo(() => createRange(30), []);
  const range = useMemo(
    () => parseDateRange(params.get("from"), params.get("to"), fallbackRange),
    [fallbackRange, params],
  );
  const accountId = params.get("accountId") ?? "";
  const type = params.get("type") ?? "all";
  const severity = params.get("severity") ?? "all";
  const cursor = params.get("cursor");
  const filters = useMemo<AbuseEventFilters>(
    () => ({
      accountId: accountId || undefined,
      type: type === "all" ? undefined : (type as AbuseEventType),
      severity:
        severity === "all"
          ? undefined
          : (severity as "low" | "medium" | "high"),
      ...range,
      cursor,
    }),
    [accountId, cursor, range, severity, type],
  );
  const events = useQuery({
    queryKey: ["abuse-events", filters],
    queryFn: () => listAbuseEvents(client, filters),
  });
  const change = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== "all") next.set(name, value);
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
        title="Abuse events"
        description="Bounded account-level signals for support review. This page does not automatically ban or restrict accounts."
      />
      <DateRangeFilter range={range} onChange={setRange} />
      <div className="grid gap-2 rounded-xl border bg-card p-3 md:grid-cols-3">
        <Input
          aria-label="Filter account ID"
          placeholder="Account ID"
          value={accountId}
          onChange={(event) => change("accountId", event.target.value.trim())}
        />
        <Select value={type} onValueChange={(value) => change("type", value)}>
          <SelectTrigger aria-label="Filter event type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All event types</SelectItem>
            {eventTypes.map((value) => (
              <SelectItem key={value} value={value}>
                {value.replaceAll("_", " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={severity}
          onValueChange={(value) => change("severity", value)}
        >
          <SelectTrigger aria-label="Filter severity">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All severities</SelectItem>
            <SelectItem value="low">Low</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="high">High</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {events.isLoading ? (
        <LoadingState />
      ) : events.isError ? (
        <ErrorState error={events.error} retry={() => void events.refetch()} />
      ) : events.data?.items.length ? (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Last occurrence</TableHead>
                  <TableHead>First occurrence</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Count</TableHead>
                  <TableHead>Operation</TableHead>
                  <TableHead>Restriction</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.data.items.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell>
                      {formatDateTime(event.lastOccurredAt)}
                    </TableCell>
                    <TableCell>
                      {formatDateTime(event.firstOccurredAt)}
                    </TableCell>
                    <TableCell>
                      <Link
                        className="font-mono text-xs text-primary hover:underline"
                        to={`/users/${event.accountId}`}
                      >
                        {event.accountId}
                      </Link>
                    </TableCell>
                    <TableCell>{event.type.replaceAll("_", " ")}</TableCell>
                    <TableCell>
                      <StatusBadge
                        value={
                          event.severity === "high"
                            ? "error"
                            : event.severity === "medium"
                              ? "warning"
                              : "active"
                        }
                        label={event.severity}
                      />
                    </TableCell>
                    <TableCell className="font-mono">{event.count}</TableCell>
                    <TableCell>
                      {event.operationClass.replaceAll("_", " ")}
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        value={
                          event.restrictionStatus === "active"
                            ? "warning"
                            : "active"
                        }
                        label={event.restrictionStatus}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          title="No abuse events"
          description="No bounded event buckets match these filters."
        />
      )}
      <CursorPagination
        cursor={cursor}
        nextCursor={events.data?.nextCursor ?? null}
        pending={events.isFetching}
        onCursorChange={(value) => change("cursor", value ?? "")}
      />
    </div>
  );
}
