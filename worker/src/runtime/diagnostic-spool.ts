import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { sanitizeDiagnostic } from "../agent/child-process.js";
import { withDiagnosticStoreLock } from "./diagnostic-store-lock.js";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULT_QUOTA_BYTES = 100 * 1024 * 1024;
const DEFAULT_SEGMENT_BYTES = 1 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_SYNC_INTERVAL_MS = 5_000;
const MAX_RECORD_BYTES = 8 * 1024;
const MAX_PENDING_RECORDS = 1_000;
const SEGMENT_NAME = /^events-(\d{12})\.jsonl$/u;

export interface DiagnosticSpoolOptions {
  now?: () => number;
  retentionMs?: number;
  segmentBytes?: number;
  syncIntervalMs?: number;
}

export interface DiagnosticCoverage {
  earliestAvailableAt: string | null;
  latestAvailableAt: string | null;
  incompleteHistory: boolean;
  retainedBytes: number;
  retentionDays: number;
  blockedReason: string | null;
}

export interface RuntimeDiagnostics {
  initialize(): Promise<void>;
  record(event: object): void;
  canAdmitJobs(): Promise<boolean>;
  flush(): Promise<void>;
  coverage?(): DiagnosticCoverage;
}

export interface DiagnosticRecord {
  schemaVersion: 1;
  streamId: string;
  sequence: number;
  recordedAt: string;
  event: Record<string, unknown>;
}

interface SegmentInfo {
  path: string;
  firstSequence: number;
  lastSequence: number;
  firstAt: number;
  lastAt: number;
  bytes: number;
}

interface HistoryState {
  schemaVersion: 1;
  streamId: string;
  nextSequence: number;
  incompleteHistory: boolean;
}

