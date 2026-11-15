/** Fixed diagnostic codes only. Unknown native/tool messages never become public text. */
const CODES = new Set([
  "INSTALLATION_CHECK_FAILED",
  "INSTALLATION_CHECK_BUSY",
  "CANCELLED",
  "SETUP_REQUIRED",
  "MODEL_NOT_READY",
  "GPU_UNSUPPORTED",
  "YOUTUBE_TOOLS_UNAVAILABLE",
  "YT_DLP_IDENTITY_INVALID",
  "YT_DLP_VERSION_INVALID",
  "CLI_OPTION_UNSUPPORTED",
  "YT_DLP_EJS_MISSING",
  "DENO_VERSION_INVALID",
  "PO_TOKEN_PROVIDER_UNAVAILABLE",
  "STORAGE_RECOVERY_PENDING",
  "STORAGE_NOT_READY",
  "STORAGE_WRITE_LIMIT",
  "STORAGE_WORKSPACE_CHANGED",
  "MEDIA_BUSY",
  "MEDIA_TOOLS_REQUIRED",
  "MEDIA_SHUTDOWN_PENDING",
  "HELPER_INTEGRITY_INVALID",
  "PATH_UNSAFE",
  "DIAGNOSTICS_CONTEXT_INVALID",
]);
export function isInstallationCheckCode(value: unknown): value is string {
  return typeof value === "string" && CODES.has(value);
}
export function installationCheckFailure(
  error: unknown,
  fallback: "INSTALLATION_CHECK_FAILED" | "YOUTUBE_TOOLS_UNAVAILABLE",
) {
  return error instanceof Error && isInstallationCheckCode(error.message)
    ? error.message
    : fallback;
}
