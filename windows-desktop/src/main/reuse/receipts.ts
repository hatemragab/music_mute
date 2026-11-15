import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import {
  FULL_TIMELINE_PROFILE_ID,
  FULL_TIMELINE_RECIPE_DIGEST,
} from "../../../../chrome-extension/src/companion/cloud-provider.js";
import type {
  CompletionReceipt,
  ReuseReceipt,
  ReuseSourceIdentity,
} from "../../shared/reuse-contracts.js";
import {
  parsePersonalScope,
  PERSONAL_UUID,
} from "../../shared/personal-contracts.js";
const SHA = /^[a-f0-9]{64}$/;
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("REUSE_RECEIPT_INVALID");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]): void {
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every((k) => Object.hasOwn(value, k))
  )
    throw new Error("REUSE_RECEIPT_INVALID");
}
export function parseReuseSource(value: unknown): ReuseSourceIdentity {
  const r = row(value);
  if (
    typeof r.inputSha256 !== "string" ||
    !SHA.test(r.inputSha256) ||
    !Number.isSafeInteger(r.inputBytes) ||
    Number(r.inputBytes) < 1 ||
    Number(r.inputBytes) > 256 * 1024 ** 2
  )
    throw new Error("REUSE_SOURCE_INVALID");
  if (r.kind === "file") exact(r, ["kind", "inputSha256", "inputBytes"]);
  else if (r.kind === "youtube") {
    exact(r, [
      "kind",
      "videoId",
      "formatId",
      "audioTrackId",
      "audioIsDefault",
      "language",
      "inputSha256",
      "inputBytes",
    ]);
    if (
      typeof r.videoId !== "string" ||
      !/^[A-Za-z0-9_-]{11}$/.test(r.videoId) ||
      typeof r.formatId !== "string" ||
      !/^[A-Za-z0-9_.-]{1,80}$/.test(r.formatId) ||
      !(
        r.audioTrackId === null ||
        (typeof r.audioTrackId === "string" &&
          /^[A-Za-z0-9_.-]{1,128}$/.test(r.audioTrackId))
      ) ||
      !(r.audioIsDefault === null || typeof r.audioIsDefault === "boolean") ||
      !(
        r.language === null ||
        (typeof r.language === "string" &&
          /^[A-Za-z0-9_-]{1,64}$/.test(r.language))
      )
    )
      throw new Error("REUSE_SOURCE_INVALID");
  } else if (r.kind === "community-youtube") {
    exact(r, [
      "kind",
      "videoId",
      "provenance",
      "sourceIdentityVerified",
      "inputSha256",
      "inputBytes",
    ]);
    if (
      typeof r.videoId !== "string" ||
      !/^[A-Za-z0-9_-]{11}$/.test(r.videoId) ||
      !["trusted", "community_contributed"].includes(String(r.provenance)) ||
      typeof r.sourceIdentityVerified !== "boolean"
    )
      throw new Error("REUSE_SOURCE_INVALID");
  } else throw new Error("REUSE_SOURCE_INVALID");
  return structuredClone(r) as unknown as ReuseSourceIdentity;
}
export function parseReuseReceipt(
  value: unknown,
  expected: { originalSha256: string; vocalsSha256: string },
): ReuseReceipt {
  const r = row(value);
  exact(r, [
    "version",
    "profileId",
    "modelDigest",
    "recipeDigest",
    "trimEnabled",
    "denoiseEnabled",
    "source",
    "originalSha256",
    "vocalsSha256",
  ]);
  if (
    r.version !== 1 ||
    r.profileId !== FULL_TIMELINE_PROFILE_ID ||
    r.modelDigest !== MODEL.sha256 ||
    r.recipeDigest !== FULL_TIMELINE_RECIPE_DIGEST ||
    r.trimEnabled !== false ||
    r.denoiseEnabled !== false ||
    r.originalSha256 !== expected.originalSha256 ||
    r.vocalsSha256 !== expected.vocalsSha256 ||
    !SHA.test(expected.originalSha256) ||
    !SHA.test(expected.vocalsSha256)
  )
    throw new Error("REUSE_RECEIPT_INVALID");
  const source = parseReuseSource(r.source);
  return { ...(structuredClone(r) as unknown as ReuseReceipt), source };
}
export function parseCompletionReceipt(
  value: unknown,
  expected: {
    installationId: string;
    jobId: string;
    originalSha256: string;
    vocalsSha256: string;
  },
): CompletionReceipt {
  const r = row(value);
  exact(r, [
    "version",
    "installationId",
    "jobId",
    "ownerId",
    "requestId",
    "capturedAccountScope",
    "originalSha256",
    "vocalsSha256",
    "completedAt",
  ]);
  if (
    r.version !== 1 ||
    r.installationId !== expected.installationId ||
    r.jobId !== expected.jobId ||
    ![r.installationId, r.jobId, r.ownerId, r.requestId].every(
      (v) => typeof v === "string" && PERSONAL_UUID.test(v),
    ) ||
    r.originalSha256 !== expected.originalSha256 ||
    r.vocalsSha256 !== expected.vocalsSha256 ||
    !SHA.test(expected.originalSha256) ||
    !SHA.test(expected.vocalsSha256) ||
    !Number.isSafeInteger(r.completedAt) ||
    Number(r.completedAt) < 0
  )
    throw new Error("COMPLETION_RECEIPT_INVALID");
  const scope = parsePersonalScope(r.capturedAccountScope);
  return {
    ...(structuredClone(r) as unknown as CompletionReceipt),
    capturedAccountScope: scope,
  };
}
export function createReuseReceipt(
  raw: Record<string, unknown>,
  input: {
    bytes: number;
    sha256: string;
    sourceIdentity?: ReuseSourceIdentity;
  },
  originalSha256: string,
  vocalsSha256: string,
): ReuseReceipt | undefined {
  if (
    raw.trimEnabled !== false ||
    raw.denoiseEnabled !== false ||
    raw.recipeId !== "kim-vocals-v2" ||
    raw.recipeRevision !== 6 ||
    raw.recipeDigest !== FULL_TIMELINE_RECIPE_DIGEST ||
    raw.modelDigest !== MODEL.sha256
  )
    return undefined;
  const source = parseReuseSource(
    input.sourceIdentity ?? {
      kind: "file",
      inputSha256: input.sha256,
      inputBytes: input.bytes,
    },
  );
  if (source.inputSha256 !== input.sha256 || source.inputBytes !== input.bytes)
    throw new Error("REUSE_SOURCE_INVALID");
  return parseReuseReceipt(
    {
      version: 1,
      profileId: FULL_TIMELINE_PROFILE_ID,
      modelDigest: MODEL.sha256,
      recipeDigest: FULL_TIMELINE_RECIPE_DIGEST,
      trimEnabled: false,
      denoiseEnabled: false,
      source,
      originalSha256,
      vocalsSha256,
    },
    { originalSha256, vocalsSha256 },
  );
}