export class DiagnosticSpool implements RuntimeDiagnostics {
  private readonly eventsPath: string;
  private readonly markerPath: string;
  private readonly streamPath: string;
  private readonly historyPath: string;
  private readonly segmentBytes: number;
  private readonly retentionMs: number;
  private readonly syncIntervalMs: number;
  private readonly now: () => number;
  private streamId = "";
  private nextSequence = 1;
  private currentBytes = 0;
  private activeFirstSequence = 1;
  private activeFirstAt = 0;
  private activeLastAt = 0;
  private segments: SegmentInfo[] = [];
  private incompleteHistory = false;
  private historyBytes = 0;
  private blockedReason: string | null = null;
  private lastProgressPersisted = new Map<
    string,
    { stage: string; at: number }
  >();
  private syncTimer: NodeJS.Timeout | null = null;
  private unsynced = false;
  private pending = 0;
  private blocked = false;
  private initialized = false;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly quotaBytes = DEFAULT_QUOTA_BYTES,
    options: DiagnosticSpoolOptions = {},
  ) {
    this.segmentBytes =
      options.segmentBytes ?? Math.min(DEFAULT_SEGMENT_BYTES, quotaBytes);
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.syncIntervalMs = options.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    if (
      !Number.isSafeInteger(quotaBytes) ||
      quotaBytes < MAX_RECORD_BYTES ||
      !Number.isSafeInteger(this.segmentBytes) ||
      this.segmentBytes < MAX_RECORD_BYTES ||
      this.segmentBytes > quotaBytes ||
      !Number.isSafeInteger(this.retentionMs) ||
      this.retentionMs < 60_000 ||
      !Number.isSafeInteger(this.syncIntervalMs) ||
      this.syncIntervalMs < 100
    )
      throw new TypeError("Diagnostic spool quota is invalid");
    this.eventsPath = join(root, "events.jsonl");
    this.markerPath = join(root, "spool-full.marker");
    this.streamPath = join(root, "stream-id");
    this.historyPath = join(root, "history.json");
  }

  async initialize(): Promise<void> {
    if (this.initialized)
      throw new Error("Diagnostic spool is already initialized");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await assertSafeDirectory(this.root);
    this.streamId = await this.loadOrCreateStreamId();
    const history = await this.loadHistoryState();
    this.incompleteHistory = history?.incompleteHistory ?? false;
    const names = (await readdir(this.root))
      .filter((name) => SEGMENT_NAME.test(name))
      .sort();
    let expectedSequence: number | null = null;
    try {
      for (const name of names) {
        const path = join(this.root, name);
        const information = await lstat(path);
        assertSafePrivateFile(information, "Diagnostic segment");
        const parsed = validateExistingRecords(
          await readFile(path),
          this.streamId,
          expectedSequence,
        );
        if (parsed.firstSequence === null)
          throw new Error("Diagnostic segment is empty");
        if (parsed.firstSequence !== Number(SEGMENT_NAME.exec(name)?.[1]))
          throw new Error("Diagnostic segment name does not match its records");
        this.segments.push({
          path,
          firstSequence: parsed.firstSequence,
          lastSequence: parsed.lastSequence,
          firstAt: parsed.firstAt,
          lastAt: parsed.lastAt,
          bytes: information.size,
        });
        expectedSequence = parsed.nextSequence;
      }
    } catch {
      this.blocked = true;
      this.blockedReason = "corrupt-spool";
    }
    const eventsInformation = await lstat(this.eventsPath).catch(() => null);
    if (eventsInformation)
      assertSafePrivateFile(eventsInformation, "Diagnostic spool event file");
    const existing = eventsInformation
      ? await readFile(this.eventsPath)
      : Buffer.alloc(0);
    this.currentBytes = existing.byteLength;
    if (!this.blocked) {
      try {
        const parsed = validateExistingRecords(
          existing,
          this.streamId,
          expectedSequence,
        );
        this.nextSequence =
          parsed.firstSequence === null && this.segments.length === 0
            ? (history?.nextSequence ?? parsed.nextSequence)
            : parsed.nextSequence;
        this.activeFirstSequence =
          parsed.firstSequence ?? expectedSequence ?? 1;
        this.activeFirstAt = parsed.firstAt;
        this.activeLastAt = parsed.lastAt;
      } catch {
        this.blocked = true;
        this.blockedReason = "corrupt-spool";
      }
    }
    const marker = await lstat(this.markerPath).catch(() => null);
    if (marker && (!marker.isFile() || marker.isSymbolicLink()))
      throw new Error("Diagnostic spool failure marker is unsafe");
    if (marker) {
      this.blocked = true;
      this.blockedReason = (await readFile(this.markerPath, "utf8")).trim();
    }
    if (!this.blocked) {
      await this.maintain();
      if (this.currentBytes + this.metadataBudget() > this.quotaBytes) {
        this.blocked = true;
        this.blockedReason = "quota-exhausted";
      }
    }
    if (this.blocked && !marker)
      await this.writeMarker(this.blockedReason ?? "corrupt-spool");
    this.initialized = true;
  }

  record(event: object): void {
    this.assertInitialized();
    if (this.blocked) return;
    const safeEvent = sanitizeDiagnosticEvent(event as Record<string, unknown>);
    if (!this.shouldPersist(safeEvent)) return;
    if (this.pending >= MAX_PENDING_RECORDS) {
      this.blocked = true;
      this.blockedReason = "pending-record-limit";
      this.queueMarker("pending-record-limit");
      return;
    }
    this.pending += 1;
    const operation = this.writes.then(() => this.append(safeEvent));
    this.writes = operation
      .catch((error: unknown) => {
        this.blocked = true;
        this.blockedReason =
          error instanceof DiagnosticSpoolFullError
            ? "quota-exhausted"
            : "write-failed";
        return this.writeMarker(this.blockedReason).catch(() => undefined);
      })
      .finally(() => {
        this.pending -= 1;
      });
  }

  async canAdmitJobs(): Promise<boolean> {
    this.assertInitialized();
    await this.writes;
    return !this.blocked;
  }

  async flush(): Promise<void> {
    this.assertInitialized();
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    await this.writes;
    await this.syncActive();
  }

  async deliveryRecords(
    after: number,
  ): Promise<{ streamId: string; records: DiagnosticRecord[] }> {
    this.assertInitialized();
    await this.writes;
    return await withDiagnosticStoreLock(this.root, async () => {
      await this.refreshAfterClear();
      if (this.blocked) throw new Error("Diagnostic spool is blocked");
      await this.syncActive();
      if (process.platform !== "win32") {
        const directory = await open(this.root, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
      const records: DiagnosticRecord[] = [];
      for (const path of [
        ...this.segments.map((segment) => segment.path),
        this.eventsPath,
      ]) {
        let info;
        try {
          info = await lstat(path);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code === "ENOENT" &&
            path === this.eventsPath
          )
            continue;
          throw error;
        }
        assertSafePrivateFile(info, "Diagnostic delivery source");
        const content = await readFile(path, "utf8");
        validateExistingRecords(Buffer.from(content), this.streamId, null);
        for (const line of content.split("\n")) {
          if (!line) continue;
          const record = JSON.parse(line) as DiagnosticRecord;
          if (record.sequence <= after) continue;
          records.push(record);
          if (records.length === 50)
            return { streamId: this.streamId, records };
        }
      }
      return { streamId: this.streamId, records };
    });
  }

  coverage(): DiagnosticCoverage {
    this.assertInitialized();
    const first = this.segments[0]?.firstAt ?? this.activeFirstAt;
    const last = this.activeLastAt || this.segments.at(-1)?.lastAt || 0;
    return {
      earliestAvailableAt: first ? new Date(first).toISOString() : null,
      latestAvailableAt: last ? new Date(last).toISOString() : null,
      incompleteHistory: this.incompleteHistory,
      retainedBytes:
        this.currentBytes +
        this.segments.reduce((sum, item) => sum + item.bytes, 0) +
        this.historyBytes +
        37,
      retentionDays: this.retentionMs / 86_400_000,
      blockedReason: this.blockedReason,
    };
  }

  private async append(event: Record<string, unknown>): Promise<void> {
    await withDiagnosticStoreLock(this.root, async () => {
      await this.refreshAfterClear();
      await this.appendLocked(event);
    });
  }

  private async appendLocked(event: Record<string, unknown>): Promise<void> {
    const record: DiagnosticRecord = {
      schemaVersion: 1,
      streamId: this.streamId,
      sequence: this.nextSequence,
      recordedAt: new Date(this.now()).toISOString(),
      event,
    };
    const encoded = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (encoded.byteLength > MAX_RECORD_BYTES)
      throw new Error("Diagnostic record exceeds its byte limit");
    if (this.currentBytes + encoded.byteLength > this.segmentBytes)
      await this.rotateActive();
    await this.maintain(encoded.byteLength);
    if (
      this.currentBytes + encoded.byteLength + this.metadataBudget() >
      this.quotaBytes
    )
      throw new DiagnosticSpoolFullError();
    const information = await lstat(this.eventsPath).catch(() => null);
    if (information)
      assertSafePrivateFile(information, "Diagnostic spool event file");
    await appendFile(this.eventsPath, encoded, { mode: 0o600 });
    if (this.currentBytes === 0) {
      this.activeFirstSequence = this.nextSequence;
      this.activeFirstAt = this.now();
    }
    this.activeLastAt = this.now();
    this.currentBytes += encoded.byteLength;
    this.nextSequence += 1;
    this.unsynced = true;
    if (isDurableEvent(event)) await this.syncActive();
    else this.scheduleSync();
  }

  private async refreshAfterClear(): Promise<void> {
    const active = await lstat(this.eventsPath).catch(() => null);
    const missingSegment =
      this.segments.length > 0 &&
      (await lstat(this.segments[0]!.path).catch(() => null)) === null;
    if (active?.size === this.currentBytes && !missingSegment) return;
    if (active === null && this.currentBytes === 0 && !missingSegment) return;
    const history = await this.loadHistoryState();
    if (
      !history?.incompleteHistory ||
      history.nextSequence < this.nextSequence ||
      (active?.size ?? 0) !== 0
    )
      throw new Error("Diagnostic history changed outside its writer");
    this.segments = [];
    this.currentBytes = 0;
    this.activeFirstAt = 0;
    this.activeLastAt = 0;
    this.nextSequence = history.nextSequence;
    this.activeFirstSequence = this.nextSequence;
    this.incompleteHistory = true;
    this.unsynced = false;
  }

  private shouldPersist(event: Record<string, unknown>): boolean {
    if (event.kind !== "attempt-progress") {
      if (
        event.kind === "attempt-succeeded" ||
        event.kind === "attempt-failed" ||
        event.kind === "attempt-stopped"
      )
        this.lastProgressPersisted.delete(String(event.attemptId));
      return true;
    }
    const attemptId = String(event.attemptId ?? "");
    const stage = String(event.stage ?? "");
    const previous = this.lastProgressPersisted.get(attemptId);
    const work = event.work;
    const completed =
      work !== null && typeof work === "object"
        ? (work as Record<string, unknown>).completed
        : null;
    const total =
      work !== null && typeof work === "object"
        ? (work as Record<string, unknown>).total
        : null;
    const now = this.now();
    if (
      previous &&
      previous.stage === stage &&
      now - previous.at < this.syncIntervalMs &&
      completed !== total
    )
      return false;
    this.lastProgressPersisted.set(attemptId, { stage, at: now });
    return true;
  }

  private async rotateActive(): Promise<void> {
    if (this.currentBytes === 0) return;
    await this.syncActive();
    const path = join(
      this.root,
      `events-${String(this.activeFirstSequence).padStart(12, "0")}.jsonl`,
    );
    if (await lstat(path).catch(() => null))
      throw new Error("Diagnostic segment already exists");
    await rename(this.eventsPath, path);
    this.segments.push({
      path,
      firstSequence: this.activeFirstSequence,
      lastSequence: this.nextSequence - 1,
      firstAt: this.activeFirstAt,
      lastAt: this.activeLastAt,
      bytes: this.currentBytes,
    });
    this.currentBytes = 0;
    this.activeFirstAt = 0;
    this.activeLastAt = 0;
    this.activeFirstSequence = this.nextSequence;
  }

  private async maintain(upcomingBytes = 0): Promise<void> {
    const cutoff = this.now() - this.retentionMs;
    if (this.currentBytes > 0 && this.activeLastAt < cutoff)
      await this.rotateActive();
    let evicted = false;
    while (
      this.segments.length > 0 &&
      (this.segments[0]!.lastAt < cutoff ||
        this.currentBytes +
          this.segments.reduce((sum, item) => sum + item.bytes, 0) +
          upcomingBytes +
          this.metadataBudget() >
          this.quotaBytes)
    ) {
      const oldest = this.segments.shift()!;
      await rm(oldest.path);
      this.incompleteHistory = true;
      evicted = true;
    }
    if (evicted) await this.persistHistoryState();
  }

  private metadataBudget(): number {
    return 37 + Math.max(this.historyBytes, 128);
  }

  private async loadHistoryState(): Promise<HistoryState | null> {
    const information = await lstat(this.historyPath).catch(() => null);
    if (!information) return null;
    assertSafePrivateFile(information, "Diagnostic history state");
    this.historyBytes = information.size;
    const value = JSON.parse(
      await readFile(this.historyPath, "utf8"),
    ) as unknown;
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (value as HistoryState).schemaVersion !== 1 ||
      (value as HistoryState).streamId !== this.streamId ||
      !Number.isSafeInteger((value as HistoryState).nextSequence) ||
      (value as HistoryState).nextSequence < 1 ||
      typeof (value as HistoryState).incompleteHistory !== "boolean"
    )
      throw new Error("Diagnostic history state is invalid");
    return value as HistoryState;
  }

  private async persistHistoryState(): Promise<void> {
    const state: HistoryState = {
      schemaVersion: 1,
      streamId: this.streamId,
      nextSequence: this.nextSequence,
      incompleteHistory: this.incompleteHistory,
    };
    const encoded = `${JSON.stringify(state)}\n`;
    const information = await lstat(this.historyPath).catch(() => null);
    if (information)
      assertSafePrivateFile(information, "Diagnostic history state");
    await writeFile(this.historyPath, encoded, { mode: 0o600 });
    this.historyBytes = Buffer.byteLength(encoded);
  }

  private scheduleSync(): void {
    if (this.syncTimer) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.writes = this.writes
        .then(() => this.syncActive())
        .catch(() => {
          this.blocked = true;
          this.blockedReason = "write-failed";
          return this.writeMarker("write-failed").catch(() => undefined);
        });
    }, this.syncIntervalMs);
    this.syncTimer.unref();
  }

  private async syncActive(): Promise<void> {
    if (!this.unsynced) return;
    const handle = await open(this.eventsPath, "r+");
    try {
      await handle.sync();
      this.unsynced = false;
    } finally {
      await handle.close();
    }
  }

  private async loadOrCreateStreamId(): Promise<string> {
    let value = await readFile(this.streamPath, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      },
    );
    if (!value) {
      value = `${randomUUID()}\n`;
      await writeFile(this.streamPath, value, { flag: "wx", mode: 0o600 });
    }
    const streamId = value.trim();
    if (!UUID_V4.test(streamId))
      throw new Error("Diagnostic spool stream ID is invalid");
    const information = await lstat(this.streamPath);
    assertSafePrivateFile(information, "Diagnostic spool stream ID");
    return streamId;
  }

  private queueMarker(reason: string): void {
    this.writes = this.writes
      .then(() => this.writeMarker(reason))
      .catch(() => undefined);
  }

  private async writeMarker(reason: string): Promise<void> {
    const information = await lstat(this.markerPath).catch(() => null);
    if (information)
      assertSafePrivateFile(information, "Diagnostic spool failure marker");
    await writeFile(this.markerPath, `${reason}\n`, { mode: 0o600 });
  }

  private assertInitialized(): void {
    if (!this.initialized)
      throw new Error("Diagnostic spool is not initialized");
  }
}

