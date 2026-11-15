import { createHash } from "node:crypto";
import { ACCEPTANCE_CASES, type AcceptanceCase } from "./manifest.js";
import {
  parseConsumerGpu,
  type ConsumerGpuIdentity,
} from "../../worker/src/platform/windows/consumer-native-gpu.js";
interface AcceptanceTargetIdentity {
  name: string;
  os: {
    major: 10;
    build: number;
    edition: "workstation";
    nativeArch: "x64";
    processArch: "x64";
  };
  gpu: ConsumerGpuIdentity | null;
  sourceSha256: string;
}
export interface AcceptanceCandidateTarget extends AcceptanceTargetIdentity {
  version: 1;
  package: {
    appVersion: string;
    payloadSha256: string;
    installerSha256: string;
    runtimeRelease: string;
    manifestSha256: string;
    modelSha256: string;
  };
}
export interface AcceptanceNativeTarget extends AcceptanceTargetIdentity {
  version: 2;
  scope: "isolated-native";
}
export type AcceptanceTarget =
  AcceptanceCandidateTarget | AcceptanceNativeTarget;
export type CaseState = "not-run" | "blocked" | "failed" | "passed";
export interface AcceptanceEvidence {
  version: 1;
  caseId: string;
  caseSha256: string;
  targetSha256: string;
  source: "native" | "simulated";
  state: CaseState;
  at: string;
  observation: string;
  artifact: string | null;
  artifactSha256: string | null;
  cleanup: "confirmed" | "unconfirmed" | "not-applicable";
}
export interface AcceptancePlan {
  version: 1;
  mode: "plan";
  target: AcceptanceTarget;
  targetSha256: string;
  cases: Array<{
    definition: AcceptanceCase;
    caseSha256: string;
    disposition:
      | "pending"
      | "authorization-required"
      | "completed-on-exact-target"
      | "candidate-required";
  }>;
  windowsExecuted: false;
}
const HASH = /^[a-f0-9]{64}$/u;
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string") ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (descriptor) => !("value" in descriptor),
    ) ||
    Object.keys(value).sort().join() !== keys.sort().join()
  )
    throw new Error("ACCEPTANCE_INVALID");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, pattern: RegExp): string {
  if (typeof value !== "string" || value.length > max || !pattern.test(value))
    throw new Error("ACCEPTANCE_INVALID");
  return value;
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function parseAcceptanceTarget(value: unknown): AcceptanceTarget {
  const nativeOnly =
      value !== null &&
      typeof value === "object" &&
      Object.getOwnPropertyDescriptor(value, "version")?.value === 2,
    row = exact(value, [
      "version",
      "name",
      "os",
      "gpu",
      "sourceSha256",
      nativeOnly ? "scope" : "package",
    ]),
    os = exact(row.os, [
      "major",
      "build",
      "edition",
      "nativeArch",
      "processArch",
    ]);
  if (
    (nativeOnly ? row.version !== 2 : row.version !== 1) ||
    os.major !== 10 ||
    os.edition !== "workstation" ||
    os.nativeArch !== "x64" ||
    os.processArch !== "x64" ||
    !Number.isSafeInteger(os.build) ||
    (os.build as number) < 19045 ||
    (os.build as number) > 999999
  )
    throw new Error("ACCEPTANCE_UNSUPPORTED_TARGET");
  const identity: AcceptanceTargetIdentity = {
    name: text(row.name, 64, /^[A-Za-z0-9][A-Za-z0-9_-]*$/u),
    os: {
      major: 10,
      build: os.build as number,
      edition: "workstation",
      nativeArch: "x64",
      processArch: "x64",
    },
    gpu: row.gpu === null ? null : parseConsumerGpu(row.gpu),
    sourceSha256: text(row.sourceSha256, 64, HASH),
  };
  if (nativeOnly) {
    if (row.scope !== "isolated-native") throw new Error("ACCEPTANCE_INVALID");
    return { version: 2, scope: "isolated-native", ...identity };
  }
  const app = exact(row.package, [
    "appVersion",
    "payloadSha256",
    "installerSha256",
    "runtimeRelease",
    "manifestSha256",
    "modelSha256",
  ]);
  return {
    version: 1,
    ...identity,
    package: {
      appVersion: text(
        app.appVersion,
        64,
        /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[A-Za-z0-9.-]+)?$/u,
      ),
      payloadSha256: text(app.payloadSha256, 64, HASH),
      installerSha256: text(app.installerSha256, 64, HASH),
      runtimeRelease: text(
        app.runtimeRelease,
        128,
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/u,
      ),
      manifestSha256: text(app.manifestSha256, 64, HASH),
      modelSha256: text(app.modelSha256, 64, HASH),
    },
  };
}
/** This closed action list grants no installed/manual case authority. */
export function isIsolatedNativeAcceptanceCase(
  definition: AcceptanceCase,
): boolean {
  return (
    definition.risk === "isolated-native" &&
    ((definition.id === "native-build" &&
      definition.action === "native-build") ||
      (definition.id === "native-security-fixtures" &&
        definition.action === "native-ctest"))
  );
}
export function caseDigest(definition: AcceptanceCase): string {
  return digest(definition);
}
export function targetDigest(target: AcceptanceTarget): string {
  return digest(parseAcceptanceTarget(target));
}
export function parseAcceptanceEvidence(value: unknown): AcceptanceEvidence {
  const row = exact(value, [
    "version",
    "caseId",
    "caseSha256",
    "targetSha256",
    "source",
    "state",
    "at",
    "observation",
    "artifact",
    "artifactSha256",
    "cleanup",
  ]);
  if (
    row.version !== 1 ||
    typeof row.caseId !== "string" ||
    !ACCEPTANCE_CASES.some((c) => c.id === row.caseId) ||
    typeof row.source !== "string" ||
    !["native", "simulated"].includes(row.source) ||
    typeof row.state !== "string" ||
    !["not-run", "blocked", "failed", "passed"].includes(row.state) ||
    typeof row.cleanup !== "string" ||
    !["confirmed", "unconfirmed", "not-applicable"].includes(row.cleanup) ||
    typeof row.at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/u.test(row.at) ||
    !Number.isFinite(Date.parse(row.at))
  )
    throw new Error("ACCEPTANCE_INVALID");
  if ((row.artifact === null) !== (row.artifactSha256 === null))
    throw new Error("ACCEPTANCE_INVALID");
  const observation = text(row.observation, 2048, /^[\x20-\x7e]*$/u);
  if (
    /(?:https?:\/\/|bearer\s|(?:access|refresh|id)[_ -]?token|(?:private|api)[_ -]?key|authorization\s*[:=]|S-1-\d+(?:-\d+)+|[A-Z]:\\|@)/iu.test(
      observation,
    )
  )
    throw new Error("ACCEPTANCE_PRIVATE_EVIDENCE");
  if (
    row.state === "passed" &&
    (row.source !== "native" ||
      row.cleanup !== "confirmed" ||
      row.artifact === null)
  )
    throw new Error("ACCEPTANCE_UNPROVEN_PASS");
  return {
    version: 1,
    caseId: row.caseId,
    caseSha256: text(row.caseSha256, 64, HASH),
    targetSha256: text(row.targetSha256, 64, HASH),
    source: row.source as AcceptanceEvidence["source"],
    state: row.state as CaseState,
    at: row.at,
    observation,
    artifactSha256:
      row.artifactSha256 === null ? null : text(row.artifactSha256, 64, HASH),
    artifact:
      row.artifact === null
        ? null
        : text(
            row.artifact,
            128,
            /^[A-Za-z0-9][A-Za-z0-9_-]*\.(?:json|txt|png)$/u,
          ),
    cleanup: row.cleanup as AcceptanceEvidence["cleanup"],
  };
}
export function createAcceptancePlan(
  value: unknown,
  ids: readonly string[] = ACCEPTANCE_CASES.map((c) => c.id),
  authorized: readonly string[] = [],
  prior: readonly unknown[] = [],
): AcceptancePlan {
  const target = parseAcceptanceTarget(value),
    targetSha256 = targetDigest(target),
    known = new Set(ACCEPTANCE_CASES.map((c) => c.id));
  if (
    ids.length < 1 ||
    ids.length > 64 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !known.has(id)) ||
    authorized.some((id) => !known.has(id)) ||
    prior.length > 4096
  )
    throw new Error("ACCEPTANCE_UNKNOWN_CASE");
  const previous = prior.map(parseAcceptanceEvidence);
  if (
    target.version === 2 &&
    previous.some(
      (row) =>
        row.state === "passed" &&
        row.targetSha256 === targetSha256 &&
        !isIsolatedNativeAcceptanceCase(
          ACCEPTANCE_CASES.find((definition) => definition.id === row.caseId)!,
        ),
    )
  )
    throw new Error("ACCEPTANCE_CANDIDATE_REQUIRED");
  return {
    version: 1,
    mode: "plan",
    target,
    targetSha256,
    windowsExecuted: false,
    cases: ids.map((id) => {
      const definition = ACCEPTANCE_CASES.find((c) => c.id === id)!,
        caseSha256 = caseDigest(definition);
      const passed = previous.some(
        (row) =>
          row.caseId === id &&
          row.caseSha256 === caseSha256 &&
          row.targetSha256 === targetSha256 &&
          row.source === "native" &&
          row.state === "passed",
      );
      return {
        definition,
        caseSha256,
        disposition:
          target.version === 2 && !isIsolatedNativeAcceptanceCase(definition)
            ? "candidate-required"
            : passed
              ? "completed-on-exact-target"
              : authorized.includes(id)
                ? "pending"
                : "authorization-required",
      };
    }),
  };
}
