import { loadLocalRuntimeStatus } from "../../runtime/local-runtime-status.js";
import { readOperationalEvents } from "./operational-logs.js";
import type { MacUserLayout } from "./user-paths.js";

const MAX_EVENTS = 10_000;

interface HistoryScope {
  scope: "local-worker-history";
  earliestAvailableAt: string | null;
  incompleteHistory: boolean;
  truncatedByQueryLimit: boolean;
}

export interface JobStage {
  name: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  lastWork: { unit: "windows"; completed: number; total: number } | null;
}

export interface JobAttempt {
  attemptId: string;
  attemptNumber: number | null;
  startedAt: string | null;
  endedAt: string | null;
  state: "active" | "succeeded" | "failed" | "stopped" | "unknown";
  code: string | null;
  stages: JobStage[];
  childRestarts: number;
  modelIncarnation: string | null;
  evidence: Array<{
    at: string;
    kind: string;
    code: string | null;
    sequence: number | null;
  }>;
}

export interface JobInvestigation extends HistoryScope {
  schemaVersion: 1;
  jobId: string;
  foundLocally: boolean;
  attempts: JobAttempt[];
  retryCountObserved: number;
  warning: string | null;
}

export interface ErrorGroup {
  code: string;
  component: string;
  stage: string | null;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  affectedJobs: number;
  recoveryObserved: boolean;
  exampleAttemptId: string | null;
}

export interface ErrorInvestigation extends HistoryScope {
  schemaVersion: 1;
  since: string;
  groups: ErrorGroup[];
  groupLimit: number;
  groupsOmitted: number;
}

interface ErrorDefinition {
  meaning: string;
  likelyCauses: string[];
  nextSteps: string[];
}

const ERROR_CATALOGUE: Record<string, ErrorDefinition> = {
  DOWNLOAD_FAILED: {
    meaning: "The worker could not receive or validate the source media.",
    likelyCauses: [
      "Expired input grant",
      "Network interruption",
      "Input checksum mismatch",
    ],
    nextSteps: ["mw status --local", "mw errors --since 1d", "mw doctor"],
  },
  DECODE_FAILED: {
    meaning: "The media decoder rejected the source audio.",
    likelyCauses: ["Unsupported or damaged media", "Decoder process failure"],
    nextSteps: ["mw job <job-id>", "mw doctor --full"],
  },
  INVALID_AUDIO: {
    meaning: "The input could not be decoded or validated as supported audio.",
    likelyCauses: ["Damaged or unsupported source media", "Decoder rejection"],
    nextSteps: ["mw job <job-id>", "mw doctor --full"],
  },
  INPUT_CHECKSUM_MISMATCH: {
    meaning: "Downloaded input bytes did not match the assigned checksum.",
    likelyCauses: ["Incomplete transfer", "Changed source object"],
    nextSteps: ["mw job <job-id>", "Check the backend input object identity"],
  },
  GPU_OOM: {
    meaning: "The GPU provider reported an out-of-memory failure.",
    likelyCauses: [
      "Insufficient free GPU memory for this model and input",
      "Another GPU workload",
    ],
    nextSteps: ["mw status --local", "mw job <job-id>", "mw doctor --full"],
  },
  OUTPUT_UPLOAD_FAILED: {
    meaning: "The processed output could not be uploaded or validated.",
    likelyCauses: [
      "Expired output grant",
      "Network interruption",
      "Output validation failure",
    ],
    nextSteps: ["mw job <job-id>", "mw errors --since 1d"],
  },
  OUTPUT_INVALID: {
    meaning: "The processed audio failed output validation.",
    likelyCauses: [
      "Invalid encoder output",
      "Unexpected output format or duration",
    ],
    nextSteps: ["mw job <job-id>", "mw doctor --full"],
  },
  SEPARATOR_FAILED: {
    meaning:
      "The vocal separation stage failed without a more specific public failure code.",
    likelyCauses: [
      "Model or provider error",
      "Child interruption",
      "Audio processing error",
    ],
    nextSteps: ["mw job <job-id>", "mw errors --since 1d", "mw doctor --full"],
  },
  TIMEOUT: {
    meaning:
      "A deadline expired; this alone does not identify a GPU memory problem.",
    likelyCauses: ["Slow operation", "Child stall", "Network wait"],
    nextSteps: ["mw job <job-id>", "mw status --local"],
  },
  "completion-uncertain": {
    meaning:
      "The worker could not confirm whether the backend accepted completion.",
    likelyCauses: ["Backend response lost after output publication"],
    nextSteps: [
      "Check the backend job state before any manual retry",
      "mw job <job-id>",
    ],
  },
  "ownership-rejected": {
    meaning: "The backend rejected this worker's attempt ownership.",
    likelyCauses: ["Lease expiry", "Attempt reassigned or cancelled"],
    nextSteps: ["Check the backend job state", "mw job <job-id>"],
  },
  "runtime-stopping": {
    meaning: "The local runtime stopped and the active attempt was cancelled.",
    likelyCauses: ["Operator stop or restart", "Service shutdown"],
    nextSteps: [
      "mw status --local",
      "Check backend job state before manual retry",
    ],
  },
  "authority-window-expired": {
    meaning: "The lease authority window expired during processing.",
    likelyCauses: ["Renewal delay", "Backend connectivity loss"],
    nextSteps: [
      "mw job <job-id>",
      "Check backend job state before manual retry",
    ],
  },
  "child-process-failed": {
    meaning: "The model child exited or failed before a result was returned.",
    likelyCauses: [
      "Child process crash",
      "Provider failure",
      "Resource exhaustion",
    ],
    nextSteps: ["mw job <job-id>", "mw doctor --full"],
  },
  "quota-exhausted": {
    meaning: "The local diagnostic history cannot accept another record.",
    likelyCauses: ["Diagnostic disk quota exhausted"],
    nextSteps: [
      "mw status --local",
      "Check free disk space and diagnostic history size before clearing anything",
    ],
  },
};

