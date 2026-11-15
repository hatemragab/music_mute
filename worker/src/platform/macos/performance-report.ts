import { loadLocalRuntimeStatus } from "../../runtime/local-runtime-status.js";
import {
  readOperationalEvents,
  type OperationalEvent,
} from "./operational-logs.js";
import type { MacUserLayout } from "./user-paths.js";

const MAX_EVENTS = 10_000;
const REPORTED_STAGES = [
  "download",
  "separation",
  "upload",
  "completionAck",
] as const;

function expectedStages(recipeId: string | null): string[] {
  return recipeId === "kim-vocals-v2-trim"
    ? [...REPORTED_STAGES, "trim", "encode"]
    : [...REPORTED_STAGES];
}

export interface PerformanceSample {
  jobId: string;
  attemptId: string;
  attemptNumber: number | null;
  state: "succeeded" | "failed" | "stopped" | "active" | "unknown";
  code: string | null;
  startedAt: string | null;
  endedAt: string | null;
  observedWallMs: number | null;
  provider: string | null;
  gpuId: string | null;
  runtimeIncarnation: string | null;
  recipeId: string | null;
  recipeDigest: string | null;
  modelDigest: string | null;
  outputBitrateKbps: number | null;
  groupSize: number | null;
  modelLoadState: string | null;
  decodedInputDurationSeconds: number | null;
  outputBytes: number | null;
  stageMs: Record<string, number>;
  separationRtf: number | null;
  dominantMeasuredStage: string | null;
  missingStages: string[];
}

export interface PerformanceCohort {
  key: string;
  recipeId: string;
  provider: string;
  gpuId: string;
  runtimeIncarnation: string;
  modelDigest: string;
  recipeDigest: string;
  outputBitrateKbps: number;
  groupSize: number;
  modelLoadState: string;
  durationBucketSeconds: number;
  sampleCount: number;
  decodedDurationRangeSeconds: [number, number];
  stageMs: Record<
    string,
    { count: number; median: number; min: number; max: number }
  >;
  separationRtf: {
    count: number;
    median: number;
    min: number;
    max: number;
  } | null;
}

export interface PerformanceReport {
  schemaVersion: 1;
  scope: "local-worker-history";
  units: {
    duration: "ms";
    decodedAudio: "s";
    outputSize: "bytes";
    separationRtf: "ratio";
  };
  since: string | null;
  jobId: string | null;
  recipeId: string | null;
  last: number;
  availableAttempts: number;
  selectedAttempts: number;
  states: {
    succeeded: number;
    failed: number;
    stopped: number;
    active: number;
    unknown: number;
    retried: number;
  };
  samples: PerformanceSample[];
  cohorts: PerformanceCohort[];
  ungroupedSuccesses: number;
  incompleteHistory: boolean;
  truncatedByQueryLimit: boolean;
  missingCoverage: string[];
  note: string;
}

export interface PerformanceQuery {
  last?: number;
  since?: number;
  recipeId?: string;
  jobId?: string;
}

export async function queryPerformanceReport(
  layout: Pick<MacUserLayout, "workRoot" | "runtimeStatusPath">,
  query: PerformanceQuery = {},
): Promise<PerformanceReport> {
  const last = query.last ?? 20;
  if (!Number.isSafeInteger(last) || last < 1 || last > 100)
    throw new TypeError("Performance count must be between 1 and 100");
  if (
    query.recipeId !== undefined &&
    !/^[a-z0-9-]{1,64}$/u.test(query.recipeId)
  )
    throw new TypeError("Performance recipe ID is invalid");
  if (query.jobId !== undefined && !/^[0-9a-f]{24}$/iu.test(query.jobId))
    throw new TypeError("Performance job ID is invalid");
  const events = await readOperationalEvents(layout, {
    lines: MAX_EVENTS,
    ...(query.since === undefined ? {} : { since: query.since }),
    ...(query.jobId === undefined ? {} : { jobId: query.jobId }),
  });
  const status = await loadLocalRuntimeStatus(layout.runtimeStatusPath).catch(
    () => null,
  );
  return buildPerformanceReport(events, {
    ...query,
    last,
    incompleteHistory: status?.diagnostics?.incompleteHistory ?? true,
    truncatedByQueryLimit: events.length === MAX_EVENTS,
  });
}

