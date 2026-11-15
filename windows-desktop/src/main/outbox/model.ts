import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import { FULL_TIMELINE_RECIPE_DIGEST } from "../../../../chrome-extension/src/companion/cloud-provider.js";
import type { LocalLibraryEntry } from "../library/model.js";
import type { AccountSessionScope } from "../account/account-controller.js";
export const OUTBOX_MAX_RECORDS = 256;
export const OUTBOX_MAX_RECORD_BYTES = 16384;
export const OUTBOX_ORIGINAL_BUDGET = 256 * 1024 ** 2;
export const OUTBOX_VOCALS_BUDGET = 256 * 1024 ** 2;
export const OUTBOX_PROFILE = "kim-vocal-2-full-timeline-v1";
export const OUTBOX_UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const TYPES: Record<string, string> = {
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  webm: "audio/webm",
  mp3: "audio/mpeg",
  opus: "audio/ogg",
  ogg: "audio/ogg",
  aac: "audio/aac",
  wav: "audio/wav",
  flac: "audio/flac",
};
export interface OutboxArtifact {
  relativePath: string;
  sourceRelativePath: string;
  artifactId: string;
  extension: string;
  contentType: string;
  bytes: number;
  sha256: string;
  durationSeconds: number;
}
export interface OutboxRecord {
  version: 1;
  kind: "pair" | "community-link";
  installationId: string;
  ownerUid: string;
  ownerGeneration: string;
  requestId: string;
  cacheKey: string;
  personalJobId: string;
  title: string;
  videoId: string | null;
  modelDigest: string;
  recipeDigest: string;
  original: OutboxArtifact | null;
  vocals: OutboxArtifact;
  state:
    | "capturing"
    | "pending"
    | "saving"
    | "retry"
    | "blocked"
    | "committed"
    | "discarded";
  revision: number;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  attemptId: string | null;
  attemptGeneration: string | null;
  nextAttemptAt: number | null;
  errorCode: string | null;
  syncId: string | null;
  jobId: string | null;
  grantRequestId: string | null;
  linked: boolean;
  copiesReleased: boolean;
  captured: boolean;
}
export function outboxOwner(uid: string): string {
  if (!/^[^\p{Cc}\p{Cf}]{1,128}$/u.test(uid))
    throw new Error("OUTBOX_OWNER_INVALID");
  return createHash("sha256").update(uid).digest("hex");
}
export function outboxRoot(
  record: Pick<OutboxRecord, "ownerUid" | "requestId">,
): string {
  if (!OUTBOX_UUID.test(record.requestId))
    throw new Error("OUTBOX_RECORD_INVALID");
  return `outbox\\${outboxOwner(record.ownerUid)}\\${record.requestId.toLowerCase()}`;
}
export function parseOutboxRecord(
  value: unknown,
  installationId: string,
): OutboxRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("OUTBOX_RECORD_INVALID");
  const r = value as OutboxRecord;
  const keys = [
    "version",
    "kind",
    "installationId",
    "ownerUid",
    "ownerGeneration",
    "requestId",
    "cacheKey",
    "personalJobId",
    "title",
    "videoId",
    "modelDigest",
    "recipeDigest",
    "original",
    "vocals",
    "state",
    "revision",
    "createdAt",
    "updatedAt",
    "attempts",
    "attemptId",
    "attemptGeneration",
    "nextAttemptAt",
    "errorCode",
    "syncId",
    "jobId",
    "grantRequestId",
    "linked",
    "copiesReleased",
    "captured",
  ];
  if (
    Object.keys(r).length !== keys.length ||
    !keys.every((k) => Object.hasOwn(r, k)) ||
    r.version !== 1 ||
    !["pair", "community-link"].includes(r.kind) ||
    r.installationId !== installationId ||
    !OUTBOX_UUID.test(installationId) ||
    !OUTBOX_UUID.test(r.ownerGeneration) ||
    !OUTBOX_UUID.test(r.requestId) ||
    r.requestId !== r.requestId.toLowerCase() ||
    !OUTBOX_UUID.test(r.personalJobId) ||
    !SHA.test(r.cacheKey) ||
    r.modelDigest !== MODEL.sha256 ||
    r.recipeDigest !== FULL_TIMELINE_RECIPE_DIGEST ||
    typeof r.title !== "string" ||
    r.title.length > 200 ||
    /[\p{Cc}\p{Cf}]/u.test(r.title) ||
    !(r.videoId === null || /^[A-Za-z0-9_-]{11}$/.test(r.videoId)) ||
    (r.kind === "community-link" && r.videoId === null) ||
    ![
      "capturing",
      "pending",
      "saving",
      "retry",
      "blocked",
      "committed",
      "discarded",
    ].includes(r.state) ||
    ![r.revision, r.createdAt, r.updatedAt, r.attempts].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    r.updatedAt < r.createdAt ||
    !(r.attemptId === null || OUTBOX_UUID.test(r.attemptId)) ||
    !(r.attemptGeneration === null || OUTBOX_UUID.test(r.attemptGeneration)) ||
    (r.attemptId === null) !== (r.attemptGeneration === null) ||
    !(
      r.nextAttemptAt === null ||
      (Number.isSafeInteger(r.nextAttemptAt) && r.nextAttemptAt >= 0)
    ) ||
    !(r.errorCode === null || /^[A-Z][A-Z0-9_]{2,63}$/.test(r.errorCode)) ||
    !(r.syncId === null || /^[a-f0-9]{24}$/.test(r.syncId)) ||
    !(r.jobId === null || /^[a-f0-9]{24}$/.test(r.jobId)) ||
    !(r.grantRequestId === null || OUTBOX_UUID.test(r.grantRequestId)) ||
    typeof r.linked !== "boolean" ||
    typeof r.copiesReleased !== "boolean" ||
    typeof r.captured !== "boolean" ||
    (["pending", "committed"].includes(r.state) && !r.captured) ||
    (r.copiesReleased && !["committed", "discarded"].includes(r.state)) ||
    (r.state === "saving" && r.attemptId === null) ||
    (r.state === "committed" && r.jobId === null) ||
    (r.state === "committed" && r.kind === "pair" && r.syncId === null) ||
    (r.linked && r.state !== "committed") ||
    (r.kind === "pair" && !r.original) ||
    (r.kind === "community-link" && r.original !== null)
  )
    throw new Error("OUTBOX_RECORD_INVALID");
  outboxOwner(r.ownerUid);
  const root = outboxRoot(r);
  for (const [role, artifact] of [
    ["original", r.original],
    ["vocals", r.vocals],
  ] as const) {
    if (!artifact) {
      if (role === "vocals") throw new Error("OUTBOX_RECORD_INVALID");
      continue;
    }
    if (
      Object.keys(artifact).sort().join() !==
        "artifactId,bytes,contentType,durationSeconds,extension,relativePath,sha256,sourceRelativePath" ||
      !OUTBOX_UUID.test(artifact.artifactId) ||
      !Object.hasOwn(TYPES, artifact.extension) ||
      TYPES[artifact.extension] !== artifact.contentType ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 1 ||
      artifact.bytes > 100000000 ||
      !SHA.test(artifact.sha256) ||
      !Number.isFinite(artifact.durationSeconds) ||
      artifact.durationSeconds <= 0 ||
      artifact.durationSeconds > 1200 ||
      artifact.relativePath !== `${root}\\${role}.${artifact.extension}` ||
      artifact.sourceRelativePath !==
        `personal\\results\\${r.personalJobId}\\${role}.${artifact.extension}` ||
      (role === "vocals" &&
        (artifact.extension !== "mp3" || artifact.contentType !== "audio/mpeg"))
    )
      throw new Error("OUTBOX_ARTIFACT_INVALID");
  }
  if (
    r.original &&
    Math.abs(r.original.durationSeconds - r.vocals.durationSeconds) > 0.25
  )
    throw new Error("TIMELINE_INCOMPATIBLE");
  if (Buffer.byteLength(JSON.stringify(r)) > OUTBOX_MAX_RECORD_BYTES)
    throw new Error("OUTBOX_RECORD_INVALID");
  return structuredClone(r);
}
export function stageOutbox(
  entry: LocalLibraryEntry,
  scope: AccountSessionScope,
  installationId: string,
  requestId: string,
  kind: OutboxRecord["kind"],
  now: number,
): OutboxRecord {
  if (
    !OUTBOX_UUID.test(scope.generation) ||
    !OUTBOX_UUID.test(entry.personalJobId) ||
    !SHA.test(entry.catalog.cache_key) ||
    entry.catalog.trim_enabled !== false
  )
    throw new Error("OUTBOX_PROFILE_UNSUPPORTED");
  const base = { ownerUid: scope.firebaseUid, requestId },
    root = outboxRoot(base);
  const artifact = (role: "original" | "vocals"): OutboxArtifact => {
    const item = entry[role],
      mime = item.contentType,
      extension =
        role === "vocals"
          ? "mp3"
          : mime === "audio/mp4"
            ? "m4a"
            : Object.entries(TYPES).find(([, type]) => type === mime)?.[0];
    if (!extension) throw new Error("OUTBOX_PROFILE_UNSUPPORTED");
    return {
      artifactId: item.id,
      extension,
      contentType: mime,
      bytes: item.bytes,
      sha256: item.sha256,
      durationSeconds: item.durationSeconds,
      relativePath: `${root}\\${role}.${extension}`,
      sourceRelativePath: `personal\\results\\${entry.personalJobId}\\${role}.${extension}`,
    };
  };
  return parseOutboxRecord(
    {
      version: 1,
      kind,
      installationId,
      ownerUid: scope.firebaseUid,
      ownerGeneration: scope.generation,
      requestId,
      cacheKey: entry.catalog.cache_key,
      personalJobId: entry.personalJobId,
      title: (entry.catalog.source_title ?? "")
        .replace(/[\p{Cc}\p{Cf}]/gu, " ")
        .slice(0, 200),
      videoId: entry.catalog.video_id ?? null,
      modelDigest: MODEL.sha256,
      recipeDigest: FULL_TIMELINE_RECIPE_DIGEST,
      original: kind === "pair" ? artifact("original") : null,
      vocals: artifact("vocals"),
      state: "capturing",
      revision: 0,
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      attemptId: null,
      attemptGeneration: null,
      nextAttemptAt: null,
      errorCode: null,
      syncId: null,
      jobId: null,
      grantRequestId: null,
      linked: false,
      copiesReleased: false,
      captured: false,
    },
    installationId,
  );
}
export function artifactDeclaration(a: OutboxArtifact) {
  return {
    extension: a.extension,
    content_type: a.contentType,
    bytes: a.bytes,
    duration_seconds: a.durationSeconds,
    sha256: Buffer.from(a.sha256, "hex").toString("base64"),
  };
}
export function outboxRelativePath(value: string): void {
  if (
    !/^outbox\\[a-f0-9]{64}\\[a-f0-9-]{36}\\(?:record\.json|(?:original|vocals)\.(?:m4a|mp4|webm|mp3|opus|ogg|aac|wav|flac)(?:\.[a-f0-9-]{36}\.part)?)$/.test(
      value,
    ) ||
    win32.normalize(value) !== value
  )
    throw new Error("OUTBOX_ARTIFACT_INVALID");
}
