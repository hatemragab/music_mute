import type { PersonalJobView } from "./personal-contracts.js";
export interface PersonalUiView {
  connected: boolean;
  busy: boolean;
  jobs: PersonalJobView[];
  error: string | null;
}
export type PersonalUiCommand =
  | {
      type: "SUBMIT_FILE";
      capability: string;
      rightsConfirmed: true;
      trimEnabled: boolean;
    }
  | {
      type: "SUBMIT_YOUTUBE";
      url: string;
      rightsConfirmed: true;
      trimEnabled: boolean;
    }
  | { type: "CANCEL"; jobId: string }
  | { type: "CANCEL_REQUEST"; requestId: string };
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
export function parsePersonalUiCommand(value: unknown): PersonalUiCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_REQUEST");
  const row = value as Record<string, unknown>;
  const exact = (keys: string[]) =>
    Object.keys(row).sort().join() === keys.sort().join();
  if (
    row.type === "CANCEL" &&
    exact(["type", "jobId"]) &&
    typeof row.jobId === "string" &&
    UUID.test(row.jobId)
  )
    return row as PersonalUiCommand;
  if (
    row.type === "CANCEL_REQUEST" &&
    exact(["type", "requestId"]) &&
    typeof row.requestId === "string" &&
    UUID.test(row.requestId)
  )
    return row as PersonalUiCommand;
  if (row.rightsConfirmed !== true || typeof row.trimEnabled !== "boolean")
    throw new Error("INVALID_REQUEST");
  if (
    row.type === "SUBMIT_FILE" &&
    exact(["type", "capability", "rightsConfirmed", "trimEnabled"]) &&
    typeof row.capability === "string" &&
    UUID.test(row.capability)
  )
    return row as PersonalUiCommand;
  if (
    row.type === "SUBMIT_YOUTUBE" &&
    exact(["type", "url", "rightsConfirmed", "trimEnabled"]) &&
    typeof row.url === "string" &&
    row.url.length > 0 &&
    row.url.length <= 4096 &&
    !/[\p{Cc}\p{Cf}]/u.test(row.url)
  )
    return row as PersonalUiCommand;
  throw new Error("INVALID_REQUEST");
}
