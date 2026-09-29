import { formatJson, humanizeLabel } from "./cli-format.js";
export interface UserHealthCheck {
  name: string;
  ok: boolean;
  path: string;
  status?: "passed" | "failed" | "warning" | "unsupported" | "not-run";
  code?: string;
  evidence?: string;
  nextAction?: string;
}

export interface UserHealth {
  schemaVersion: 1;
  healthy: boolean;
  checks: UserHealthCheck[];
  depth?: "quick" | "full";
}

export class HealthCheckFailure extends Error {
  constructor(
    readonly code: string,
    readonly evidence: string,
  ) {
    super(evidence);
  }
}

export function notRun(
  name: string,
  path: string,
  nextAction: string,
): UserHealthCheck {
  return {
    name,
    path,
    ok: false,
    status: "not-run",
    code: "NOT_RUN",
    evidence: "Not checked in quick mode",
    nextAction,
  };
}

export async function checkOperation(
  name: string,
  path: string,
  operation: () => Promise<void>,
): Promise<UserHealthCheck> {
  try {
    await operation();
    return {
      name,
      ok: true,
      path,
      status: "passed",
      code: "OK",
      evidence: "Check completed",
      nextAction: "None",
    };
  } catch (error) {
    return {
      name,
      ok: false,
      path,
      status: "failed",
      code:
        error instanceof HealthCheckFailure
          ? error.code
          : `${name.toUpperCase().replaceAll("-", "_")}_FAILED`,
      evidence:
        error instanceof HealthCheckFailure
          ? error.evidence
          : "Check failed; run doctor --full and inspect recent errors",
      nextAction:
        name === "runtime-doctor"
          ? "Check model cache and provider integrity with doctor --full"
          : `Inspect ${name} and rerun doctor --full`,
    };
  }
}

export function formatHealth(health: UserHealth, json: boolean): string {
  if (json) return formatJson(health);
  const passed = health.checks.filter((check) => check.ok).length;
  const failed = health.checks.filter(
    (check) =>
      !check.ok && check.status !== "not-run" && check.status !== "warning",
  ).length;
  const skipped = health.checks.filter(
    (check) => check.status === "not-run",
  ).length;
  const lines = [
    "MusicMute Worker Doctor",
    "",
    `Overall: ${health.healthy ? "Healthy" : "Problems found"}`,
    `Checks: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} not run` : ""}`,
    "",
  ];
  for (const check of health.checks) {
    lines.push(
      `[${check.status === "not-run" ? "NOT RUN" : check.ok ? "PASS" : "FAIL"}] ${humanizeLabel(check.name)}`,
      `       ${check.path}`,
    );
    if (check.code) lines.push(`       ${check.code}: ${check.evidence ?? ""}`);
    if (!check.ok && check.nextAction)
      lines.push(`       Next: ${check.nextAction}`);
  }
  return lines.join("\n");
}
