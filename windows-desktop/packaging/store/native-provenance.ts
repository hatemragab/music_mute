import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { packageFile } from "../validate-assets.js";
import { parseStrictJson } from "../../../chrome-extension/src/shared/strict-json.js";
import { auditWindowsX64Binary } from "../../../worker/src/platform/windows/pe-audit.js";
import { ACCEPTANCE_CASES } from "../../acceptance/manifest.js";
import { nativeAcceptanceSourceDigest } from "../../acceptance/native-run.js";
import {
  caseDigest,
  parseAcceptanceEvidence,
  parseAcceptanceTarget,
  targetDigest,
} from "../../acceptance/plan.js";
import { safeStoreRelativePath } from "./inventory.js";
import type { StoreProductRole } from "../../src/shared/store-contracts.js";

const require = createRequire(import.meta.url);
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export const STORE_NATIVE_ROLE_FILES = Object.freeze({
  gui: Object.freeze([
    "MusicMuteChromeHost.exe",
    "MusicMuteSession.exe",
    "musicmute-native.exe",
  ] as const),
  worker: Object.freeze([
    "MusicMuteWorker.exe",
    "MusicMuteSession.exe",
    "musicmute-native.exe",
  ] as const),
});
export interface StoreNativeFilePin {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
export interface StoreNativeBuildInputs {
  readonly directory: string;
  readonly sourceSha256: string;
  readonly observation: StoreNativeFilePin;
  readonly evidenceLedger: StoreNativeFilePin;
  readonly executables: readonly StoreNativeFilePin[];
}
function invalid(code = "STORE_NATIVE_INPUT_INVALID"): never {
  throw new Error(code);
}
function exact(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value),
    names = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    names.length !== fields.length ||
    names.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    invalid();
  const row: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
    row[field] = descriptor.value;
  }
  return row;
}
function path(value: unknown) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value === dirname(value) ||
    value.length > 4096 ||
    /[\p{Cc}\p{Cf};"$<>|*?]/u.test(value)
  )
    invalid();
  return value;
}
function pin(
  value: unknown,
  maximum: number,
  relativePath = false,
): StoreNativeFilePin {
  const row = exact(value, ["path", "bytes", "sha256"]);
  const name = relativePath ? safeStoreRelativePath(row.path) : path(row.path);
  if (
    !Number.isSafeInteger(row.bytes) ||
    (row.bytes as number) < 1 ||
    (row.bytes as number) > maximum ||
    typeof row.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.sha256)
  )
    invalid();
  return Object.freeze({
    path: name,
    bytes: row.bytes as number,
    sha256: row.sha256,
  });
}
/** The caller supplies an expected known role; payload fields cannot invent roles or executable authority. */
export function parseStoreNativeBuildInputs(
  value: unknown,
  role: StoreProductRole,
): StoreNativeBuildInputs {
  if (role !== "gui" && role !== "worker") invalid();
  const native = exact(value, [
    "directory",
    "sourceSha256",
    "observation",
    "evidenceLedger",
    "executables",
  ]);
  const directory = path(native.directory),
    names = STORE_NATIVE_ROLE_FILES[role];
  if (
    typeof native.sourceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(native.sourceSha256) ||
    !Array.isArray(native.executables) ||
    native.executables.length !== names.length
  )
    invalid();
  const executables = native.executables.map((value) =>
    pin(value, 16 * 1024 ** 2, true),
  );
  if (
    JSON.stringify(executables.map((row) => row.path)) !== JSON.stringify(names)
  )
    invalid();
  const observation = pin(native.observation, 8 * 1024 ** 2),
    ledger = pin(native.evidenceLedger, 65536),
    root = dirname(observation.path);
  const folded = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  if (
    basename(observation.path) !== "native-observation.json" ||
    ledger.path !== join(root, "evidence-ledger.json") ||
    (folded(directory) !== folded(root) &&
      !folded(directory).startsWith(folded(root) + sep))
  )
    invalid();
  return Object.freeze({
    directory,
    sourceSha256: native.sourceSha256,
    observation,
    evidenceLedger: ledger,
    executables: Object.freeze(executables),
  });
}
async function physical(value: string, directory: boolean) {
  const resolved = await realpath(value);
  if (resolved !== value) invalid();
  for (let candidate = value; ; candidate = dirname(candidate)) {
    const info = await lstat(candidate);
    if (
      info.isSymbolicLink() ||
      ((candidate !== value || directory) && !info.isDirectory())
    )
      invalid();
    if (candidate === dirname(candidate)) break;
  }
}
async function readPin(value: StoreNativeFilePin, maximum: number) {
  await physical(value.path, false);
  const bytes = await packageFile(value.path, maximum);
  if (bytes.length !== value.bytes || digest(bytes) !== value.sha256)
    invalid("STORE_NATIVE_INPUT_CHANGED");
  return bytes;
}
function json(bytes: Uint8Array, maximum: number) {
  return parseStrictJson(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    maximum,
    16384,
  );
}
export async function verifyStoreNativeProvenance(
  inputsValue: unknown,
  role: StoreProductRole,
  componentRootValue: string,
) {
  const inputs = parseStoreNativeBuildInputs(inputsValue, role),
    componentRoot = path(componentRootValue);
  await physical(inputs.directory, true);
  const observationBytes = await readPin(inputs.observation, 8 * 1024 ** 2);
  const observed = exact(json(observationBytes, 8 * 1024 ** 2), [
    "version",
    "target",
    "logs",
    "failedToolDiagnostics",
    "installedAppActionsExecuted",
  ]);
  const target = parseAcceptanceTarget(observed.target);
  if (
    observed.version !== 1 ||
    target.version !== 2 ||
    target.sourceSha256 !== inputs.sourceSha256 ||
    observed.installedAppActionsExecuted !== false ||
    !Array.isArray(observed.failedToolDiagnostics) ||
    observed.failedToolDiagnostics.length ||
    !Array.isArray(observed.logs) ||
    observed.logs.length !== 4 ||
    (await nativeAcceptanceSourceDigest(resolve(componentRoot, ".."))) !==
      inputs.sourceSha256
  )
    invalid("STORE_NATIVE_PROVENANCE_INVALID");
  const steps = observed.logs.map((value) => {
    const row = exact(value, [
      "step",
      "exitCode",
      "toolExitCode",
      "terminationReason",
      "bytes",
      "sha256",
      "sanitizedOutput",
    ]);
    if (
      row.exitCode !== 0 ||
      row.toolExitCode !== 0 ||
      row.terminationReason !== "completed" ||
      !Number.isSafeInteger(row.bytes) ||
      (row.bytes as number) < 0 ||
      typeof row.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(row.sha256) ||
      typeof row.sanitizedOutput !== "string" ||
      row.sanitizedOutput.length > 65536
    )
      invalid("STORE_NATIVE_PROVENANCE_INVALID");
    return row.step;
  });
  if (
    JSON.stringify(steps) !==
    JSON.stringify(["configure", "compile", "describe", "ctest"])
  )
    invalid("STORE_NATIVE_PROVENANCE_INVALID");
  const ledgerBytes = await readPin(inputs.evidenceLedger, 65536),
    rows = json(ledgerBytes, 65536);
  if (!Array.isArray(rows) || rows.length !== 2)
    invalid("STORE_NATIVE_PROVENANCE_INVALID");
  const evidence = rows.map(parseAcceptanceEvidence);
  for (const id of ["native-build", "native-security-fixtures"]) {
    const record = evidence.filter((row) => row.caseId === id),
      definition = ACCEPTANCE_CASES.find((row) => row.id === id)!;
    if (
      record.length !== 1 ||
      record[0]!.state !== "passed" ||
      record[0]!.source !== "native" ||
      record[0]!.cleanup !== "confirmed" ||
      record[0]!.artifact !== "native-observation.json" ||
      record[0]!.artifactSha256 !== digest(observationBytes) ||
      record[0]!.targetSha256 !== targetDigest(target) ||
      record[0]!.caseSha256 !== caseDigest(definition)
    )
      invalid("STORE_NATIVE_PROVENANCE_INVALID");
  }
  for (const executable of inputs.executables) {
    const absolute = {
      ...executable,
      path: join(inputs.directory, executable.path),
    };
    const bytes = await readPin(absolute, 16 * 1024 ** 2);
    await auditWindowsX64Binary(absolute.path);
    const { NtExecutable, NtExecutableResource } =
      require("resedit") as typeof import("resedit");
    const resources = NtExecutableResource.from(NtExecutable.from(bytes));
    const manifests = resources.entries.filter(
      (entry) => entry.type === 24 && entry.id === 1,
    );
    if (manifests.length !== 1) invalid("STORE_NATIVE_MANIFEST_INVALID");
    const manifest = new TextDecoder("utf-8", { fatal: true }).decode(
      manifests[0]!.bin,
    );
    const levels = [
      ...manifest.matchAll(/<requestedExecutionLevel\s+([^>]+)\/?\s*>/gu),
    ];
    if (
      /<!DOCTYPE|<!ENTITY/iu.test(manifest) ||
      levels.length !== 1 ||
      !/\blevel=["']asInvoker["']/u.test(levels[0]![1]!) ||
      !/\buiAccess=["']false["']/u.test(levels[0]![1]!) ||
      (levels[0]![1]!.match(/\blevel\s*=/gu)?.length ?? 0) !== 1 ||
      (levels[0]![1]!.match(/\buiAccess\s*=/gu)?.length ?? 0) !== 1
    )
      invalid("STORE_NATIVE_MANIFEST_INVALID");
    await readPin(absolute, 16 * 1024 ** 2);
  }
  return Object.freeze({
    sourceSha256: inputs.sourceSha256,
    targetSha256: targetDigest(target),
    observationSha256: digest(observationBytes),
    evidenceLedgerSha256: digest(ledgerBytes),
    nativeCompilationAndIsolatedFixtures: "passed",
    installedStoreExecution: false,
    gpuQualification: false,
  });
}
