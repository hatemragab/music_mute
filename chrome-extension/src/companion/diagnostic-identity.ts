import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { VERSION } from "../shared/protocol.js";
import { MODEL_SHA256 } from "./local-provider.js";

export interface DiagnosticIdentity {
  software_version: string;
  runtime_scope: "PACKAGED_APP" | "DEVELOPMENT";
  expected_model_sha256: string;
  package_inventory_sha256?: string;
}

const MAX_INVENTORY_BYTES = 8 * 1024 * 1024;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9._-]+)?$/;

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** Project historical identity scalars only; never replace them with today's pins. */
export function sanitizeDiagnosticIdentity(
  value: unknown,
): DiagnosticIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const source = value as Record<string, unknown>;
  if (
    typeof source.software_version !== "string" ||
    source.software_version.length > 64 ||
    !VERSION_PATTERN.test(source.software_version) ||
    (source.runtime_scope !== "PACKAGED_APP" &&
      source.runtime_scope !== "DEVELOPMENT") ||
    !isSha256(source.expected_model_sha256) ||
    (source.package_inventory_sha256 != null &&
      !isSha256(source.package_inventory_sha256))
  )
    return;
  return {
    software_version: source.software_version,
    runtime_scope: source.runtime_scope as DiagnosticIdentity["runtime_scope"],
    expected_model_sha256: source.expected_model_sha256,
    ...(source.package_inventory_sha256 == null
      ? {}
      : { package_inventory_sha256: source.package_inventory_sha256 }),
  };
}

function safeBundledPermissions(info: Stats): boolean {
  // Installed resources may belong to an administrator or another Mac account.
  // This optional fingerprint is not a code-signature trust decision.
  return !(info.mode & 0o022);
}

function unchanged(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mode === after.mode &&
    before.uid === after.uid &&
    before.nlink === after.nlink &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

/** Optional inventory evidence. This is not a signature or installed-file audit. */
function inventoryFingerprint(resources: string): string | undefined {
  let fd: number | undefined;
  try {
    const directory = lstatSync(resources);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      !safeBundledPermissions(directory)
    )
      return;
    const path = join(resources, "bundle-audit.json");
    const before = lstatSync(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      !safeBundledPermissions(before) ||
      before.size <= 0 ||
      before.size > MAX_INVENTORY_BYTES
    )
      return;
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    if (!unchanged(before, fstatSync(fd))) return;
    // Bound even a file that grows between fstat and read; never readFile an append stream.
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, count);
      if (!read) break;
      count += read;
    }
    const afterDirectory = lstatSync(resources);
    if (
      count !== before.size ||
      !unchanged(before, fstatSync(fd)) ||
      !unchanged(before, lstatSync(path)) ||
      !afterDirectory.isDirectory() ||
      afterDirectory.isSymbolicLink() ||
      !safeBundledPermissions(afterDirectory) ||
      directory.dev !== afterDirectory.dev ||
      directory.ino !== afterDirectory.ino
    )
      return;
    const inventory: unknown = JSON.parse(
      bytes.subarray(0, count).toString("utf8"),
    );
    if (!inventory || typeof inventory !== "object" || Array.isArray(inventory))
      return;
    const audit = inventory as Record<string, unknown>;
    if (
      audit.schema_version !== 1 ||
      audit.architecture !== "arm64" ||
      audit.includes_model_weights !== false ||
      audit.includes_worker_state !== false ||
      !Array.isArray(audit.files) ||
      audit.files.length === 0 ||
      audit.files.length > 50_000
    )
      return;
    return createHash("sha256").update(bytes.subarray(0, count)).digest("hex");
  } catch {
    return;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* Optional diagnostic evidence cannot interrupt processing. */
      }
    }
  }
}

/** Each native entry point resolves once, then reuses this recorder-owned identity. */
export function resolveDiagnosticIdentity(config: {
  app_resources?: string;
}): DiagnosticIdentity {
  const fingerprint = config.app_resources
    ? inventoryFingerprint(config.app_resources)
    : undefined;
  return {
    software_version: VERSION,
    runtime_scope: config.app_resources ? "PACKAGED_APP" : "DEVELOPMENT",
    expected_model_sha256: MODEL_SHA256,
    ...(fingerprint ? { package_inventory_sha256: fingerprint } : {}),
  };
}