export function buildPerformanceReport(
  events: readonly OperationalEvent[],
  options: PerformanceQuery & {
    last: number;
    incompleteHistory: boolean;
    truncatedByQueryLimit: boolean;
  },
): PerformanceReport {
  const attempts = new Map<string, PerformanceSample>();
  for (const entry of events) {
    const event = entry.event;
    if (typeof event.attemptId !== "string" || typeof event.jobId !== "string")
      continue;
    let sample = attempts.get(event.attemptId);
    if (!sample) {
      sample = {
        jobId: event.jobId,
        attemptId: event.attemptId,
        attemptNumber: null,
        state: "unknown",
        code: null,
        startedAt: null,
        endedAt: null,
        observedWallMs: null,
        provider: null,
        gpuId: null,
        runtimeIncarnation: null,
        recipeId: null,
        recipeDigest: null,
        modelDigest: null,
        outputBitrateKbps: null,
        groupSize: null,
        modelLoadState: null,
        decodedInputDurationSeconds: null,
        outputBytes: null,
        stageMs: {},
        separationRtf: null,
        dominantMeasuredStage: null,
        missingStages: [...REPORTED_STAGES],
      };
      attempts.set(event.attemptId, sample);
    }
    if (event.kind === "attempt-started") {
      sample.state = "active";
      sample.startedAt = entry.recordedAt;
      sample.attemptNumber = numberOrNull(event.attemptNumber);
      sample.provider = stringOrNull(event.provider);
      sample.gpuId = stringOrNull(event.gpuId);
      sample.runtimeIncarnation = stringOrNull(event.incarnation);
      sample.recipeId = stringOrNull(event.recipeId);
      sample.missingStages = expectedStages(sample.recipeId);
      sample.recipeDigest = stringOrNull(event.recipeDigest);
      sample.modelDigest = stringOrNull(event.modelDigest);
      sample.outputBitrateKbps = numberOrNull(event.outputBitrateKbps);
      sample.groupSize = numberOrNull(event.groupSize);
      sample.modelLoadState = stringOrNull(event.modelLoadState);
    }
    if (
      event.kind === "attempt-succeeded" ||
      event.kind === "attempt-failed" ||
      event.kind === "attempt-stopped"
    ) {
      sample.state =
        event.kind === "attempt-succeeded"
          ? "succeeded"
          : event.kind === "attempt-failed"
            ? "failed"
            : "stopped";
      sample.endedAt = entry.recordedAt;
      sample.code = stringOrNull(event.code);
      if (sample.startedAt)
        sample.observedWallMs = Math.max(
          0,
          Date.parse(entry.recordedAt) - Date.parse(sample.startedAt),
        );
    }
    if (event.kind === "attempt-succeeded") {
      sample.outputBitrateKbps =
        numberOrNull(event.outputBitrateKbps) ?? sample.outputBitrateKbps;
      sample.decodedInputDurationSeconds = numberOrNull(
        event.measuredInputDurationSeconds,
      );
      sample.outputBytes = numberOrNull(event.outputBytes);
      if (Array.isArray(event.stageTimings))
        for (const item of event.stageTimings) {
          if (item && typeof item === "object" && !Array.isArray(item)) {
            const timing = item as Record<string, unknown>;
            if (
              typeof timing.stage === "string" &&
              typeof timing.durationMs === "number" &&
              Number.isFinite(timing.durationMs) &&
              timing.durationMs >= 0
            )
              sample.stageMs[timing.stage] = timing.durationMs;
          }
        }
      sample.missingStages = expectedStages(sample.recipeId).filter(
        (stage) => sample.stageMs[stage] === undefined,
      );
      const measured = Object.entries(sample.stageMs).filter(([, duration]) =>
        Number.isFinite(duration),
      );
      sample.dominantMeasuredStage =
        measured.sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const separation = sample.stageMs.separation;
      if (separation !== undefined && sample.decodedInputDurationSeconds)
        sample.separationRtf =
          separation / (sample.decodedInputDurationSeconds * 1000);
    }
  }
  const all = [...attempts.values()]
    .filter(
      (sample) =>
        options.recipeId === undefined || sample.recipeId === options.recipeId,
    )
    .sort((a, b) =>
      (b.endedAt ?? b.startedAt ?? "").localeCompare(
        a.endedAt ?? a.startedAt ?? "",
      ),
    );
  const selected = all.slice(0, options.last);
  const states = {
    succeeded: 0,
    failed: 0,
    stopped: 0,
    active: 0,
    unknown: 0,
    retried: 0,
  };
  for (const sample of selected) {
    states[sample.state] += 1;
    if (sample.attemptNumber !== null && sample.attemptNumber > 1)
      states.retried += 1;
  }
  const groups = new Map<string, PerformanceSample[]>();
  let ungroupedSuccesses = 0;
  for (const sample of selected) {
    if (sample.state !== "succeeded") continue;
    const key = cohortKey(sample);
    if (key === null) {
      ungroupedSuccesses += 1;
      continue;
    }
    const bucket = groups.get(key) ?? [];
    bucket.push(sample);
    groups.set(key, bucket);
  }
  const cohorts = [...groups].map(([key, samples]) =>
    buildCohort(key, samples),
  );
  return {
    schemaVersion: 1,
    scope: "local-worker-history",
    units: {
      duration: "ms",
      decodedAudio: "s",
      outputSize: "bytes",
      separationRtf: "ratio",
    },
    since:
      options.since === undefined
        ? null
        : new Date(options.since).toISOString(),
    jobId: options.jobId ?? null,
    recipeId: options.recipeId ?? null,
    last: options.last,
    availableAttempts: all.length,
    selectedAttempts: selected.length,
    states,
    samples: selected,
    cohorts,
    ungroupedSuccesses,
    incompleteHistory: options.incompleteHistory,
    truncatedByQueryLimit: options.truncatedByQueryLimit,
    missingCoverage: [
      "backend queue",
      "input grant wait",
      "GPU occupancy",
      "network versus storage split within transfer",
      "stage overlap",
    ],
    note: "Stage timings are measured operations; observed wall time includes other waits. No speedup comparison is inferred from mixed jobs. GPU ID is a logical slot, not a hardware model.",
  };
}