class DiagnosticSpoolFullError extends Error {}

export async function clearDiagnosticHistory(
  root: string,
): Promise<{ filesCleared: number; bytesCleared: number }> {
  const information = await lstat(root).catch(() => null);
  if (!information) return { filesCleared: 0, bytesCleared: 0 };
  await assertSafeDirectory(root);
  return await withDiagnosticStoreLock(root, async () => {
    const streamPath = join(root, "stream-id");
    const streamInformation = await lstat(streamPath).catch(() => null);
    if (!streamInformation) return { filesCleared: 0, bytesCleared: 0 };
    assertSafePrivateFile(streamInformation, "Diagnostic stream ID");
    const streamId = (await readFile(streamPath, "utf8")).trim();
    if (!UUID_V4.test(streamId))
      throw new Error("Diagnostic stream ID is invalid");
    const historyPath = join(root, "history.json");
    const historyInformation = await lstat(historyPath).catch(() => null);
    let nextSequence = 1;
    if (historyInformation) {
      assertSafePrivateFile(historyInformation, "Diagnostic history state");
      const history = JSON.parse(
        await readFile(historyPath, "utf8"),
      ) as HistoryState;
      if (
        history.streamId === streamId &&
        Number.isSafeInteger(history.nextSequence) &&
        history.nextSequence > 0
      )
        nextSequence = history.nextSequence;
    }
    const names = (await readdir(root))
      .filter((name) => SEGMENT_NAME.test(name))
      .sort();
    names.push("events.jsonl");
    const files: Array<{ path: string; bytes: number; active: boolean }> = [];
    for (const name of names) {
      const path = join(root, name);
      const information = await lstat(path).catch(() => null);
      if (!information) continue;
      assertSafePrivateFile(information, "Diagnostic event file");
      const content = await readFile(path, "utf8");
      for (const line of content.split("\n")) {
        if (!line) continue;
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          if (Number.isSafeInteger(value.sequence))
            nextSequence = Math.max(
              nextSequence,
              (value.sequence as number) + 1,
            );
        } catch {
          // Explicit clear can discard a corrupt tail; keep the error marker.
        }
      }
      files.push({
        path,
        bytes: information.size,
        active: name === "events.jsonl",
      });
    }
    const history: HistoryState = {
      schemaVersion: 1,
      streamId,
      nextSequence,
      incompleteHistory: true,
    };
    await writeFile(historyPath, `${JSON.stringify(history)}\n`, {
      mode: 0o600,
    });
    for (const file of files) {
      if (file.active) await truncate(file.path, 0);
      else await rm(file.path);
    }
    return {
      filesCleared: files.length,
      bytesCleared: files.reduce((sum, file) => sum + file.bytes, 0),
    };
  });
}

