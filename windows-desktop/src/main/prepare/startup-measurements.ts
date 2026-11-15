import type { HostContext } from "../host-context.js";
export const STARTUP_MEASUREMENT_KEY = "startup_measurements";
export const STARTUP_PHASES = [
  "app-bootstrap",
  "status-check",
  "controller-attach",
  "model-load",
  "first-inference",
] as const;
export type StartupPhase = (typeof STARTUP_PHASES)[number];
export type StartupOutcome = "completed" | "failed" | "cancelled";
export interface StartupMeasurement {
  phase: StartupPhase;
  outcome: StartupOutcome;
  durationMs: number;
  observedAt: string;
  origin: "node" | "engine";
  releaseSha256?: string;
  modelSha256?: string;
}
export interface StartupMeasurementStore {
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  read(): Promise<Buffer | null>;
  write(bytes: Buffer): Promise<void>;
}
const MAX_RECORDS = 32,
  MAX_BYTES = 16384,
  RETENTION_MS = 7 * 86400000,
  MAX_DURATION_MS = 24 * 60 * 60_000;
function parseRecord(value: unknown): StartupMeasurement {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("STARTUP_MEASUREMENT_INVALID");
  const row = value as StartupMeasurement;
  if (
    Object.keys(row).some(
      (key) =>
        ![
          "phase",
          "outcome",
          "durationMs",
          "observedAt",
          "origin",
          "releaseSha256",
          "modelSha256",
        ].includes(key),
    ) ||
    !STARTUP_PHASES.includes(row.phase) ||
    !["completed", "failed", "cancelled"].includes(row.outcome) ||
    !Number.isFinite(row.durationMs) ||
    row.durationMs < 0 ||
    row.durationMs > MAX_DURATION_MS ||
    typeof row.observedAt !== "string" ||
    !Number.isFinite(Date.parse(row.observedAt)) ||
    !["node", "engine"].includes(row.origin) ||
    [row.releaseSha256, row.modelSha256].some(
      (part) =>
        part !== undefined &&
        (typeof part !== "string" || !/^[a-f0-9]{64}$/u.test(part)),
    )
  )
    throw new Error("STARTUP_MEASUREMENT_INVALID");
  return structuredClone(row);
}
function decode(bytes: Buffer | null): StartupMeasurement[] {
  if (!bytes) return [];
  if (bytes.length > MAX_BYTES) throw new Error("STARTUP_MEASUREMENT_INVALID");
  const row = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (
    !row ||
    Object.keys(row).sort().join() !== "records,version" ||
    row.version !== 1 ||
    !Array.isArray(row.records) ||
    row.records.length > MAX_RECORDS
  )
    throw new Error("STARTUP_MEASUREMENT_INVALID");
  return row.records.map(parseRecord);
}
/** Local diagnostics only. No identifier, path, telemetry, execution authority or
 * speed promise. Cold/page-cache state must be measured separately on Windows. */
export class LocalStartupMeasurements {
  private records: StartupMeasurement[] = [];
  private pending: StartupMeasurement[] = [];
  private writing: Promise<void> | undefined;
  private store: StartupMeasurementStore | undefined;
  constructor(
    store?: StartupMeasurementStore,
    private readonly clock = {
      monotonic: () => performance.now(),
      wall: () => Date.now(),
    },
  ) {
    this.store = store;
  }
  attach(store: StartupMeasurementStore): void {
    if (this.store && this.store !== store)
      throw new Error("STARTUP_MEASUREMENT_STORE_BOUND");
    this.store = store;
  }
  view(): readonly StartupMeasurement[] {
    return structuredClone(this.records);
  }
  begin(
    phase: StartupPhase,
    identity: { releaseSha256?: string; modelSha256?: string } = {},
  ) {
    const started = this.clock.monotonic();
    let finished = false;
    const end = (outcome: StartupOutcome) => {
      if (finished) return;
      finished = true;
      this.recordDuration(
        phase,
        this.clock.monotonic() - started,
        outcome,
        "node",
        identity,
      );
    };
    return {
      complete: () => end("completed"),
      failed: () => end("failed"),
      cancelled: () => end("cancelled"),
    };
  }
  recordDuration(
    phase: StartupPhase,
    durationMs: number,
    outcome: StartupOutcome,
    origin: "node" | "engine" = "node",
    identity: { releaseSha256?: string; modelSha256?: string } = {},
  ): void {
    const row = parseRecord({
      phase,
      outcome,
      durationMs,
      observedAt: new Date(this.clock.wall()).toISOString(),
      origin,
      ...identity,
    });
    this.records = [...this.records, row].slice(-MAX_RECORDS);
    this.pending = [...this.pending, row].slice(-MAX_RECORDS);
  }
  flush(): Promise<void> {
    this.writing ??= this.persist().finally(() => {
      this.writing = undefined;
    });
    return this.writing;
  }
  private async persist(): Promise<void> {
    const store = this.store;
    if (!store || !this.pending.length) return;
    while (this.pending.length) {
      const batch = [...this.pending];
      await store.exclusive(async () => {
        const existing = decode(await store.read()),
          now = this.clock.wall();
        const seen = new Set<string>();
        const combined = [...existing, ...batch]
          .filter((row) => {
            const key = JSON.stringify([
              row.phase,
              row.outcome,
              row.durationMs,
              row.observedAt,
              row.origin,
              row.releaseSha256,
              row.modelSha256,
            ]);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .filter(
            (row) =>
              Date.parse(row.observedAt) >= now - RETENTION_MS &&
              Date.parse(row.observedAt) <= now,
          )
          .slice(-MAX_RECORDS);
        const bytes = Buffer.from(
          JSON.stringify({ version: 1, records: combined }),
        );
        if (bytes.length > MAX_BYTES)
          throw new Error("STARTUP_MEASUREMENT_INVALID");
        await store.write(bytes);
      });
      this.pending = this.pending.filter((row) => !batch.includes(row));
    }
  }
}
export function windowsStartupMeasurementStore(
  host: HostContext,
): StartupMeasurementStore {
  return {
    exclusive: async (work) => {
      const lease = await host.native.acquireMutex("metadata");
      if (!lease) throw new Error("METADATA_BUSY");
      try {
        return await work();
      } finally {
        await host.native.releaseMutex(lease);
      }
    },
    read: () => host.native.vaultRead("account", STARTUP_MEASUREMENT_KEY),
    write: (bytes) =>
      host.native.vaultWrite("account", STARTUP_MEASUREMENT_KEY, bytes),
  };
}
export function parseEngineStartupTimings(
  value: unknown,
): { modelLoadSeconds: number; firstInferenceSeconds: number } | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("STARTUP_MEASUREMENT_INVALID");
  const row = value as {
    modelLoadSeconds: number;
    firstInferenceSeconds: number;
  };
  if (
    Object.keys(row).sort().join() !==
      "firstInferenceSeconds,modelLoadSeconds" ||
    [row.modelLoadSeconds, row.firstInferenceSeconds].some(
      (part) =>
        typeof part !== "number" ||
        !Number.isFinite(part) ||
        part < 0 ||
        part > 3600,
    )
  )
    throw new Error("STARTUP_MEASUREMENT_INVALID");
  return row;
}
