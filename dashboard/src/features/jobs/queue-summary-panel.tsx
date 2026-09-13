import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { QueueWorkload } from "@/api/contracts";
import { useAdminSession, useApiClient } from "@/auth/admin-session";
import { ErrorState, LoadingState, PageSection } from "@/components/page";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import { useVisibleInterval } from "@/hooks/use-visible-interval";
import { getQueueSummary } from "./queue-summary-api";

const minutes = (seconds: number) =>
  `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(seconds / 60)} min`;
export function QueueSummaryPanel({ summary }: { summary: QueueWorkload }) {
  const [now, setNow] = useState(() => Date.now());
  useVisibleInterval(() => setNow(Date.now()), 10_000);
  const fresh = Math.abs(now - Date.parse(summary.checkedAt)) < 120_000;
  const estimates = fresh && summary.evidenceStatus === "verified";
  const range = estimates ? summary.estimatedWaitRange : null;
  const metrics = [
    ["Queued jobs", String(summary.queuedJobs)],
    ["Queued audio", minutes(summary.queuedAudioSeconds)],
    [
      "All outstanding jobs",
      `${summary.outstandingJobs} / ${summary.limits.maxOutstandingJobs}`,
    ],
    ["All reserved audio", minutes(summary.outstandingAudioSeconds)],
    [
      "Outstanding audio ceiling",
      minutes(summary.limits.maxOutstandingAudioSeconds),
    ],
    [
      "Estimated worker time",
      estimates && summary.estimatedWorkerSeconds != null
        ? minutes(summary.estimatedWorkerSeconds)
        : "Unavailable",
    ],
    [
      "Estimated wait",
      range
        ? `${minutes(range.minSeconds)}–${minutes(range.maxSeconds)}`
        : "Unavailable",
    ],
    [
      "Oldest queued at",
      summary.oldestQueuedAt
        ? formatDateTime(summary.oldestQueuedAt)
        : "No queued work",
    ],
  ];
  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <PageSection title="Queue workload">
          <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {metrics.map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-1 font-mono text-lg">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-sm">
            Outstanding short/long distribution:{" "}
            {summary.distribution && summary.shortLongThresholdSeconds != null
              ? `${summary.distribution.short.jobs} jobs / ${minutes(summary.distribution.short.audioSeconds)} at or below ${minutes(summary.shortLongThresholdSeconds)}; ${summary.distribution.long.jobs} jobs / ${minutes(summary.distribution.long.audioSeconds)} above it`
              : "Unavailable"}
            . Rejection history: Unavailable.
          </p>
          <p className="mt-4 text-xs text-muted-foreground">
            Checked {formatDateTime(summary.checkedAt)} · Evidence{" "}
            {summary.evidenceStatus}
            {fresh ? "" : " · Snapshot stale"}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Outstanding workload includes upload reservations and unfinished
            work. A running long job can occupy a single slot; queue order is
            not a completion promise. Cancellation stays pending until the
            worker stop is confirmed.
          </p>
        </PageSection>
      </CardContent>
    </Card>
  );
}

export function QueueSummarySection() {
  const client = useApiClient();
  const { can } = useAdminSession();
  const summary = useQuery({
    queryKey: ["queue-workload"],
    queryFn: () => getQueueSummary(client),
    enabled: can("jobs.read"),
  });
  useVisibleInterval(() => {
    if (can("jobs.read")) void summary.refetch();
  }, 10_000);
  if (!can("jobs.read")) return null;
  if (summary.isLoading) return <LoadingState />;
  if (summary.isError)
    return (
      <ErrorState error={summary.error} retry={() => void summary.refetch()} />
    );
  return summary.data ? <QueueSummaryPanel summary={summary.data} /> : null;
}