function cohortKey(sample: PerformanceSample): string | null {
  if (
    !sample.provider ||
    !sample.gpuId ||
    !sample.runtimeIncarnation ||
    !sample.recipeId ||
    !sample.recipeDigest ||
    !sample.modelDigest ||
    !sample.outputBitrateKbps ||
    !sample.groupSize ||
    !sample.modelLoadState ||
    !sample.decodedInputDurationSeconds
  )
    return null;
  return JSON.stringify([
    sample.provider,
    sample.gpuId,
    sample.runtimeIncarnation,
    sample.recipeId,
    sample.recipeDigest,
    sample.modelDigest,
    sample.outputBitrateKbps,
    sample.groupSize,
    sample.modelLoadState,
    Math.round(sample.decodedInputDurationSeconds / 5) * 5,
  ]);
}

function buildCohort(
  key: string,
  samples: PerformanceSample[],
): PerformanceCohort {
  const first = samples[0]!;
  const duration = samples.map((sample) => sample.decodedInputDurationSeconds!);
  const stageMs: PerformanceCohort["stageMs"] = {};
  const stages = new Set([
    ...expectedStages(first.recipeId),
    ...samples.flatMap((sample) => Object.keys(sample.stageMs)),
  ]);
  for (const stage of stages) {
    const values = samples.flatMap((sample) =>
      sample.stageMs[stage] === undefined ? [] : [sample.stageMs[stage]!],
    );
    if (values.length) stageMs[stage] = summary(values);
  }
  const rtf = samples.flatMap((sample) =>
    sample.separationRtf === null ? [] : [sample.separationRtf],
  );
  return {
    key,
    recipeId: first.recipeId!,
    provider: first.provider!,
    gpuId: first.gpuId!,
    runtimeIncarnation: first.runtimeIncarnation!,
    modelDigest: first.modelDigest!,
    recipeDigest: first.recipeDigest!,
    outputBitrateKbps: first.outputBitrateKbps!,
    groupSize: first.groupSize!,
    modelLoadState: first.modelLoadState!,
    durationBucketSeconds:
      Math.round(first.decodedInputDurationSeconds! / 5) * 5,
    sampleCount: samples.length,
    decodedDurationRangeSeconds: [Math.min(...duration), Math.max(...duration)],
    stageMs,
    separationRtf: rtf.length ? summary(rtf) : null,
  };
}

function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    median:
      sorted.length % 2
        ? sorted[middle]!
        : (sorted[middle - 1]! + sorted[middle]!) / 2,
    min: sorted[0]!,
    max: sorted.at(-1)!,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
