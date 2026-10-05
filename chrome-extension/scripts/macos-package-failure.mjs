import { open, lstat } from "node:fs/promises";
import { basename, join } from "node:path";

const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const phases = new Set([
  "OPTIONS",
  "IDENTITY",
  "RUNTIME_SOURCE",
  "COPY_RUNTIME",
  "COPY_DOWNLOADER",
  "COPY_UPDATER",
  "COPY_APP_RESOURCES",
  "PUBLIC_CONFIG",
  "COPY_YOUTUBE_RUNTIME",
  "COMPILE_NATIVE",
  "AUDIT_BUNDLE",
  "ENTITLEMENTS",
  "AUDIT_NATIVE",
  "SIGN_NATIVE",
  "VERIFY_NATIVE",
  "PACKAGE_RUNTIME",
  "BUNDLE_NOTICES",
  "BUNDLE_AUDIT",
  "SIGN_APP",
  "VERIFY_APP",
  "FINAL_INVENTORY",
  "PACKAGE_RECORD",
]);
const signalPattern = /^SIG(?:TERM|KILL|ABRT|SEGV|ILL|BUS|INT|PIPE|HUP)$/;
const validationCodes = new Set([
  "UNSUPPORTED_PLATFORM",
  "INVALID_PACKAGE_OPTIONS",
  "YT_DLP_IDENTITY_INVALID",
  "PO_TOKEN_PROVIDER_INVALID",
  "SPARKLE_ARCHIVE_INVALID",
  "SPARKLE_ARCHIVE_HASH_MISMATCH",
  "SPARKLE_DOWNLOAD_FAILED",
  "SPARKLE_VERSION_MISMATCH",
  "MACOS_VERSION_INVALID",
  "UPDATER_CONFIG_INCOMPLETE",
  "UPDATER_FEED_INVALID",
  "UPDATER_PUBLIC_KEY_INVALID",
  "DESKTOP_PUBLIC_CONFIG_TOO_LARGE",
  "DESKTOP_PUBLIC_CONFIG_MISSING",
  "DESKTOP_PUBLIC_CONFIG_UNREADABLE",
  "DESKTOP_PUBLIC_CONFIG_UNAPPROVED_FIELDS",
  "DESKTOP_PUBLIC_CONFIG_INVALID",
  "FIXTURE_EXTENSION_CANNOT_BE_PACKAGED",
  "BUNDLE_SYMLINK_ESCAPE",
  "UNSUPPORTED_BUNDLE_ENTRY",
  "RELEASE_MAIN_EXECUTABLE_NOT_IN_INVENTORY",
  "RELEASE_LOAD_COMMANDS_INVALID",
  "RELEASE_MACOS_SDK_UNVERIFIED",
  "RELEASE_MACOS_SDK_UNSUPPORTED",
  "SIGNING_IDENTITY_OUTPUT_INVALID",
  "RELEASE_REQUIRES_DEVELOPER_ID_APPLICATION_IDENTITY",
  "RELEASE_SIGNING_IDENTITY_LOOKUP_FAILED",
  "RELEASE_SIGNING_IDENTITY_NOT_UNIQUE_OR_UNAVAILABLE",
  "INVALID_SIGNING_TARGET_KIND",
  "DMG_CANNOT_DECLARE_RUNTIME_ENTITLEMENTS",
  "RELEASE_SIGNING_CONFIGURATION_INVALID",
  "RELEASE_EMBEDDED_ENTITLEMENTS_INVALID",
  "RELEASE_DEBUG_ENTITLEMENT_FORBIDDEN",
  "RELEASE_SIGNATURE_DETAILS_INVALID",
  "RELEASE_SIGNATURE_DEVELOPER_ID_MISMATCH",
  "RELEASE_SIGNATURE_SECURE_TIMESTAMP_MISSING",
  "RELEASE_SIGNATURE_HARDENED_RUNTIME_MISSING",
  "RELEASE_SIGNATURE_VERIFICATION_FAILED",
  "RUNTIME_DOWNLOAD_BASE_URL_REQUIRED",
  "RUNTIME_DOWNLOAD_BASE_URL_INVALID",
  "RUNTIME_DOWNLOAD_HOSTS_INVALID",
  "RUNTIME_SIGNING_MODE_UNSUPPORTED",
  "RUNTIME_RELEASE_ROOT_UNSAFE",
  "RUNTIME_PAYLOAD_UNSAFE",
  "RUNTIME_PATH_UNSAFE",
  "RUNTIME_LINK_UNSAFE",
  "RUNTIME_DIRECTORY_UNSAFE",
  "RUNTIME_FILE_UNSAFE",
  "RUNTIME_FILE_TOO_LARGE",
  "RUNTIME_INSTALLED_BYTES_INVALID",
  "RUNTIME_FILE_COUNT_INVALID",
  "RUNTIME_SHAPE_INVALID",
  "RUNTIME_SIGNATURE_VERIFIER_REQUIRED",
  "RUNTIME_SIGNATURE_INVALID",
  "RUNTIME_ARCHIVE_INVALID",
  "RUNTIME_ARCHIVE_LISTING_INVALID",
  "RUNTIME_MANIFEST_TOO_LARGE",
  "BUNDLED_RUNTIME_NOT_REMOVED",
]);