export async function investigateJob(
  layout: Pick<MacUserLayout, "workRoot" | "runtimeStatusPath">,
  jobId: string,
  since?: number,
): Promise<JobInvestigation> {
  if (!/^[0-9a-f]{24}$/iu.test(jobId))
    throw new TypeError("Job ID must be 24 hex characters");
  const events = await readOperationalEvents(layout, {
    lines: MAX_EVENTS,
    jobId,
    ...(since === undefined ? {} : { since }),
  });
  const scope = await historyScope(layout, events.length);
  const attempts = new Map<string, JobAttempt>();
  for (const item of events) {
    const event = item.event;
    if (typeof event.attemptId !== "string") continue;
    let attempt = attempts.get(event.attemptId);
    if (!attempt) {
      attempt = {
        attemptId: event.attemptId,
        attemptNumber: null,
        startedAt: null,
        endedAt: null,
        state: "unknown",
        code: null,
        stages: [],
        childRestarts: 0,
        modelIncarnation: null,
        evidence: [],
      };
      attempts.set(event.attemptId, attempt);
    }
    const kind = String(event.kind ?? "diagnostic");
    const at = item.recordedAt;
    if (kind === "attempt-started") {
      attempt.startedAt = at;
      attempt.state = "active";
      if (typeof event.childIncarnation === "string")
        attempt.modelIncarnation = event.childIncarnation;
      if (typeof event.attemptNumber === "number")
        attempt.attemptNumber = event.attemptNumber;
    }
    if (kind === "attempt-progress" && typeof event.stage === "string") {
      const current = attempt.stages.at(-1);
      if (current?.name !== event.stage) {
        if (current && current.endedAt === null) closeStage(current, at);
        attempt.stages.push({
          name: event.stage,
          startedAt: at,
          endedAt: null,
          durationMs: null,
          lastWork: null,
        });
      }
      const work = event.work;
      if (isWork(work)) attempt.stages.at(-1)!.lastWork = work;
    }
    if (kind === "child-restarted") attempt.childRestarts += 1;
    if (
      kind === "attempt-succeeded" ||
      kind === "attempt-failed" ||
      kind === "attempt-stopped"
    ) {
      attempt.endedAt = at;
      attempt.state =
        kind === "attempt-succeeded"
          ? "succeeded"
          : kind === "attempt-failed"
            ? "failed"
            : "stopped";
      attempt.code = typeof event.code === "string" ? event.code : null;
      const current = attempt.stages.at(-1);
      if (current && current.endedAt === null) closeStage(current, at);
    }
    if (kind !== "attempt-progress" || event.work === undefined) {
      attempt.evidence.push({
        at,
        kind,
        code: typeof event.code === "string" ? event.code : null,
        sequence: typeof event.sequence === "number" ? event.sequence : null,
      });
    }
  }
  const result = [...attempts.values()].sort(
    (a, b) =>
      (a.attemptNumber ?? Number.MAX_SAFE_INTEGER) -
        (b.attemptNumber ?? Number.MAX_SAFE_INTEGER) ||
      (a.startedAt ?? "").localeCompare(b.startedAt ?? ""),
  );
  return {
    schemaVersion: 1,
    jobId,
    ...scope,
    foundLocally: result.length > 0,
    attempts: result,
    retryCountObserved: Math.max(0, result.length - 1),
    warning:
      result.length === 0
        ? "No local attempt evidence. The job may be on another worker or outside retained history."
        : scope.incompleteHistory || scope.truncatedByQueryLimit
          ? "Only retained local evidence is shown; earlier attempts may be missing."
          : null,
  };
}

