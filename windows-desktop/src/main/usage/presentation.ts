import type { AccountView } from "../../shared/account-contracts.js";
import type {
  AccountUsageView,
  LinkVisibilityReason,
  ProcessingAdmissionPreview,
  ProcessingMode,
  ProcessingPolicyView,
  UsageAmountView,
} from "../../shared/usage-contracts.js";
import { AccountError, record } from "../account/errors.js";

function integer(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new AccountError("MALFORMED_RESPONSE");
  return value;
}
export function parseResetTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 40)
    throw new AccountError("MALFORMED_RESPONSE");
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) throw new AccountError("MALFORMED_RESPONSE");
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  if (
    year < 2000 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59 ||
    !Number.isFinite(Date.parse(value))
  )
    throw new AccountError("MALFORMED_RESPONSE");
  return value;
}
export function parseUsage(value: unknown, now = Date.now()): UsageAmountView {
  const payload = record(value);
  if (payload.schema_version !== 2)
    throw new AccountError("MALFORMED_RESPONSE");
  const processing = record(payload.processing),
    period = record(payload.period),
    availability = record(payload.availability);
  const used = integer(processing.used_seconds),
    reserved = integer(processing.reserved_seconds),
    remaining = integer(processing.remaining_seconds),
    limit = integer(processing.limit_seconds);
  integer(processing.released_seconds);
  const calculated = BigInt(limit) - BigInt(used) - BigInt(reserved);
  if (
    BigInt(remaining) !== (calculated > 0n ? calculated : 0n) ||
    !["available", "blocked"].includes(String(availability.status))
  )
    throw new AccountError("MALFORMED_RESPONSE");
  const reasons = [
    "paused",
    "storage_limit_reached",
    "monthly_limit_reached",
    "waiting_job_limit",
  ] as const;
  if (
    (availability.status === "available" && availability.reason !== null) ||
    (availability.status === "blocked" &&
      !reasons.includes(availability.reason as (typeof reasons)[number]))
  )
    throw new AccountError("MALFORMED_RESPONSE");
  const resetAt = parseResetTimestamp(period.next_reset_at);
  return {
    usedSeconds: used,
    remainingSeconds: remaining,
    limitSeconds: limit,
    usedPercent:
      Math.round(
        (limit > 0 ? Math.min(1, used / limit) : used > 0 ? 1 : 0) * 1000,
      ) / 10,
    resetAt,
    resetOverdue: Date.parse(resetAt) <= now,
    availability: availability.status as "available" | "blocked",
    unavailableReason:
      availability.reason as UsageAmountView["unavailableReason"],
  };
}
export function parseProcessingPolicy(value: unknown): ProcessingPolicyView {
  const payload = record(value);
  if (
    payload.schema_version !== 2 ||
    typeof payload.accept_new_jobs !== "boolean"
  )
    throw new AccountError("MALFORMED_RESPONSE");
  const revision = integer(payload.revision),
    linkRevision = integer(
      payload.link_import_policy_revision ?? payload.revision,
    ),
    limits = record(payload.limits);
  const disabled = payload.link_import_disabled_countries ?? [];
  if (
    !Array.isArray(disabled) ||
    disabled.length > 250 ||
    disabled.some(
      (country) => typeof country !== "string" || !/^[A-Z]{2}$/.test(country),
    ) ||
    new Set(disabled).size !== disabled.length
  )
    throw new AccountError("MALFORMED_RESPONSE");
  const country = payload.visitor_country ?? null;
  if (
    country !== null &&
    (typeof country !== "string" || !/^[A-Z]{2}$/.test(country))
  )
    throw new AccountError("MALFORMED_RESPONSE");
  const enabled = payload.link_import_enabled === true;
  const reason: LinkVisibilityReason = !enabled
    ? "globally_hidden"
    : payload.link_import_reason === "user_hidden"
      ? "user_hidden"
      : disabled.length && country === null
        ? "unknown_country"
        : disabled.includes(country)
          ? "country_hidden"
          : "allowed";
  // Selected-user IDs are never needed by this client. The server's resolved
  // user_hidden outcome is evaluated before country presentation rules.
  const visible = payload.link_import_visible === true && reason === "allowed";
  return {
    revision,
    linkRevision,
    acceptNewJobs: payload.accept_new_jobs,
    linkImportVisible: visible,
    linkImportReason: visible
      ? "allowed"
      : reason === "allowed"
        ? "globally_hidden"
        : reason,
    linkImportEnabled: enabled,
    disabledCountries: [...disabled] as string[],
    visitorCountry: country as string | null,
    maxDurationSeconds: integer(limits.max_duration_seconds, 1),
    maxPreparedAudioBytes: integer(limits.max_prepared_audio_bytes, 1),
    checkedAt: parseResetTimestamp(payload.checked_at),
  };
}
export function policyToWire(
  policy: ProcessingPolicyView,
): Record<string, unknown> {
  return {
    schema_version: 2,
    revision: policy.revision,
    link_import_policy_revision: policy.linkRevision,
    accept_new_jobs: policy.acceptNewJobs,
    link_import_visible: policy.linkImportVisible,
    link_import_reason: policy.linkImportReason,
    link_import_enabled: policy.linkImportEnabled,
    link_import_disabled_countries: policy.disabledCountries,
    visitor_country: policy.visitorCountry,
    limits: {
      max_duration_seconds: policy.maxDurationSeconds,
      max_prepared_audio_bytes: policy.maxPreparedAudioBytes,
    },
    checked_at: policy.checkedAt,
  };
}
export function resolveProcessingMode(
  requested: ProcessingMode,
  _authenticated: boolean,
): ProcessingMode {
  return requested;
}
export function processingAdmissionPreview(
  requested: ProcessingMode,
  localReady: boolean,
  account: Pick<AccountView, "state" | "online" | "access">,
  usage: AccountUsageView,
): ProcessingAdmissionPreview {
  const authenticated = account.state === "signed-in";
  const mode = resolveProcessingMode(requested, authenticated);
  if (mode === "cloud" && !authenticated)
    return {
      mode,
      allowed: false,
      reason: "SIGN_IN_REQUIRED",
      signInRequired: true,
    };
  if (mode === "local")
    return {
      mode,
      allowed: localReady,
      reason: localReady ? null : "PREPARE_REQUIRED",
      signInRequired: requested === "cloud" && !authenticated,
    };
  let reason: string | null = null;
  if (!account.online || !usage.authenticated) reason = "ACCOUNT_OFFLINE";
  else if (!account.access.allowed)
    reason = account.access.reason ?? "ACCOUNT_REQUEST_FAILED";
  else if (
    usage.policyState !== "current" ||
    usage.usageState !== "current" ||
    !usage.policy ||
    !usage.usage
  )
    reason = "CLOUD_POLICY_UNAVAILABLE";
  else if (!usage.policy.acceptNewJobs) reason = "PROCESSING_PAUSED";
  else if (usage.usage.availability === "blocked")
    reason = usage.usage.unavailableReason;
  else if (usage.usage.remainingSeconds <= 0)
    reason = "PROCESSING_ALLOWANCE_EXHAUSTED";
  return { mode, allowed: reason === null, reason, signInRequired: false };
}
export { formatUsage } from "../../shared/usage-presentation.js";