/** No error message, command, stdout, stderr, certificate CN or absolute path is retained. */
export function packageFailureReport(error, context) {
  const timeout =
    Number.isSafeInteger(context.timeout_ms) &&
    context.timeout_ms > 0 &&
    context.timeout_ms <= 900_000
      ? context.timeout_ms
      : null;
  const phase = phases.has(context.phase) ? context.phase : "UNKNOWN";
  const bundlePath =
    typeof context.bundle_path === "string" &&
    context.bundle_path.length <= 1024 &&
    /^Contents\/[A-Za-z0-9_ .+/@()-]+$/.test(context.bundle_path) &&
    !context.bundle_path
      .split("/")
      .some((part) => ["", ".", ".."].includes(part))
      ? context.bundle_path
      : null;
  const validationCode = validationCodes.has(error?.message)
    ? error.message
    : null;
  const toolFailure = context.tool_failure ?? error;
  const exitCode = Number.isSafeInteger(toolFailure?.code)
    ? toolFailure.code
    : null;
  const signal = signalPattern.test(toolFailure?.signal ?? "")
    ? toolFailure.signal
    : null;
  let kind = "UNKNOWN";
  if (toolFailure?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
    kind = "OUTPUT_LIMIT";
  else if (
    timeout !== null &&
    toolFailure?.killed === true &&
    signal === "SIGTERM" &&
    toolFailure?.code == null
  )
    kind = "TIMEOUT";
  else if (exitCode !== null) kind = "EXIT";
  else if (signal !== null) kind = "SIGNAL";
  else if (validationCode) kind = "VALIDATION";
  const prefix = context.release ? "MACOS_RELEASE" : "MACOS_PACKAGE";
  return {
    schema_version: 1,
    build_id: uuidPattern.test(context.build_id ?? "")
      ? context.build_id
      : null,
    release_mode: context.release === true,
    phase,
    bundle_path: bundlePath,
    failure_kind: kind,
    error_code: validationCode ?? `${prefix}_${phase}_${kind}`,
    exit_code: exitCode,
    signal,
    timeout_ms: kind === "TIMEOUT" ? timeout : null,
    public_ready: false,
    notarized: false,
  };
}

/** Write only to the uniquely generated, owned build; never replace a prior report. */
export async function writePackageFailure(buildRoot, report) {
  if (
    !report.build_id ||
    basename(buildRoot) !== `build-${report.build_id}.noindex`
  )
    throw new Error("INVALID_PACKAGE_FAILURE_ROOT");
  const info = await lstat(buildRoot);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o022
  )
    throw new Error("UNSAFE_PACKAGE_FAILURE_ROOT");
  const handle = await open(
    join(buildRoot, "package-failure.json"),
    "wx",
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await open(buildRoot, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
