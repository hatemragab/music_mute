import type { SessionSnapshot } from "./session-contracts.js";
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const SHA = /^[a-f0-9]{64}$/u;
const problems = new Set([
  "NOT_ENROLLED",
  "APPROVAL_REQUIRED",
  "PREPARE_REQUIRED",
  "LEGACY_WORKER_CONFLICT",
  "RESTART_BUDGET_EXHAUSTED",
  "CHILD_CREATION_FAILED",
  "CLAIM_RECONCILIATION_FAILED",
  "CHILD_SHUTDOWN_PENDING",
  "STATE_UNAVAILABLE",
  "SESSION_IDENTITY_CONFLICT",
]);
function row(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("SESSION_UNAVAILABLE");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== fields.length ||
    Object.keys(record).some((k) => !fields.includes(k))
  )
    throw new Error("SESSION_UNAVAILABLE");
  return record;
}
function one(value: unknown, values: readonly string[]): boolean {
  return typeof value === "string" && values.includes(value);
}
function problem(value: unknown): boolean {
  return value === null || (typeof value === "string" && problems.has(value));
}
/** Validate the full native authority snapshot before any UI or admission consumer. */
export function parseSessionSnapshot(value: unknown): SessionSnapshot {
  const s = row(value, [
    "version",
    "instance_id",
    "release",
    "revision",
    "phase",
    "fleet",
    "personal",
    "startup",
    "maintenance",
  ]);
  const fleet = row(s.fleet, ["intent", "phase", "problem"]),
    personal = row(s.personal, ["owners", "phase", "problem"]);
  if (
    s.version !== 1 ||
    typeof s.instance_id !== "string" ||
    !UUID.test(s.instance_id) ||
    typeof s.release !== "string" ||
    !SHA.test(s.release) ||
    !Number.isSafeInteger(s.revision) ||
    (s.revision as number) < 0 ||
    !one(s.phase, [
      "starting",
      "running",
      "sleeping",
      "recovering",
      "blocked",
      "logged-out",
    ]) ||
    !one(s.startup, [
      "absent",
      "registered",
      "disabled",
      "conflict",
      "unknown",
    ]) ||
    !one(fleet.intent, ["stopped", "paused", "draining", "running"]) ||
    !one(fleet.phase, [
      "absent",
      "stopped",
      "starting",
      "running",
      "paused",
      "draining",
      "recovering",
      "blocked",
    ]) ||
    !problem(fleet.problem) ||
    !problem(personal.problem) ||
    !Number.isSafeInteger(personal.owners) ||
    (personal.owners as number) < 0 ||
    (personal.owners as number) > 4096 ||
    !one(personal.phase, [
      "stopped",
      "starting",
      "running",
      "recovering",
      "blocked",
    ])
  )
    throw new Error("SESSION_UNAVAILABLE");
  if (s.maintenance !== null) {
    const maintenance = row(s.maintenance, ["transaction", "phase"]);
    if (
      typeof maintenance.transaction !== "string" ||
      !UUID.test(maintenance.transaction) ||
      !one(maintenance.phase, ["draining", "idle"])
    )
      throw new Error("SESSION_UNAVAILABLE");
  }
  return structuredClone(s) as unknown as SessionSnapshot;
}
