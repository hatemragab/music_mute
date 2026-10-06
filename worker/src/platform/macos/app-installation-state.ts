import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import type { MacUserLayout } from "./user-paths.js";
import { privateWrite, readBoundedJson } from "./app-installation-binding.js";

export interface QualifiedRollbackReference {
  schemaVersion: 1;
  knownGoodVersion: string;
  previousVersion: string | null;
}
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u;
export function validateMacQualifiedRollback(
  value: unknown,
): QualifiedRollbackReference {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Qualified rollback reference is invalid");
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.knownGoodVersion !== "string" ||
    !VERSION.test(record.knownGoodVersion) ||
    (record.previousVersion !== null &&
      (typeof record.previousVersion !== "string" ||
        !VERSION.test(record.previousVersion))) ||
    Object.keys(record).length !== 3 ||
    Object.keys(record).some(
      (key) =>
        !["schemaVersion", "knownGoodVersion", "previousVersion"].includes(key),
    )
  )
    throw new TypeError("Qualified rollback reference is invalid");
  return record as unknown as QualifiedRollbackReference;
}
export async function readMacQualifiedRollback(
  layout: Pick<MacUserLayout, "stateRoot">,
): Promise<QualifiedRollbackReference | null> {
  const path = join(layout.stateRoot, "qualified-rollback.json");
  const info = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 4096 ||
    (info.mode & 0o077) !== 0 ||
    info.nlink !== 1 ||
    info.uid !== process.getuid?.()
  )
    throw new TypeError("Qualified rollback reference is unsafe");
  const value = await readBoundedJson(path, 4096);
  return validateMacQualifiedRollback(value);
}
export async function writeMacQualifiedRollback(
  layout: Pick<MacUserLayout, "stateRoot">,
  value: QualifiedRollbackReference | null,
): Promise<void> {
  const path = join(layout.stateRoot, "qualified-rollback.json");
  if (value === null) {
    await rm(path, { force: true });
    return;
  }
  validateMacQualifiedRollback(value);
  await privateWrite(path, Buffer.from(`${JSON.stringify(value)}\n`));
}
