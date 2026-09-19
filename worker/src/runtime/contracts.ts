import {
  WORKER_RECIPE_IDS,
  WORKER_RECIPE_STEP_IDS,
  type WorkerRecipeId,
  type WorkerRecipeStepId,
} from "../../protocol/v1/protocol.js";

export type { WorkerRecipeId, WorkerRecipeStepId };

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OBJECT_ID = /^[0-9a-f]{24}$/iu;
const SHA256_BASE64 = /^[A-Za-z0-9+/]{43}=$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;

export interface ObjectIdentity {
  key: string;
  versionId: string;
  bytes: number;
  sha256: string;
  contentType: string;
}

export interface WorkerRecipeSnapshot {
  recipeId: WorkerRecipeId;
  recipeRevision: number;
  protocolVersion: 1;
  recipeDigest: string;
  modelFilename: "Kim_Vocal_2.onnx";
  modelDigest: string;
  modelBytes: number;
  preparationProfileId: "pcm16-stereo-44100-v1";
  stepIds: WorkerRecipeStepId[];
  trimEnabled: boolean;
  denoiseEnabled: boolean;
  denoisePresetId: "afftdn-conservative-v1" | null;
  trimProfileId: "trim-vocal-gaps-v1" | null;
  outputFormat: "mp3";
  outputBitrateKbps: 192;
}

export interface SessionResponse {
  machineId: string;
  policyRevision: number;
  serverTime: string;
}

export interface FleetPolicy {
  revision: number;
  acceptClaims: boolean;
  recipes: Array<{
    recipeId: WorkerRecipeId;
    enabled: boolean;
    maxSlotsPerMachine: number;
  }>;
  leaseSeconds: number;
  processingDeadlineSeconds: number;
  maxAttempts: number;
}

export interface ConfigResponse {
  machineId: string;
  machineStatus: "pending" | "active" | "paused" | "draining" | "revoked";
  desiredRevision: number;
  appliedRevision: number;
  claimAllowed: boolean;
  policy: FleetPolicy;
  serverTime: string;
}

export interface Claim {
  attemptId: string;
  jobId: string;
  attemptNumber: number;
  leaseExpiresAt: string;
  deadlineAt: string;
  input: ObjectIdentity;
  recipe: WorkerRecipeSnapshot;
  replayed: boolean;
}

export interface ClaimResponse {
  claim: Claim | null;
  serverTime: string;
}

export type LeaseDisposition = "accepted" | "expired" | "cancelled" | "revoked";

export interface LeaseResult {
  jobId: string;
  attemptId: string;
  disposition: LeaseDisposition;
  leaseExpiresAt: string | null;
}

export interface TransferGrant {
  url: string;
  expiresAt: string;
}

export interface UploadGrant extends TransferGrant {
  method: "PUT";
  headers: Record<string, string>;
}

export interface InputGrantResponse {
  requestId: string;
  attemptId: string;
  object: ObjectIdentity;
  grant: TransferGrant;
}

export interface OutputGrantResponse {
  requestId: string;
  attemptId: string;
  reservation: {
    key: string;
    bytes: number;
    sha256: string;
    contentType: "audio/mpeg";
    measuredDurationSeconds: number;
  };
  grant: UploadGrant | null;
  object: ObjectIdentity | null;
}

export interface ChildProcessResult {
  attemptId: string;
  outputPath: string;
  bytes: number;
  sha256: string;
  contentType: "audio/mpeg";
  measuredOutputDurationSeconds: number;
  recipeId: WorkerRecipeId;
  recipeRevision: number;
  recipeDigest: string;
  modelDigest: string;
  trimEnabled: boolean;
  denoiseEnabled: boolean;
  outputFormat: "mp3";
  outputBitrateKbps: 192;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function text(
  value: unknown,
  label: string,
  pattern?: RegExp,
  maxLength = 4096,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    (pattern && !pattern.test(value))
  )
    throw new TypeError(`${label} is invalid`);
  return value;
}

