import { formatBytes, formatDuration } from "@/lib/format";
import {
  redactPrivateDiagnosticText,
  workerContactState,
} from "./worker-status";
import type { WorkerCommand, WorkerMachineDetail } from "./worker-types";

const labels: Record<string, string> = {
  "check.service": "Supervisor service",
  "check.storage": "Scratch storage",
  "check.model": "Model probe",
  "check.provider": "Provider probe",
  "check.ffmpeg": "FFmpeg probe",
  "runtime.uptime_seconds": "Supervisor uptime",
  "host.uptime_seconds": "Host uptime",
  "runtime.rss_bytes": "Supervisor resident memory",
  "runtime.heap_used_bytes": "Supervisor JavaScript heap",
  "host.memory_total_bytes": "Host total memory",
  "host.memory_free_bytes": "Host free memory",
  "host.available_parallelism": "Available CPU parallelism",
  "storage.free_bytes": "Scratch volume available space",
  "storage.total_bytes": "Scratch volume total space",
  "model.bytes": "Model size",
  "benchmark.iterations": "Benchmark passes",
  "benchmark.mean_seconds": "Mean processing time",
  "benchmark.min_seconds": "Minimum processing time",
  "benchmark.max_seconds": "Maximum processing time",
  "benchmark.mean_result_bytes": "Mean output size",
};

export function presentWorkerMetric(metric: WorkerCommand["metrics"][number]) {
  const label =
    labels[metric.name] ??
    redactPrivateDiagnosticText(metric.name).slice(0, 100);
  const value = !Number.isFinite(metric.value)
    ? "Not reported"
    : metric.unit === "boolean"
      ? metric.value === 1
        ? "Passed"
        : metric.value === 0
          ? "Failed / incomplete"
          : "Unknown"
      : metric.unit === "bytes" && metric.value >= 0
        ? formatBytes(metric.value)
        : metric.unit === "seconds" && metric.value >= 0
          ? formatDuration(metric.value)
          : `${metric.value.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${redactPrivateDiagnosticText(metric.unit).slice(0, 30)}`;
  return { label, value };
}

export function workerReadiness(data: WorkerMachineDetail): string[] {
  const issues: string[] = [];
  const observedAt = Date.parse(data.asOf ?? "");
  if (!Number.isFinite(observedAt))
    issues.push(
      "Observation time is unavailable; contact freshness is unknown.",
    );
  else if (workerContactState(data.machine, observedAt) !== "online")
    issues.push(
      "No recent worker contact at the server snapshot. Check the worker service and its connection.",
    );
  if (data.machine.status !== "active")
    issues.push(
      `Machine is ${data.machine.status}; it is not accepting new work.`,
    );
  if (data.machine.appliedRevision !== data.machine.desiredRevision)
    issues.push(
      "Policy sync is pending. The worker has not applied the desired revision.",
    );
  if (!data.machine.capabilities.length)
    issues.push("No qualified processing capabilities were reported.");
  if (!data.slots.length) issues.push("No processing slots were reported.");
  else if (
    !data.slots.some((slot) => slot.state === "idle" && !slot.currentAttemptId)
  )
    issues.push(
      "No idle slots in this snapshot. Active work or slot state may be blocking claims.",
    );
  return issues;
}
