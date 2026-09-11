import type { OverviewSnapshot } from "@/api/contracts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDuration } from "@/lib/format";

export function OverviewCards({ data }: { data: OverviewSnapshot }) {
  const cards = [
    ["Submitted", data.counts.submitted, "In selected range"],
    ["Completed", data.counts.completed, "In selected range"],
    ["Failed", data.counts.failed, "In selected range"],
    ["Cancelled", data.counts.cancelled, "In selected range"],
    [
      "Waiting now",
      data.queue.waiting,
      `Oldest ${formatDuration(data.queue.oldestWaitSeconds)}`,
    ],
    [
      "Processing now",
      data.queue.processing,
      `${data.workers.online}/${data.workers.total} workers online`,
    ],
  ] as const;
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {cards.map(([label, value, detail]) => (
        <Card key={label}>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {label}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="font-mono text-3xl font-semibold text-foreground">
              {value}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