function integer(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  )
    throw new TypeError(`${label} is invalid`);
  return value as number;
}

function numberValue(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  )
    throw new TypeError(`${label} is invalid`);
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} is invalid`);
  return value;
}

function isoTimestamp(value: unknown, label: string): string {
  const result = text(value, label, undefined, 40);
  if (
    !Number.isFinite(Date.parse(result)) ||
    new Date(result).toISOString() !== result
  )
    throw new TypeError(`${label} is invalid`);
  return result;
}

function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new TypeError(`${label} is invalid`);
  return value as T;
}

function objectIdentity(value: unknown, label: string): ObjectIdentity {
  const item = record(value, label);
  return {
    key: text(item.key, `${label}.key`, undefined, 1024),
    versionId: text(item.versionId, `${label}.versionId`, undefined, 1024),
    bytes: integer(item.bytes, `${label}.bytes`, 1, 1_000_000_000),
    sha256: text(item.sha256, `${label}.sha256`, SHA256_BASE64, 44),
    contentType: text(item.contentType, `${label}.contentType`, undefined, 100),
  };
}

function recipe(value: unknown): WorkerRecipeSnapshot {
  const item = record(value, "recipe");
  if (!Array.isArray(item.stepIds) || item.stepIds.length > 16)
    throw new TypeError("recipe.stepIds is invalid");
  const stepIds = item.stepIds.map((step, index) =>
    oneOf(step, WORKER_RECIPE_STEP_IDS, `recipe.stepIds[${index}]`),
  );
  const denoisePresetId =
    item.denoisePresetId === null
      ? null
      : oneOf(
          item.denoisePresetId,
          ["afftdn-conservative-v1"] as const,
          "recipe.denoisePresetId",
        );
  const trimProfileId =
    item.trimProfileId === null
      ? null
      : oneOf(
          item.trimProfileId,
          ["trim-vocal-gaps-v1"] as const,
          "recipe.trimProfileId",
        );
  return {
    recipeId: oneOf(item.recipeId, WORKER_RECIPE_IDS, "recipe.recipeId"),
    recipeRevision: integer(item.recipeRevision, "recipe.recipeRevision"),
    protocolVersion: integer(
      item.protocolVersion,
      "recipe.protocolVersion",
      1,
      1,
    ) as 1,
    recipeDigest: text(
      item.recipeDigest,
      "recipe.recipeDigest",
      SHA256_HEX,
      64,
    ),
    modelFilename: oneOf(
      item.modelFilename,
      ["Kim_Vocal_2.onnx"] as const,
      "recipe.modelFilename",
    ),
    modelDigest: text(item.modelDigest, "recipe.modelDigest", SHA256_HEX, 64),
    modelBytes: integer(item.modelBytes, "recipe.modelBytes", 1),
    preparationProfileId: oneOf(
      item.preparationProfileId,
      ["pcm16-stereo-44100-v1"] as const,
      "recipe.preparationProfileId",
    ),
    stepIds,
    trimEnabled: booleanValue(item.trimEnabled, "recipe.trimEnabled"),
    denoiseEnabled: booleanValue(item.denoiseEnabled, "recipe.denoiseEnabled"),
    denoisePresetId,
    trimProfileId,
    outputFormat: oneOf(
      item.outputFormat,
      ["mp3"] as const,
      "recipe.outputFormat",
    ),
    outputBitrateKbps: integer(
      item.outputBitrateKbps,
      "recipe.outputBitrateKbps",
      192,
      192,
    ) as 192,
  };
}

function transferGrant(value: unknown): TransferGrant {
  const item = record(value, "grant");
  return {
    url: text(item.url, "grant.url", undefined, 16_384),
    expiresAt: isoTimestamp(item.expiresAt, "grant.expiresAt"),
  };
}

function uploadGrant(value: unknown): UploadGrant {
  const item = record(value, "grant");
  const headers = record(item.headers, "grant.headers");
  if (Object.keys(headers).length > 16)
    throw new TypeError("grant.headers is invalid");
  const parsedHeaders: Record<string, string> = {};
  for (const [name, header] of Object.entries(headers)) {
    parsedHeaders[text(name, "grant header name", undefined, 100)] = text(
      header,
      "grant header value",
      undefined,
      4096,
    );
  }
  return {
    ...transferGrant(item),
    method: oneOf(item.method, ["PUT"] as const, "grant.method"),
    headers: parsedHeaders,
  };
}

export function parseSessionResponse(value: unknown): SessionResponse {
  const item = record(value, "session response");
  return {
    machineId: text(item.machineId, "machineId", UUID_V4, 36),
    policyRevision: integer(item.policyRevision, "policyRevision"),
    serverTime: isoTimestamp(item.serverTime, "serverTime"),
  };
}

export function parseConfigResponse(value: unknown): ConfigResponse {
  const item = record(value, "config response");
  const policy = record(item.policy, "policy");
  if (!Array.isArray(policy.recipes) || policy.recipes.length > 16)
    throw new TypeError("policy.recipes is invalid");
  return {
    machineId: text(item.machineId, "machineId", UUID_V4, 36),
    machineStatus: oneOf(
      item.machineStatus,
      ["pending", "active", "paused", "draining", "revoked"] as const,
      "machineStatus",
    ),
    desiredRevision: integer(item.desiredRevision, "desiredRevision"),
    appliedRevision: integer(item.appliedRevision, "appliedRevision"),
    claimAllowed: booleanValue(item.claimAllowed, "claimAllowed"),
    policy: {
      revision: integer(policy.revision, "policy.revision"),
      acceptClaims: booleanValue(policy.acceptClaims, "policy.acceptClaims"),
      recipes: policy.recipes.map((candidate, index) => {
        const current = record(candidate, `policy.recipes[${index}]`);
        return {
          recipeId: oneOf(
            current.recipeId,
            WORKER_RECIPE_IDS,
            `policy.recipes[${index}].recipeId`,
          ),
          enabled: booleanValue(
            current.enabled,
            `policy.recipes[${index}].enabled`,
          ),
          maxSlotsPerMachine: integer(
            current.maxSlotsPerMachine,
            `policy.recipes[${index}].maxSlotsPerMachine`,
            1,
            16,
          ),
        };
      }),
      leaseSeconds: integer(
        policy.leaseSeconds,
        "policy.leaseSeconds",
        15,
        300,
      ),
      processingDeadlineSeconds: integer(
        policy.processingDeadlineSeconds,
        "policy.processingDeadlineSeconds",
        60,
        7200,
      ),
      maxAttempts: integer(policy.maxAttempts, "policy.maxAttempts", 1, 10),
    },
    serverTime: isoTimestamp(item.serverTime, "serverTime"),
  };
}

export function parseClaimResponse(value: unknown): ClaimResponse {
  const item = record(value, "claim response");
  const serverTime = isoTimestamp(item.serverTime, "serverTime");
  if (item.claim === null) return { claim: null, serverTime };
  const claim = record(item.claim, "claim");
  return {
    serverTime,
    claim: {
      attemptId: text(claim.attemptId, "claim.attemptId", UUID_V4, 36),
      jobId: text(claim.jobId, "claim.jobId", OBJECT_ID, 24),
      attemptNumber: integer(claim.attemptNumber, "claim.attemptNumber", 1, 10),
      leaseExpiresAt: isoTimestamp(
        claim.leaseExpiresAt,
        "claim.leaseExpiresAt",
      ),
      deadlineAt: isoTimestamp(claim.deadlineAt, "claim.deadlineAt"),
      input: objectIdentity(claim.input, "claim.input"),
      recipe: recipe(claim.recipe),
      replayed: booleanValue(claim.replayed, "claim.replayed"),
    },
  };
}

export function parseLeaseResponse(value: unknown): {
  requestId: string;
  serverTime: string;
  results: LeaseResult[];
} {
  const item = record(value, "lease response");
  if (!Array.isArray(item.results) || item.results.length > 16)
    throw new TypeError("lease results are invalid");
  return {
    requestId: text(item.requestId, "requestId", UUID_V4, 36),
    serverTime: isoTimestamp(item.serverTime, "serverTime"),
    results: item.results.map((candidate, index) => {
      const result = record(candidate, `results[${index}]`);
      const disposition = oneOf(
        result.disposition,
        ["accepted", "expired", "cancelled", "revoked"] as const,
        `results[${index}].disposition`,
      );
      return {
        jobId: text(result.jobId, "jobId", OBJECT_ID, 24),
        attemptId: text(result.attemptId, "attemptId", UUID_V4, 36),
        disposition,
        leaseExpiresAt:
          result.leaseExpiresAt === null
            ? null
            : isoTimestamp(result.leaseExpiresAt, "leaseExpiresAt"),
      };
    }),
  };
}

export function parseInputGrantResponse(value: unknown): InputGrantResponse {
  const item = record(value, "input grant response");
  return {
    requestId: text(item.requestId, "requestId", UUID_V4, 36),
    attemptId: text(item.attemptId, "attemptId", UUID_V4, 36),
    object: objectIdentity(item.object, "object"),
    grant: transferGrant(item.grant),
  };
}

export function parseOutputGrantResponse(value: unknown): OutputGrantResponse {
  const item = record(value, "output grant response");
  const reservation = record(item.reservation, "reservation");
  const result: OutputGrantResponse = {
    requestId: text(item.requestId, "requestId", UUID_V4, 36),
    attemptId: text(item.attemptId, "attemptId", UUID_V4, 36),
    reservation: {
      key: text(reservation.key, "reservation.key", undefined, 1024),
      bytes: integer(reservation.bytes, "reservation.bytes", 1, 30_000_000),
      sha256: text(reservation.sha256, "reservation.sha256", SHA256_BASE64, 44),
      contentType: oneOf(
        reservation.contentType,
        ["audio/mpeg"] as const,
        "reservation.contentType",
      ),
      measuredDurationSeconds: numberValue(
        reservation.measuredDurationSeconds,
        "reservation.measuredDurationSeconds",
        0.001,
        1800,
      ),
    },
    grant: item.grant === null ? null : uploadGrant(item.grant),
    object: item.object === null ? null : objectIdentity(item.object, "object"),
  };
  if ((result.grant === null) === (result.object === null))
    throw new TypeError(
      "output grant response must contain one transfer outcome",
    );
  return result;
}

export function parseChildProcessResult(value: unknown): ChildProcessResult {
  const item = record(value, "child result");
  return {
    attemptId: text(item.attemptId, "attemptId", UUID_V4, 36),
    outputPath: text(item.outputPath, "outputPath", undefined, 4096),
    bytes: integer(item.bytes, "bytes", 1, 30_000_000),
    sha256: text(item.sha256, "sha256", SHA256_BASE64, 44),
    contentType: oneOf(
      item.contentType,
      ["audio/mpeg"] as const,
      "contentType",
    ),
    measuredOutputDurationSeconds: numberValue(
      item.measuredOutputDurationSeconds,
      "measuredOutputDurationSeconds",
      0.001,
      1800,
    ),
    recipeId: oneOf(item.recipeId, WORKER_RECIPE_IDS, "recipeId"),
    recipeRevision: integer(item.recipeRevision, "recipeRevision"),
    recipeDigest: text(item.recipeDigest, "recipeDigest", SHA256_HEX, 64),
    modelDigest: text(item.modelDigest, "modelDigest", SHA256_HEX, 64),
    trimEnabled: booleanValue(item.trimEnabled, "trimEnabled"),
    denoiseEnabled: booleanValue(item.denoiseEnabled, "denoiseEnabled"),
    outputFormat: oneOf(item.outputFormat, ["mp3"] as const, "outputFormat"),
    outputBitrateKbps: integer(
      item.outputBitrateKbps,
      "outputBitrateKbps",
      192,
      192,
    ) as 192,
  };
}
