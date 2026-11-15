const known = new Set([
  "INVALID_INPUT",
  "CONFIRMATION_REQUIRED",
  "ACCOUNT_REQUEST_FAILED",
  "MALFORMED_RESPONSE",
  "CONFIGURATION_REQUIRED",
  "SESSION_CHANGED",
  "VAULT_UNAVAILABLE",
  "NETWORK_UNAVAILABLE",
  "CANCELLED",
  "BUSY",
  "UNAUTHENTICATED",
  "PROFILE_SYNC_REQUIRED",
  "ACCOUNT_DELETION_PENDING",
  "ACCOUNT_RECOVERY_EXPIRED",
  "ACCOUNT_RESTRICTED",
  "REAUTHENTICATION_REQUIRED",
  "ACCOUNT_DISABLED",
  "ACCOUNT_PURGING",
  "ACCOUNT_DELETED",
  "FRESH_AUTH_REQUIRED",
  "GOOGLE_SIGN_IN_REQUIRED",
  "WORKER_REGISTRATION_NOT_ALLOWED",
  "LAST_SIGN_IN_METHOD",
  "RATE_LIMITED",
  "INVALID_LOGIN_CREDENTIALS",
  "INVALID_PASSWORD",
  "EMAIL_NOT_FOUND",
  "EMAIL_EXISTS",
  "INVALID_EMAIL",
  "WEAK_PASSWORD",
  "TOO_MANY_ATTEMPTS_TRY_LATER",
  "USER_DISABLED",
  "TOKEN_EXPIRED",
  "INVALID_REFRESH_TOKEN",
  "USER_NOT_FOUND",
  "INVALID_ID_TOKEN",
  "CREDENTIAL_TOO_OLD_LOGIN_AGAIN",
  "FEDERATED_USER_ID_ALREADY_LINKED",
  "OPERATION_NOT_ALLOWED",
  "GOOGLE_SIGN_IN_TIMEOUT",
  "OAUTH_STATE_MISMATCH",
  "GOOGLE_TOKEN_INVALID_GRANT",
  "DEVICE_REPORT_CONFLICT",
  "SERVICE_UNAVAILABLE",
  "APP_UPDATE_REQUIRED",
  "EMAIL_VERIFICATION_REQUIRED",
  "DEVICE_SYNC_REQUIRED",
  "RECOVERY_UNAVAILABLE",
  "RECOVERY_ALREADY_REQUESTED",
]);
export class AccountError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterSeconds = 0,
  ) {
    super(known.has(code) ? code : "ACCOUNT_REQUEST_FAILED");
    this.code = this.message;
    this.name = "AccountError";
  }
}
export function accountFailure(error: unknown): AccountError {
  if (error instanceof AccountError) return error;
  if (error instanceof TypeError && known.has(error.message))
    return new AccountError(error.message);
  return new AccountError("NETWORK_UNAVAILABLE");
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AccountError("MALFORMED_RESPONSE");
  return value as Record<string, unknown>;
}
export function text(value: unknown, maximum = 100, minimum = 1): string {
  if (
    typeof value !== "string" ||
    [...value].length < minimum ||
    [...value].length > maximum ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  )
    throw new AccountError("MALFORMED_RESPONSE");
  return value;
}
