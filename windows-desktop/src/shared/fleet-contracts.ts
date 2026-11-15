export type FleetIntent = "running" | "paused" | "draining" | "stopped";
export type FleetEligibility =
  | "signed-out"
  | "google-required"
  | "recent-auth-required"
  | "approval-required"
  | "prepare-required"
  | "ready"
  | "unavailable";
export interface FleetView {
  renewInvitationAvailable?: boolean;
  autoEnrollmentAllowed?: boolean;
  state:
    | "absent"
    | "installing"
    | "interrupted"
    | "registered"
    | "revoked"
    | "unavailable";
  eligibility: FleetEligibility;
  busy: boolean;
  machineId: string | null;
  label: string | null;
  intent: FleetIntent;
  connected: boolean;
  backendState: "pending" | "active" | "paused" | "draining" | null;
  activeAttempts: number | null;
  claimsAllowed: boolean;
  errorCode: string | null;
}
export type FleetCommand =
  | {
      type:
        | "RESTORE"
        | "CHECK_ELIGIBILITY"
        | "ENROLL"
        | "RENEW_INVITATION"
        | "START"
        | "PAUSE"
        | "DRAIN"
        | "RESUME"
        | "STOP"
        | "RESTART";
    }
  | { type: "REVOKE"; confirmed: true };
const names = new Set([
  "RESTORE",
  "CHECK_ELIGIBILITY",
  "ENROLL",
  "RENEW_INVITATION",
  "START",
  "PAUSE",
  "DRAIN",
  "RESUME",
  "STOP",
  "RESTART",
  "REVOKE",
]);
export function parseFleetCommand(value: unknown): FleetCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("FLEET_COMMAND_INVALID");
  const row = value as Record<string, unknown>;
  if (
    typeof row.type !== "string" ||
    !names.has(row.type) ||
    Object.keys(row).some(
      (key) =>
        key !== "type" && !(row.type === "REVOKE" && key === "confirmed"),
    ) ||
    (row.type === "REVOKE" && row.confirmed !== true)
  )
    throw new Error("FLEET_COMMAND_INVALID");
  return structuredClone(row) as FleetCommand;
}
