export interface OutboxItemView {
  requestId: string;
  localId: string;
  kind: "pair" | "community-link";
  state:
    | "capturing"
    | "pending"
    | "saving"
    | "retry"
    | "blocked"
    | "saved"
    | "discarded";
  title: string;
  errorCode: string | null;
  jobId: string | null;
  nextAttemptAt: number | null;
}
export interface OutboxView {
  authenticated: boolean;
  busy: boolean;
  errorCode: string | null;
  items: OutboxItemView[];
}
export type OutboxCommand =
  | { type: "RESTORE" }
  | { type: "SAVE_PENDING" }
  | { type: "RETRY" | "DISCARD"; requestId: string };
export function parseOutboxCommand(value: unknown): OutboxCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("OUTBOX_COMMAND_INVALID");
  const row = value as Record<string, unknown>;
  if (
    ["RESTORE", "SAVE_PENDING"].includes(String(row.type)) &&
    Object.keys(row).join() === "type"
  )
    return row as OutboxCommand;
  if (
    ["RETRY", "DISCARD"].includes(String(row.type)) &&
    Object.keys(row).sort().join() === "requestId,type" &&
    typeof row.requestId === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      row.requestId,
    )
  )
    return row as OutboxCommand;
  throw new Error("OUTBOX_COMMAND_INVALID");
}
