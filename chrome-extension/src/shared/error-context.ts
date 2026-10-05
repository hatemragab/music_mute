/** Public failure evidence. Never include tool text, source URLs or account identity. */
export interface ErrorContext {
  stage?: ErrorStage;
  retry_at?: number;
  block_reason?:
    | "SOURCE_BOT_CHALLENGE"
    | "ACQUISITION_RATE_LIMITED"
    | "ACQUISITION_INTERRUPTED";
  http_status?: 401 | 403 | 429;
}
export type ErrorStage =
  | "metadata"
  | "download"
  | "runtime"
  | "setup"
  | "playback"
  | "storage"
  | "account"
  | "cache_lock"
  | "cache_lookup"
  | "account_restore"
  | "workspace"
  | "cache_pin"
  | "cache_budget"
  | "outbox_admission"
  | "provider"
  | "validation"
  | "publication";
const stages: readonly string[] = [
  "metadata",
  "download",
  "runtime",
  "setup",
  "playback",
  "storage",
  "account",
  "cache_lock",
  "cache_lookup",
  "account_restore",
  "workspace",
  "cache_pin",
  "cache_budget",
  "outbox_admission",
  "provider",
  "validation",
  "publication",
];
const reasons = [
  "SOURCE_BOT_CHALLENGE",
  "ACQUISITION_RATE_LIMITED",
  "ACQUISITION_INTERRUPTED",
];
export function isErrorContext(value: unknown): value is ErrorContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  return (
    Object.keys(context).every((key) =>
      ["stage", "retry_at", "block_reason", "http_status"].includes(key),
    ) &&
    (context.stage === undefined ||
      (typeof context.stage === "string" && stages.includes(context.stage))) &&
    (context.retry_at === undefined ||
      (typeof context.retry_at === "number" &&
        Number.isSafeInteger(context.retry_at) &&
        context.retry_at > 0 &&
        context.retry_at <= 8_640_000_000_000_000)) &&
    (context.block_reason === undefined ||
      (typeof context.block_reason === "string" &&
        reasons.includes(context.block_reason))) &&
    (context.http_status === undefined ||
      ([401, 403, 429].includes(Number(context.http_status)) &&
        typeof context.http_status === "number"))
  );
}
/** Project reviewed fields individually: a rejected private field never enters a reply. */
export function projectErrorContext(value: unknown): ErrorContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const input = value as Record<string, unknown>;
  const output: ErrorContext = {};
  for (const key of [
    "stage",
    "retry_at",
    "block_reason",
    "http_status",
  ] as const) {
    if (input[key] !== undefined && isErrorContext({ [key]: input[key] }))
      Object.assign(output, { [key]: input[key] });
  }
  return Object.keys(output).length ? output : undefined;
}