async function assertSafeDirectory(path: string): Promise<void> {
  const information = await lstat(path);
  if (!information.isDirectory() || information.isSymbolicLink())
    throw new Error("Diagnostic spool directory is unsafe");
}

function assertSafePrivateFile(information: Stats, label: string): void {
  if (
    !information.isFile() ||
    information.isSymbolicLink() ||
    (process.platform !== "win32" && (information.mode & 0o077) !== 0)
  )
    throw new Error(`${label} is unsafe`);
}

function validateExistingRecords(
  contents: Buffer,
  streamId: string,
  expectedStart: number | null,
): {
  firstSequence: number | null;
  lastSequence: number;
  nextSequence: number;
  firstAt: number;
  lastAt: number;
} {
  if (contents.byteLength === 0)
    return {
      firstSequence: null,
      lastSequence: (expectedStart ?? 1) - 1,
      nextSequence: expectedStart ?? 1,
      firstAt: 0,
      lastAt: 0,
    };
  const text = contents.toString("utf8");
  if (!text.endsWith("\n"))
    throw new Error("Diagnostic spool ended with an incomplete record");
  let expected = expectedStart;
  let firstSequence = 0;
  let firstAt = 0;
  let lastAt = 0;
  for (const line of text.trimEnd().split("\n")) {
    if (Buffer.byteLength(`${line}\n`, "utf8") > MAX_RECORD_BYTES)
      throw new Error("Diagnostic spool record exceeds its byte limit");
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error("Diagnostic spool contains invalid JSON");
    }
    const record = value as DiagnosticRecord;
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      record.schemaVersion !== 1 ||
      record.streamId !== streamId ||
      !Number.isSafeInteger(record.sequence) ||
      record.sequence < 1 ||
      (expected !== null && record.sequence !== expected) ||
      typeof record.recordedAt !== "string" ||
      !Number.isFinite(Date.parse(record.recordedAt)) ||
      record.event === null ||
      typeof record.event !== "object" ||
      Array.isArray(record.event)
    )
      throw new Error("Diagnostic spool sequence is invalid");
    if (firstSequence === 0) firstSequence = record.sequence;
    if (expected === null) expected = record.sequence;
    if (firstAt === 0) firstAt = Date.parse(record.recordedAt);
    lastAt = Date.parse(record.recordedAt);
    expected += 1;
  }
  return {
    firstSequence,
    lastSequence: expected! - 1,
    nextSequence: expected!,
    firstAt,
    lastAt,
  };
}

