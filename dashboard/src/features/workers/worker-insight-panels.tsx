import { useSyncExternalStore } from "react";
import { useRealtime } from "@/realtime/hooks";
import { formatDateTime } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { presentWorkerMetric, workerReadiness } from "./worker-insights";
import {
  redactPrivateDiagnosticText,
  workerContactState,
} from "./worker-status";
import { workerRecipeLabel } from "./worker-recipes";
import type {
  WorkerCommand,
  WorkerMachineDetail,
  WorkerMachinePage,
} from "./worker-types";

export function WorkerReadinessPanel({ data }: { data: WorkerMachineDetail }) {
  const client = useRealtime();
  const state = useSyncExternalStore(client.onState, client.getState);
  const issues = workerReadiness(data);
  return (
    <section
      aria-label="Worker readiness"
      className="space-y-3 rounded-xl border bg-card p-5"
    >
      <h2 className="font-semibold">Worker readiness</h2>
      {state !== "live" && (
        <p role="status" className="text-sm text-amber-700 dark:text-amber-300">
          Live connection unavailable. These are the last received observations.
        </p>
      )}
      {issues.length ? (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm">
          Machine checks are clear at this snapshot. Fleet policy, recipe
          eligibility and available work still control assignment.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Server observation: {formatDateTime(data.asOf)}. Reported slots:{" "}
        {data.slots.length}. This is not a queue ETA.
      </p>
    </section>
  );
}

export function WorkerFleetSummary({ data }: { data: WorkerMachinePage }) {
  const now = Date.parse(data.asOf);
  const values = [
    ["Machines", data.items.length],
    [
      "Recent contact",
      data.items.filter((item) => workerContactState(item, now) === "online")
        .length,
    ],
    [
      "Policy sync pending",
      data.items.filter((item) => item.appliedRevision !== item.desiredRevision)
        .length,
    ],
    [
      "With recent errors",
      data.items.filter((item) => item.recentError).length,
    ],
  ] as const;
  return (
    <section aria-label="Worker page summary" className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Current page only · {formatDateTime(data.asOf)} · counts follow the
        selected filters.
      </p>
      <dl className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {values.map(([label, count]) => (
          <div key={label} className="rounded-xl border bg-card p-4">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 text-2xl font-semibold">{count}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function WorkerCommandHistory({
  commands,
}: {
  commands: WorkerCommand[];
}) {
  return (
    <section className="space-y-3" aria-label="Recent commands">
      <h3 className="text-sm font-medium">Recent commands</h3>
      <p className="text-xs text-muted-foreground">
        Up to 20 commands. Pending means queued or executing; the worker reports
        a terminal result. Benchmarks wait for idle capacity. Measurements are
        point-in-time; missing values were not reported by that worker version.
      </p>
      {commands.length ? (
        commands.slice(0, 20).map((command) => (
          <article
            key={command.commandId}
            className="space-y-3 rounded-lg border p-4 text-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="font-medium">
                {command.kind === "benchmark" ? "Benchmark" : "Doctor"}
              </h4>
              <StatusBadge value={command.state} />
            </div>
            <p className="break-words">
              {command.kind === "benchmark"
                ? workerRecipeLabel(command.recipeId ?? "Unknown recipe")
                : `Checks: ${command.checks.join(", ")}`}
            </p>
            <p className="text-xs text-muted-foreground">
              Requested {formatDateTime(command.requestedAt)} · Expires{" "}
              {formatDateTime(command.expiresAt)} · Completed{" "}
              {formatDateTime(command.completedAt)}
            </p>
            {command.summary && (
              <p className="break-words">
                {redactPrivateDiagnosticText(command.summary)}
              </p>
            )}
            {command.metrics.length ? (
              <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {command.metrics.slice(0, 100).map((metric, index) => {
                  const { label, value } = presentWorkerMetric(metric);
                  return (
                    <div key={`${metric.name}:${index}`} className="min-w-0">
                      <dt className="break-words text-xs text-muted-foreground">
                        {label}
                      </dt>
                      <dd className="break-words font-medium">{value}</dd>
                    </div>
                  );
                })}
              </dl>
            ) : (
              <p className="text-xs text-muted-foreground">
                No measurements reported yet.
              </p>
            )}
            <p className="break-all font-mono text-xs text-muted-foreground">
              Command {command.commandId}
            </p>
          </article>
        ))
      ) : (
        <p className="text-sm text-muted-foreground">No commands requested.</p>
      )}
    </section>
  );
}
