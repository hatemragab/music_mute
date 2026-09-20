import type { WorkerMachine } from "./worker-types";

export type WorkerContactState = "online" | "stale" | "offline" | "never";

export const workerContactState = (
  machine: Pick<WorkerMachine, "status" | "lastSeenAt">,
  now = Date.now(),
): WorkerContactState => {
  if (!machine.lastSeenAt) return "never";
  const lastSeen = new Date(machine.lastSeenAt).getTime();
  if (!Number.isFinite(lastSeen)) return "never";
  const age = Math.max(0, now - lastSeen);
  if (age > 5 * 60_000) return "offline";
  if (age > 90_000) return "stale";
  return machine.status === "revoked" ? "offline" : "online";
};

export const boundedDiagnosticLines = (
  lines: readonly string[],
  maxLines = 100,
  maxCharacters = 1_000,
) => lines.slice(0, maxLines).map((line) => line.slice(0, maxCharacters));

export const redactPrivateDiagnosticText = (line: string) =>
  line
    .replace(/https?:\/\/[^\s)\]}]+/gi, "[redacted-url]")
    .replace(
      /["']?\b(authorization)\b["']?\s*(?::|=)\s*(?:bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
      "$1=[redacted]",
    )
    .replace(
      /["']?\b(credential|token|secret)\b["']?\s*(?:(?::|=)\s*|\s+)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
      "$1=[redacted]",
    );
