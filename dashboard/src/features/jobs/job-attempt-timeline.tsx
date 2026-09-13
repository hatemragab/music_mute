import type { AttemptSummary } from "@/api/contracts";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime, formatDuration } from "@/lib/format";

export function JobAttemptTimeline({
  attempts,
}: {
  attempts: AttemptSummary[];
}) {
  if (!attempts.length)
    return (
      <p className="text-sm text-muted-foreground">No attempts recorded.</p>
    );
  return (
    <ol className="relative space-y-4 border-l pl-5">
      {attempts.map((attempt) => (
        <li key={attempt.id} className="relative">
          <span className="absolute -left-[1.48rem] top-1 size-2.5 rounded-full bg-primary ring-4 ring-background" />
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-foreground">
              Attempt {attempt.generation}
            </span>
            <StatusBadge
              value={
                attempt.outcome ??
                (attempt.endedAt ? "completed" : "processing")
              }
            />
            {attempt.recoveryRequired ? (
              <StatusBadge value="warning" label="Recovery required" />
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Worker {attempt.workerId ?? "unassigned"} ·{" "}
            {formatDateTime(attempt.startedAt)} ·{" "}
            {formatDuration(attempt.durationSeconds)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Separator execution:{" "}
            {attempt.separatorExecutionSeconds == null
              ? "Unavailable"
              : formatDuration(attempt.separatorExecutionSeconds)}{" "}
            · Stop confirmed:{" "}
            {attempt.stoppedConfirmed === true ? "Yes" : "Not confirmed"} ·
            Separation completed:{" "}
            {attempt.separationCompleted === true ? "Yes" : "Not confirmed"}
          </p>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground break-all">
            {attempt.id}
          </p>
        </li>
      ))}
    </ol>
  );
}
