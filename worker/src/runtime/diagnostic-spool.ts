import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { sanitizeDiagnostic } from "../agent/child-process.js";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULT_QUOTA_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_BYTES = 8 * 1024;
const MAX_PENDING_RECORDS = 100;

export interface RuntimeDiagnostics {
  initialize(): Promise<void>;
  record(event: object): void;
  canAdmitJobs(): Promise<boolean>;
  flush(): Promise<void>;
}

interface DiagnosticRecord {
  schemaVersion: 1;
  streamId: string;
  sequence: number;
  recordedAt: string;
  event: Record<string, unknown>;
}

export class DiagnosticSpool implements RuntimeDiagnostics {
  private readonly eventsPath: string;
  private readonly markerPath: string;
  private readonly streamPath: string;
  private streamId = "";
  private nextSequence = 1;
  private currentBytes = 0;
  private pending = 0;
  private blocked = false;
  private initialized = false;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly quotaBytes = DEFAULT_QUOTA_BYTES,
  ) {
    if (!Number.isSafeInteger(quotaBytes) || quotaBytes < MAX_RECORD_BYTES)
      throw new TypeError("Diagnostic spool quota is invalid");
    this.eventsPath = join(root, "events.jsonl");
    this.markerPath = join(root, "spool-full.marker");
    this.streamPath = join(root, "stream-id");
  }

  async initialize(): Promise<void> {
    if (this.initialized)
      throw new Error("Diagnostic spool is already initialized");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await assertSafeDirectory(this.root);
    this.streamId = await this.loadOrCreateStreamId();
    const eventsInformation = await lstat(this.eventsPath).catch(() => null);
    if (eventsInformation)
      assertSafePrivateFile(eventsInformation, "Diagnostic spool event file");
    const existing = eventsInformation
      ? await readFile(this.eventsPath)
      : Buffer.alloc(0);
    this.currentBytes = existing.byteLength;
    if (existing.byteLength > this.quotaBytes) {
      this.blocked = true;
      await this.writeMarker("quota-exhausted");
    } else {
      try {
        this.nextSequence = validateExistingRecords(existing, this.streamId);
      } catch {
        this.blocked = true;
        await this.writeMarker("corrupt-spool");
      }
    }
    const marker = await lstat(this.markerPath).catch(() => null);
    if (marker && (!marker.isFile() || marker.isSymbolicLink()))
      throw new Error("Diagnostic spool failure marker is unsafe");
    this.blocked ||= marker !== null;
    this.initialized = true;
  }

  record(event: object): void {
    this.assertInitialized();
    if (this.blocked) return;
    if (this.pending >= MAX_PENDING_RECORDS) {
      this.blocked = true;
      this.queueMarker("pending-record-limit");
      return;
    }
    this.pending += 1;
    const operation = this.writes.then(() => this.append(event));
    this.writes = operation
      .catch((error: unknown) => {
        this.blocked = true;
        return this.writeMarker(
          error instanceof DiagnosticSpoolFullError
            ? "quota-exhausted"
            : "write-failed",
        );
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
    await this.writes;
  }

  private async append(event: object): Promise<void> {
    const record: DiagnosticRecord = {
      schemaVersion: 1,
      streamId: this.streamId,
      sequence: this.nextSequence,
      recordedAt: new Date().toISOString(),
      event: sanitizeRecord(event as Record<string, unknown>),
    };
    const encoded = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (encoded.byteLength > MAX_RECORD_BYTES)
      throw new Error("Diagnostic record exceeds its byte limit");
    if (this.currentBytes + encoded.byteLength > this.quotaBytes)
      throw new DiagnosticSpoolFullError();
    const information = await lstat(this.eventsPath).catch(() => null);
    if (information)
      assertSafePrivateFile(information, "Diagnostic spool event file");
    await appendFile(this.eventsPath, encoded, { mode: 0o600 });
    // Windows requires a writable file handle for FlushFileBuffers/fsync even
    // when the record was appended through a separate handle.
    const handle = await open(this.eventsPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.currentBytes += encoded.byteLength;
    this.nextSequence += 1;
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
    this.writes = this.writes.then(() => this.writeMarker(reason));
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

function validateExistingRecords(contents: Buffer, streamId: string): number {
  if (contents.byteLength === 0) return 1;
  const text = contents.toString("utf8");
  if (!text.endsWith("\n"))
    throw new Error("Diagnostic spool ended with an incomplete record");
  let expected = 1;
  for (const line of text.trimEnd().split("\n")) {
    if (Buffer.byteLength(`${line}\n`, "utf8") > MAX_RECORD_BYTES)
      throw new Error("Diagnostic spool record exceeds its byte limit");
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error("Diagnostic spool contains invalid JSON");
    }
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (value as DiagnosticRecord).schemaVersion !== 1 ||
      (value as DiagnosticRecord).streamId !== streamId ||
      (value as DiagnosticRecord).sequence !== expected
    )
      throw new Error("Diagnostic spool sequence is invalid");
    expected += 1;
  }
  return expected;
}

function sanitizeRecord(
  event: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(event).map(([key, value]) => [key, sanitizeValue(value)]),
  );
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeDiagnostic(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(sanitizeValue);
  if (value !== null && typeof value === "object")
    return sanitizeRecord(value as Record<string, unknown>);
  return value;
}
