import { execFile } from "node:child_process";
import type { DiagnosticInput } from "../shared/protocol.js";

export const RESOURCE_SAMPLE_INTERVAL_MS = 5_000;

/** Sample one explicitly owned process; caller attaches its job ID if appropriate. */
export function beginSample(
  pid: number,
  onDiagnostic: (event: DiagnosticInput) => void,
): () => void {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new TypeError("INVALID_RESOURCE_PID");
  let stopped = false;
  let busy = false;
  let failures = 0;
  let lastCpu = process.cpuUsage();
  let lastAt = performance.now();
  const emit = (event: DiagnosticInput): void => {
    if (!stopped) {
      try {
        onDiagnostic(event);
      } catch {
        /* Diagnostics must not prevent process cleanup. */
      }
    }
  };
  const sample = (): void => {
    if (stopped || busy) return;
    if (pid === process.pid) {
      const memory = process.memoryUsage();
      const at = performance.now();
      const cpu = process.cpuUsage();
      const elapsed = at - lastAt;
      const percent =
        elapsed > 0
          ? ((cpu.user - lastCpu.user + cpu.system - lastCpu.system) /
              (elapsed * 1_000)) *
            100
          : 0;
      lastCpu = cpu;
      lastAt = at;
      emit({
        component: "companion",
        severity: "info",
        event: "resource_sample",
        metrics: {
          resource_scope: "companion",
          pid,
          rss_bytes: memory.rss,
          heap_used_bytes: memory.heapUsed,
          heap_total_bytes: memory.heapTotal,
          cpu_percent: percent,
          active_resources: process.getActiveResourcesInfo().length,
          sample_interval_ms: RESOURCE_SAMPLE_INTERVAL_MS,
        },
      });
      return;
    }
    busy = true;
    execFile(
      "/bin/ps",
      ["-o", "rss=,pcpu=", "-p", String(pid)],
      { timeout: 2_000, maxBuffer: 4_096 },
      (error, stdout) => {
        busy = false;
        if (stopped) return;
        const match = /^\s*(\d+)\s+(\d+(?:\.\d+)?)\s*$/.exec(stdout);
        if (error || !match) {
          if (failures++ === 0)
            emit({
              component: "companion",
              severity: "warning",
              event: "diagnostic_error",
              code: "RESOURCE_SAMPLE_UNAVAILABLE",
              metrics: { resource_scope: "child", pid },
            });
          return;
        }
        failures = 0;
        emit({
          component: "engine",
          severity: "info",
          event: "resource_sample",
          metrics: {
            resource_scope: "child",
            pid,
            child_rss_bytes: Number(match[1]) * 1024,
            cpu_percent: Number(match[2]),
            sample_interval_ms: RESOURCE_SAMPLE_INTERVAL_MS,
          },
        });
      },
    );
  };
  const timer = setInterval(sample, RESOURCE_SAMPLE_INTERVAL_MS);
  timer.unref();
  sample();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
