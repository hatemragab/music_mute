import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";

import { JOB_STATUSES } from "@/api/contracts";
import { withQuery } from "@/api/query-string";
import { DASHBOARD_POLL_INTERVAL_MS } from "@/app/polling";
import { useAdminSession, useApiClient } from "@/auth/admin-session";
import { CursorPagination } from "@/components/cursor-pagination";
import { validateDateRange } from "@/components/date-range";
import { ExportCsvButton } from "@/components/export-csv-button";
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
import { formatDateTime, formatDuration } from "@/lib/format";
import { useVisibleInterval } from "@/hooks/use-visible-interval";
import { listJobs } from "./jobs-api";
import { JobSourceLink } from "./job-source-link";

export function JobsPage() {
  const client = useApiClient();
  const { can } = useAdminSession();
  const [params, setParams] = useSearchParams();
  const [jobId, setJobId] = useState(params.get("jobId") ?? "");
  const status = params.get("status") ?? "all";
  const userId = params.get("userId") ?? "";
  const fromDate = params.get("from") ?? "";
  const toDate = params.get("to") ?? "";
  const cursor = params.get("cursor");
  const from = fromDate ? `${fromDate}T00:00:00.000Z` : undefined;
  const to = toDate ? `${toDate}T23:59:59.999Z` : undefined;
  const dateError = from && to ? validateDateRange({ from, to }) : null;
  const filters = {
    status: status === "all" ? undefined : status,
    userId: userId || undefined,
    jobId: params.get("jobId") || undefined,
    from,
    to,
    cursor,
  };
  const jobs = useQuery({
    queryKey: ["jobs", filters],
    queryFn: () => listJobs(client, filters),
    enabled: !dateError,
  });
  useVisibleInterval(
    () => void jobs.refetch(),
    DASHBOARD_POLL_INTERVAL_MS.live,
  );
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
        title="Jobs"
        description="Inspect job status, owner, source, timing and finalized results."
        actions={
          can("exports.read") ? (
            <ExportCsvButton
              path={withQuery("/admin/exports/jobs.csv", filters)}
              filename="musicmute-jobs.csv"
            />
          ) : undefined
        }
      />
      <div className="grid gap-2 rounded-xl border bg-card p-3 sm:grid-cols-2 xl:grid-cols-5">
        <Select
          value={status}
          onValueChange={(value) => change("status", value)}
        >
          <SelectTrigger aria-label="Filter job status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {JOB_STATUSES.map((value) => (
              <SelectItem key={value} value={value}>
                {value.replaceAll("_", " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          aria-label="Filter by user ID"
          placeholder="Exact user ID"
          value={userId}
          onChange={(event) => change("userId", event.target.value)}
        />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            change("jobId", jobId);
          }}
        >
          <Input
            aria-label="Find exact job ID"
            placeholder="Exact job ID"
            value={jobId}
            onChange={(event) => setJobId(event.target.value)}
          />
        </form>
        <Input
          aria-label="Jobs created from"
          type="date"
          value={fromDate}
          onChange={(event) => change("from", event.target.value)}
        />
        <Input
          aria-label="Jobs created to"
          type="date"
          value={toDate}
          onChange={(event) => change("to", event.target.value)}
        />
        {dateError ? (
          <p
            role="alert"
            className="text-sm text-destructive sm:col-span-2 xl:col-span-5"
          >
            {dateError}
          </p>
        ) : null}
      </div>
      {dateError ? null : jobs.isLoading ? (
        <LoadingState />
      ) : jobs.isError ? (
        <ErrorState error={jobs.error} retry={() => void jobs.refetch()} />
      ) : jobs.data?.items.length ? (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>Source URL</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Timing</TableHead>
                  <TableHead>Queue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.data.items.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell>
                      <Link
                        className="font-mono text-xs font-medium text-primary hover:underline"
                        to={`/jobs/${job.id}`}
                      >
                        {job.id}
                      </Link>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {formatDateTime(job.createdAt)}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-80">
                      <JobSourceLink
                        sourceUrl={job.sourceUrl}
                        className="block max-w-80 truncate text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                    </TableCell>
                    <TableCell>
                      <StatusBadge value={job.status} />
                    </TableCell>
                    <TableCell>
                      <div>{job.userDisplayName ?? "Restricted identity"}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {job.userId}
                      </div>
                    </TableCell>
                    <TableCell>{formatDuration(job.elapsedSeconds)}</TableCell>
                    <TableCell>{job.queuePosition ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          title="No jobs"
          description="No jobs match the current server-supported filters."
        />
      )}
      <CursorPagination
        cursor={cursor}
        nextCursor={jobs.data?.nextCursor ?? null}
        pending={jobs.isFetching}
        onCursorChange={(value) => change("cursor", value ?? "")}
      />
    </div>
  );
}