function isDurableEvent(event: Record<string, unknown>): boolean {
  return (
    event.kind === "attempt-succeeded" ||
    event.kind === "attempt-failed" ||
    event.kind === "attempt-stopped" ||
    event.kind === "resource-blocked" ||
    event.kind === "child-unavailable" ||
    event.kind === "transfer-failed" ||
    event.kind === "progress-sync-failed"
  );
}

export function sanitizeDiagnosticEvent(
  event: Record<string, unknown>,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const key of ["kind", "component", "severity", "stage", "code"])
    if (
      typeof event[key] === "string" &&
      /^[A-Za-z0-9_-]{1,100}$/u.test(event[key])
    )
      safe[key] = event[key];
  for (const key of [
    "sessionId",
    "incarnation",
    "childIncarnation",
    "workerId",
    "attemptId",
  ])
    if (typeof event[key] === "string" && UUID_V4.test(event[key]))
      safe[key] = event[key];
  if (
    event.loadReason === "initial-start" ||
    event.loadReason === "attempt-recovery" ||
    event.loadReason === "slot-recovery" ||
    event.loadReason === "remote-benchmark"
  )
    safe.loadReason = event.loadReason;
  if (typeof event.jobId === "string" && /^[0-9a-f]{24}$/iu.test(event.jobId))
    safe.jobId = event.jobId;
  if (event.provider === "mps" || event.provider === "directml")
    safe.provider = event.provider;
  if (
    typeof event.gpuId === "string" &&
    /^[A-Za-z0-9_.-]{1,128}$/u.test(event.gpuId)
  )
    safe.gpuId = event.gpuId;
  if (
    typeof event.recipeId === "string" &&
    /^[a-z0-9-]{1,64}$/u.test(event.recipeId)
  )
    safe.recipeId = event.recipeId;
  for (const key of ["recipeDigest", "modelDigest"])
    if (typeof event[key] === "string" && /^[0-9a-f]{64}$/iu.test(event[key]))
      safe[key] = event[key];
  if (event.modelLoadState === "preloaded") safe.modelLoadState = "preloaded";
  if (event.groupSize === 1) safe.groupSize = 1;
  if (
    typeof event.outputBitrateKbps === "number" &&
    Number.isInteger(event.outputBitrateKbps) &&
    event.outputBitrateKbps >= 32 &&
    event.outputBitrateKbps <= 160
  )
    safe.outputBitrateKbps = event.outputBitrateKbps;
  if (
    typeof event.measuredInputDurationSeconds === "number" &&
    Number.isFinite(event.measuredInputDurationSeconds) &&
    event.measuredInputDurationSeconds > 0 &&
    event.measuredInputDurationSeconds <= 1800
  )
    safe.measuredInputDurationSeconds = event.measuredInputDurationSeconds;
  if (
    Number.isSafeInteger(event.outputBytes) &&
    (event.outputBytes as number) > 0 &&
    (event.outputBytes as number) <= 30_000_000
  )
    safe.outputBytes = event.outputBytes;
  if (event.schemaVersion === 2) safe.schemaVersion = 2;
  if (Number.isSafeInteger(event.sequence) && (event.sequence as number) > 0)
    safe.sequence = event.sequence;
  if (
    Number.isSafeInteger(event.attemptNumber) &&
    (event.attemptNumber as number) > 0
  )
    safe.attemptNumber = event.attemptNumber;
  if (
    typeof event.recordedAt === "string" &&
    Number.isFinite(Date.parse(event.recordedAt))
  )
    safe.recordedAt = event.recordedAt;
  if (event.retryable === null || typeof event.retryable === "boolean")
    safe.retryable = event.retryable;
  if (typeof event.detail === "string")
    safe.detail = sanitizeDiagnostic(event.detail)
      .replace(/(?:\/|[A-Za-z]:\\)[^\s,;:"']+/gu, "[REDACTED_PATH]")
      .replace(
        /\b[^\s/\\]+\.(?:mp3|wav|flac|m4a|aac|ogg)\b/giu,
        "[REDACTED_FILE]",
      )
      .replace(/[\r\n\t]+/gu, " ")
      .slice(0, 500);
  if (event.work !== null && typeof event.work === "object") {
    const work = event.work as Record<string, unknown>;
    if (
      work.unit === "windows" &&
      Number.isSafeInteger(work.completed) &&
      Number.isSafeInteger(work.total) &&
      (work.completed as number) >= 0 &&
      (work.total as number) > 0 &&
      (work.completed as number) <= (work.total as number)
    )
      safe.work = {
        unit: "windows",
        completed: work.completed,
        total: work.total,
      };
  }
  if (Array.isArray(event.stageTimings))
    safe.stageTimings = event.stageTimings.slice(0, 32).flatMap((item) => {
      if (item === null || typeof item !== "object") return [];
      const timing = item as Record<string, unknown>;
      if (
        typeof timing.stage !== "string" ||
        !/^[A-Za-z0-9_-]{1,100}$/u.test(timing.stage) ||
        typeof timing.durationMs !== "number" ||
        !Number.isFinite(timing.durationMs) ||
        timing.durationMs < 0 ||
        timing.durationMs > 7_200_000
      )
        return [];
      return [{ stage: timing.stage, durationMs: timing.durationMs }];
    });
  return safe;
}
