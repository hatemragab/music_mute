/** Manual installation diagnostics contain fixed component names and codes, never paths. */
export const CHECK_COMPONENTS = ["runtime", "model", "youtube_tools"] as const;
export type CheckComponent = (typeof CHECK_COMPONENTS)[number];
export interface InstallationCheck {
  installation_id: string;
  started_at: number;
  completed_at?: number;
  state: "running" | "passed" | "failed";
  checks: {
    component: CheckComponent;
    state: "pending" | "running" | "passed" | "failed";
    duration_ms?: number;
    error_code?: string;
  }[];
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const bounded = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER;
export function isInstallationCheck(
  value: unknown,
): value is InstallationCheck {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "installation_id",
          "started_at",
          "completed_at",
          "state",
          "checks",
        ].includes(key),
    ) ||
    typeof value.installation_id !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.installation_id) ||
    !bounded(value.started_at) ||
    !["running", "passed", "failed"].includes(String(value.state)) ||
    (value.completed_at !== undefined &&
      (!bounded(value.completed_at) ||
        value.completed_at < value.started_at)) ||
    (value.state !== "running" && value.completed_at === undefined) ||
    !Array.isArray(value.checks) ||
    value.checks.length !== CHECK_COMPONENTS.length
  )
    return false;
  return value.checks.every(
    (check, index) =>
      record(check) &&
      Object.keys(check).every((key) =>
        ["component", "state", "duration_ms", "error_code"].includes(key),
      ) &&
      check.component === CHECK_COMPONENTS[index] &&
      ["pending", "running", "passed", "failed"].includes(
        String(check.state),
      ) &&
      (check.duration_ms === undefined || bounded(check.duration_ms)) &&
      (check.error_code === undefined ||
        (typeof check.error_code === "string" &&
          /^[A-Z][A-Z0-9_]{1,79}$/.test(check.error_code))) &&
      (value.state !== "passed" || check.state === "passed"),
  );
}
