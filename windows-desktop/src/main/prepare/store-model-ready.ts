import { createHash } from "node:crypto";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import {
  WORKER_RECIPE_IDS,
  type WorkerRecipeId,
} from "../../../../worker/protocol/v1/protocol.js";
import { parseQualificationEvidence } from "../../../../worker/src/enrollment/report-builder.js";
import { isCurrentUserSid } from "../../../../worker/src/platform/windows/consumer-native-policy.js";
import { WINDOWS_CONSUMER_PINS } from "../../../../worker/src/platform/windows/consumer-pins.js";
import {
  parseStoreInstalledPackage,
  type StoreInstalledPackage,
} from "../../shared/store-contracts.js";
import { PREPARATION_FIXTURE } from "./fixture.js";
import { PrepareFailure } from "./controller.js";
import type { PrivateFileFingerprint } from "./private-files.js";

export const STORE_MODEL_READY_KEY = "store_model_ready";
/** Observations supplied by a live Store preparation owner. This public type
 * and its receiving parsers do not mint code, role, GPU or Ready authority. */
export interface StorePreparationBinding {
  readonly package: StoreInstalledPackage;
  readonly inventorySha256: string;
  readonly runtimeManifestSha256: string;
  readonly sid: string;
  readonly bootIdentity: string;
  readonly recipeDigests: Readonly<Record<WorkerRecipeId, string>>;
}
export interface StoreModelReadyReceipt {
  readonly version: 1;
  readonly distribution: "microsoft-store";
  readonly target: string;
  readonly packageFullName: string;
  readonly inventorySha256: string;
  readonly runtimeManifestSha256: string;
  readonly sid: string;
  readonly bootIdentity: string;
  readonly modelSha256: string;
  readonly fixtureSha256: string;
  readonly modelFingerprint: PrivateFileFingerprint;
  readonly qualification: unknown;
  readonly qualifiedAt: string;
}
const HASH = /^[a-f0-9]{64}$/u;
function denied(): never {
  throw new PrepareFailure("INTEGRITY_INVALID");
}
function exact(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) denied();
  const prototype = Object.getPrototypeOf(value),
    keys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    denied();
  const descriptors = Object.getOwnPropertyDescriptors(value),
    row: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor?.enumerable || !("value" in descriptor)) denied();
    row[field] = descriptor.value;
  }
  return row;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) denied();
  return value;
}
/** Closed receiving observations only; this parser creates no code authority. */
export function parseStorePreparationBinding(
  input: unknown,
): StorePreparationBinding {
  const row = exact(input, [
    "package",
    "inventorySha256",
    "runtimeManifestSha256",
    "sid",
    "bootIdentity",
    "recipeDigests",
  ]);
  if (typeof row.sid !== "string" || !isCurrentUserSid(row.sid)) denied();
  const recipes = exact(row.recipeDigests, WORKER_RECIPE_IDS);
  return Object.freeze({
    package: parseStoreInstalledPackage("worker", row.package),
    inventorySha256: digest(row.inventorySha256),
    runtimeManifestSha256: digest(row.runtimeManifestSha256),
    sid: row.sid,
    bootIdentity: digest(row.bootIdentity),
    recipeDigests: Object.freeze(
      Object.fromEntries(
        WORKER_RECIPE_IDS.map((id) => [id, digest(recipes[id])]),
      ) as Record<WorkerRecipeId, string>,
    ),
  });
}
export function storePreparationTarget(input: StorePreparationBinding): string {
  const expected = parseStorePreparationBinding(input);
  return createHash("sha256")
    .update(
      JSON.stringify([
        "microsoft-store-model-v1",
        expected.package.fullName,
        expected.inventorySha256,
        expected.runtimeManifestSha256,
        MODEL.sha256,
        PREPARATION_FIXTURE.sha256,
        WORKER_RECIPE_IDS.map((id) => [id, expected.recipeDigests[id]]),
      ]),
    )
    .digest("hex");
}
/** Parse only bounded DPAPI record bytes. A legacy Ready/archive/release proof
 * cannot be relabeled here. A consumer must still revalidate living Store code,
 * the exact held model file, boot/GPU identity and physical owned GPU lease. */
export function parseStoreModelReady(
  bytes: Uint8Array,
  input: StorePreparationBinding,
) {
  try {
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength < 1 ||
      bytes.byteLength > 16384
    )
      denied();
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    if (text.charCodeAt(0) === 0xfeff) denied();
    const row = exact(parseStrictJson(text, 16384, 1024), [
        "version",
        "distribution",
        "target",
        "packageFullName",
        "inventorySha256",
        "runtimeManifestSha256",
        "sid",
        "bootIdentity",
        "modelSha256",
        "fixtureSha256",
        "modelFingerprint",
        "qualification",
        "qualifiedAt",
      ]),
      expected = parseStorePreparationBinding(input);
    if (
      row.version !== 1 ||
      row.distribution !== "microsoft-store" ||
      row.target !== storePreparationTarget(expected) ||
      row.packageFullName !== expected.package.fullName ||
      row.inventorySha256 !== expected.inventorySha256 ||
      row.runtimeManifestSha256 !== expected.runtimeManifestSha256 ||
      row.sid !== expected.sid ||
      row.bootIdentity !== expected.bootIdentity ||
      row.modelSha256 !== MODEL.sha256 ||
      row.fixtureSha256 !== PREPARATION_FIXTURE.sha256 ||
      typeof row.qualifiedAt !== "string" ||
      !Number.isFinite(Date.parse(row.qualifiedAt))
    )
      denied();
    const fingerprint = exact(row.modelFingerprint, [
      "device",
      "fileId",
      "bytes",
      "writtenAt",
      "changedAt",
    ]);
    if (
      fingerprint.bytes !== MODEL.bytes ||
      ["device", "fileId", "writtenAt", "changedAt"].some(
        (key) =>
          typeof fingerprint[key] !== "string" ||
          !/^[0-9]{1,30}$/u.test(fingerprint[key] as string),
      )
    )
      denied();
    // windows-user describes the unchanged no-admin execution profile; Store
    // distribution/code identity is bound separately, never by an archive hash.
    const evidence = parseQualificationEvidence(row.qualification, {
      runtimeProfile: "windows-user",
      expectedUserSid: expected.sid,
      expectedFixtureDigest: PREPARATION_FIXTURE.sha256,
    });
    if (
      evidence.releaseManifestDigest !== expected.runtimeManifestSha256 ||
      evidence.modelDigest !== MODEL.sha256 ||
      evidence.runtimeDiagnostics?.onnxRuntime !==
        WINDOWS_CONSUMER_PINS.onnxRuntime ||
      WORKER_RECIPE_IDS.some(
        (id) => evidence.recipeDigests[id] !== expected.recipeDigests[id],
      )
    )
      denied();
    const receipt = Object.freeze({
      ...row,
      modelFingerprint: Object.freeze({ ...fingerprint }),
    }) as unknown as StoreModelReadyReceipt;
    return { receipt, evidence };
  } catch {
    return denied();
  }
}
