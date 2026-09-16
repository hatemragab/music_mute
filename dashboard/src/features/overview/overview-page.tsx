import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAdminSession, useApiClient } from "@/auth/admin-session";
import { withQuery } from "@/api/query-string";
import { DateRangeFilter } from "@/components/date-range-filter";
import {
  createRange,
  parseDateRange,
  type DateRange,
} from "@/components/date-range";
import { ExportCsvButton } from "@/components/export-csv-button";
import {
  ErrorState,
  LoadingState,
  PageHeader,
  PageSection,
} from "@/components/page";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime, formatDuration } from "@/lib/format";
import { useVisibleInterval } from "@/hooks/use-visible-interval";
import { JobSeriesChart } from "./job-series-chart";
import { getOverview } from "./overview-api";
import { OverviewCards } from "./overview-cards";

const readRange = (): DateRange => {
  const query = new URLSearchParams(window.location.search);
  const fallback = createRange(7);
  const from = query.get("from");
  const to = query.get("to");
  return parseDateRange(from, to, fallback);
};

export function OverviewPage() {
  const client = useApiClient();
  const { can } = useAdminSession();
  const [range, setRange] = useState(readRange);
  const overview = useQuery({
    queryKey: ["overview", range],
    queryFn: ({ signal }) =>
      getOverview(client, range).then((data) =>
        signal.aborted
          ? Promise.reject(new DOMException("Aborted", "AbortError"))
          : data,
      ),
  });
  useVisibleInterval(() => void overview.refetch(), 30_000);
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("from", range.from);
    url.searchParams.set("to", range.to);
    window.history.replaceState(null, "", url);
  }, [range]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Operations overview"
        description="Job activity and outcomes for the selected UTC interval."
        actions={
          <div className="flex flex-wrap items-start justify-end gap-2">
            <DateRangeFilter range={range} onChange={setRange} />
            {can("exports.read") ? (
              <ExportCsvButton
                path={withQuery("/admin/exports/overview.csv", {
                  ...range,
                  bucket: "day",
                })}
                filename="musicmute-overview.csv"
              />
            ) : null}
          </div>
        }
      />
      {overview.isLoading ? (
        <LoadingState rows={6} />
      ) : overview.isError ? (
        <ErrorState
          error={overview.error}
          retry={() => void overview.refetch()}
        />
      ) : overview.data ? (
        <>
          <OverviewCards data={overview.data} />
          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <Card>
              <CardContent className="p-5">
                <PageSection
                  title="Daily job activity"
                  description="Counts by UTC day. A table is available below the chart."
                >
                  <JobSeriesChart series={overview.data.series} />
                </PageSection>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="space-y-5 p-5">
                <PageSection title="Observed timing">
                  <dl className="grid gap-3 text-sm">
                    <div>
                      <dt className="text-muted-foreground">Mean queue wait</dt>
                      <dd className="font-medium">
                        {formatDuration(
                          overview.data.timings.meanQueueWaitSeconds,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Mean processing</dt>
                      <dd className="font-medium">
                        {formatDuration(
                          overview.data.timings.meanProcessingSeconds,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">
                        Users who submitted jobs
                      </dt>
                      <dd className="font-medium">
                        {overview.data.counts.processingActiveUsers}
                      </dd>
                    </div>
                  </dl>
                </PageSection>
                {can("releases.read") && overview.data.releaseSummary ? (
                  <PageSection title="Release inventory">
                    <dl className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <dt className="text-muted-foreground">Drafts</dt>
                        <dd>{overview.data.releaseSummary.draft}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Published</dt>
                        <dd>{overview.data.releaseSummary.published}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Withdrawn</dt>
                        <dd>{overview.data.releaseSummary.withdrawn}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Rejected APKs</dt>
                        <dd>
                          {overview.data.releaseSummary.rejectedArtifacts}
                        </dd>
                      </div>
                    </dl>
                  </PageSection>
                ) : null}
                <p className="border-t pt-3 text-xs text-muted-foreground">
                  Updated {formatDateTime(overview.data.asOf)} ·{" "}
                  {Intl.DateTimeFormat().resolvedOptions().timeZone}
                </p>
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}