export async function investigateErrors(
  layout: Pick<MacUserLayout, "workRoot" | "runtimeStatusPath">,
  since: number,
  limit = 100,
  jobId?: string,
): Promise<ErrorInvestigation> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new TypeError("Error group limit must be between 1 and 100");
  if (jobId !== undefined && !/^[0-9a-f]{24}$/iu.test(jobId))
    throw new TypeError("Job ID must be 24 hex characters");
  const events = await readOperationalEvents(layout, {
    lines: MAX_EVENTS,
    since,
    ...(jobId === undefined ? {} : { jobId }),
  });
  const scope = await historyScope(layout, events.length);
  const groups = new Map<string, ErrorGroup>();
  for (const item of events) {
    if (item.level !== "error") continue;
    const code =
      typeof item.event.code === "string" ? item.event.code : "UNCLASSIFIED";
    const component =
      typeof item.event.component === "string"
        ? item.event.component
        : "unknown";
    const stage =
      typeof item.event.stage === "string" ? item.event.stage : null;
    const key = JSON.stringify([code, component, stage]);
    let group = groups.get(key);
    if (!group) {
      group = {
        code,
        component,
        stage,
        occurrences: 0,
        firstSeenAt: item.recordedAt,
        lastSeenAt: item.recordedAt,
        affectedJobs: 0,
        recoveryObserved: false,
        exampleAttemptId: null,
      };
      groups.set(key, group);
    }
    group.occurrences += 1;
    if (item.recordedAt < group.firstSeenAt)
      group.firstSeenAt = item.recordedAt;
    if (item.recordedAt > group.lastSeenAt) group.lastSeenAt = item.recordedAt;
    if (typeof item.event.attemptId === "string")
      group.exampleAttemptId = item.event.attemptId;
  }
  const jobsByGroup = new Map<string, Set<string>>();
  const recoveredAttempts = new Set<string>();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index]!;
    if (
      typeof item.event.attemptId === "string" &&
      (item.event.kind === "child-restarted" ||
        item.event.kind === "attempt-succeeded")
    )
      recoveredAttempts.add(item.event.attemptId);
    if (item.level !== "error") continue;
    const code =
      typeof item.event.code === "string" ? item.event.code : "UNCLASSIFIED";
    const component =
      typeof item.event.component === "string"
        ? item.event.component
        : "unknown";
    const stage =
      typeof item.event.stage === "string" ? item.event.stage : null;
    const key = JSON.stringify([code, component, stage]);
    if (typeof item.event.jobId === "string") {
      let jobs = jobsByGroup.get(key);
      if (!jobs) {
        jobs = new Set();
        jobsByGroup.set(key, jobs);
      }
      jobs.add(item.event.jobId);
    }
    const group = groups.get(key)!;
    if (
      typeof item.event.attemptId === "string" &&
      recoveredAttempts.has(item.event.attemptId)
    )
      group.recoveryObserved = true;
  }
  for (const [key, group] of groups)
    group.affectedJobs = jobsByGroup.get(key)?.size ?? 0;
  const sorted = [...groups.values()].sort((a, b) =>
    b.lastSeenAt.localeCompare(a.lastSeenAt),
  );
  return {
    schemaVersion: 1,
    since: new Date(since).toISOString(),
    ...scope,
    groups: sorted.slice(0, limit),
    groupLimit: limit,
    groupsOmitted: Math.max(0, sorted.length - limit),
  };
}

export async function explainError(
  layout: Pick<MacUserLayout, "workRoot" | "runtimeStatusPath">,
  code: string,
  since: number,
): Promise<object> {
  if (!/^[A-Za-z0-9_-]{1,100}$/u.test(code))
    throw new TypeError("Error code is invalid");
  const events = await readOperationalEvents(layout, {
    lines: MAX_EVENTS,
    code,
    since,
  });
  const definition = ERROR_CATALOGUE[code];
  return {
    schemaVersion: 1,
    code,
    ...(await historyScope(layout, events.length)),
    definition: definition?.meaning ?? "No catalogue definition for this code.",
    likelyCauses: definition?.likelyCauses ?? [
      "The local event evidence does not identify a cause.",
    ],
    nextSteps: definition?.nextSteps ?? ["mw errors --since 1d", "mw doctor"],
    observed: events.slice(-10).map((item) => ({
      at: item.recordedAt,
      kind: item.event.kind ?? "diagnostic",
      jobId: item.event.jobId ?? null,
      attemptId: item.event.attemptId ?? null,
      stage: item.event.stage ?? null,
      detail: item.event.detail ?? null,
    })),
    observedCountInRetainedHistory: events.length,
    note: "Likely causes are hypotheses. Recovery actions are not run by this command.",
  };
}

function closeStage(stage: JobStage, at: string): void {
  stage.endedAt = at;
  stage.durationMs = Math.max(0, Date.parse(at) - Date.parse(stage.startedAt));
}

function isWork(value: unknown): value is JobStage["lastWork"] & object {
  if (value === null || typeof value !== "object") return false;
  const work = value as Record<string, unknown>;
  return (
    work.unit === "windows" &&
    typeof work.completed === "number" &&
    typeof work.total === "number"
  );
}

async function historyScope(
  layout: Pick<MacUserLayout, "runtimeStatusPath">,
  eventCount: number,
): Promise<HistoryScope> {
  const status = await loadLocalRuntimeStatus(layout.runtimeStatusPath).catch(
    () => null,
  );
  return {
    scope: "local-worker-history",
    earliestAvailableAt: status?.diagnostics?.earliestAvailableAt ?? null,
    incompleteHistory: status?.diagnostics?.incompleteHistory ?? true,
    truncatedByQueryLimit: eventCount === MAX_EVENTS,
  };
}
