import { randomUUID } from "node:crypto";
import { chmod, lstat, open, readFile, rename } from "node:fs/promises";

export interface LocalRuntimeStatus {
  schemaVersion: 1;
  activeAttemptIds: string[];
  currentAttempts?: Array<{
    workerId: string;
    attemptId: string;
    jobId: string;
  }>;
  childState?: "ready" | "unavailable" | "stopped";
  lastSuccessfulJob?: RuntimeJobSummary;
  lastFailedJob?: RuntimeJobSummary & { code: string };
  updatedAt: string;
}

export interface RuntimeJobSummary {
  jobId: string;
  attemptId: string;
  at: string;
}

export interface LocalRuntimeStatusDetails {
  currentAttempts?: LocalRuntimeStatus["currentAttempts"];
  childState?: LocalRuntimeStatus["childState"];
  lastSuccessfulJob?: RuntimeJobSummary;
  lastFailedJob?: RuntimeJobSummary & { code: string };
}

const ATTEMPT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const JOB_ID = /^[0-9a-f]{24}$/iu;
const WORKER_ID = ATTEMPT_ID;
const SAFE_CODE = /^[A-Z0-9_-]{1,64}$/u;

export async function writeLocalRuntimeStatus(
  path: string,
  activeAttemptIds: readonly string[],
  details: LocalRuntimeStatusDetails = {},
): Promise<LocalRuntimeStatus> {
  if (
    activeAttemptIds.length > 16 ||
    activeAttemptIds.some((value) => !ATTEMPT_ID.test(value)) ||
    new Set(activeAttemptIds).size !== activeAttemptIds.length
  )
    throw new TypeError("Local runtime attempt identities are invalid");
  validateDetails(details, activeAttemptIds);
  const state: LocalRuntimeStatus = {
    schemaVersion: 1,
    activeAttemptIds: [...activeAttemptIds].sort(),
    ...(details.currentAttempts === undefined
      ? {}
      : {
          currentAttempts: [...details.currentAttempts].sort((left, right) =>
            left.workerId.localeCompare(right.workerId),
          ),
        }),
    ...(details.childState === undefined
      ? {}
      : { childState: details.childState }),
    ...(details.lastSuccessfulJob === undefined
      ? {}
      : { lastSuccessfulJob: details.lastSuccessfulJob }),
    ...(details.lastFailedJob === undefined
      ? {}
      : { lastFailedJob: details.lastFailedJob }),
    updatedAt: new Date().toISOString(),
  };
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
  return state;
}

export async function loadLocalRuntimeStatus(
  path: string,
): Promise<LocalRuntimeStatus> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 2 ||
    info.size > 16 * 1024 ||
    (info.mode & 0o077) !== 0
  )
    throw new TypeError("Local runtime status file is unsafe");
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Local runtime status is invalid");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) =>
        ![
          "schemaVersion",
          "activeAttemptIds",
          "currentAttempts",
          "childState",
          "lastSuccessfulJob",
          "lastFailedJob",
          "updatedAt",
        ].includes(key),
    ) ||
    record.schemaVersion !== 1 ||
    !Array.isArray(record.activeAttemptIds) ||
    record.activeAttemptIds.length > 16 ||
    record.activeAttemptIds.some(
      (attempt) => typeof attempt !== "string" || !ATTEMPT_ID.test(attempt),
    ) ||
    new Set(record.activeAttemptIds).size !== record.activeAttemptIds.length ||
    typeof record.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(record.updatedAt))
  )
    throw new TypeError("Local runtime status is invalid");
  const details: LocalRuntimeStatusDetails = {
    ...(record.currentAttempts === undefined
      ? {}
      : { currentAttempts: record.currentAttempts as never }),
    ...(record.childState === undefined
      ? {}
      : { childState: record.childState as never }),
    ...(record.lastSuccessfulJob === undefined
      ? {}
      : { lastSuccessfulJob: record.lastSuccessfulJob as never }),
    ...(record.lastFailedJob === undefined
      ? {}
      : { lastFailedJob: record.lastFailedJob as never }),
  };
  validateDetails(details, record.activeAttemptIds as string[]);
  return {
    schemaVersion: 1,
    activeAttemptIds: record.activeAttemptIds as string[],
    ...(details.currentAttempts === undefined
      ? {}
      : { currentAttempts: details.currentAttempts }),
    ...(details.childState === undefined
      ? {}
      : { childState: details.childState }),
    ...(details.lastSuccessfulJob === undefined
      ? {}
      : { lastSuccessfulJob: details.lastSuccessfulJob }),
    ...(details.lastFailedJob === undefined
      ? {}
      : { lastFailedJob: details.lastFailedJob }),
    updatedAt: record.updatedAt,
  };
}

function validateDetails(
  details: LocalRuntimeStatusDetails,
  activeAttemptIds: readonly string[],
): void {
  if (
    details.childState !== undefined &&
    !["ready", "unavailable", "stopped"].includes(details.childState)
  )
    throw new TypeError("Local runtime child state is invalid");
  if (details.currentAttempts !== undefined) {
    if (
      !Array.isArray(details.currentAttempts) ||
      details.currentAttempts.length > 16 ||
      details.currentAttempts.some(
        (attempt) =>
          attempt === null ||
          typeof attempt !== "object" ||
          !WORKER_ID.test(attempt.workerId) ||
          !ATTEMPT_ID.test(attempt.attemptId) ||
          !JOB_ID.test(attempt.jobId) ||
          !activeAttemptIds.includes(attempt.attemptId),
      ) ||
      new Set(details.currentAttempts.map((attempt) => attempt.workerId))
        .size !== details.currentAttempts.length
    )
      throw new TypeError("Local runtime current attempts are invalid");
  }
  validateJob(details.lastSuccessfulJob, false);
  validateJob(details.lastFailedJob, true);
}

function validateJob(value: unknown, failure: boolean): void {
  if (value === undefined) return;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Local runtime job summary is invalid");
  const record = value as Record<string, unknown>;
  const keys = failure
    ? ["jobId", "attemptId", "at", "code"]
    : ["jobId", "attemptId", "at"];
  if (
    Object.keys(record).some((key) => !keys.includes(key)) ||
    !JOB_ID.test(String(record.jobId)) ||
    !ATTEMPT_ID.test(String(record.attemptId)) ||
    typeof record.at !== "string" ||
    !Number.isFinite(Date.parse(record.at)) ||
    (failure &&
      (typeof record.code !== "string" || !SAFE_CODE.test(record.code)))
  )
    throw new TypeError("Local runtime job summary is invalid");
}
