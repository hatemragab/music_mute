import { createReadStream, createWriteStream } from "node:fs";
import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  open,
  readdir,
  readFile,
  rename,
  rm,
  truncate,
} from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { sanitizeDiagnostic } from "../../agent/child-process.js";
import {
  clearDiagnosticHistory,
  sanitizeDiagnosticEvent,
} from "../../runtime/diagnostic-spool.js";
import type { MacUserLayout } from "./user-paths.js";

export const MAC_LOG_ROTATE_BYTES = 5 * 1024 * 1024;
export const MAC_LOG_ARCHIVE_COUNT = 5;
const TAIL_BYTES = 2 * 1024 * 1024;

export type OperationalLogLevel = "info" | "warning" | "error";

export interface OperationalEvent {
  recordedAt: string;
  level: OperationalLogLevel;
  event: Record<string, unknown>;
}

export interface OperationalLogFilter {
  lines: number;
  attemptId?: string;
  jobId?: string;
  code?: string;
  since?: number;
  level?: OperationalLogLevel;
  errorsOnly?: boolean;
}

export interface OperationalLogUsage {
  bytes: number;
  files: number;
  rotationLimitBytes: number;
  archivesPerStream: number;
  diagnosticSpoolBlocked: boolean;
}

export interface OperationalLogCursor {
  readonly positions: Map<string, { offset: number; partial: Buffer }>;
}

export function createOperationalLogCursor(): OperationalLogCursor {
  return { positions: new Map() };
}

export interface ClearedOperationalLogs {
  filesCleared: number;
  bytesCleared: number;
}

export async function maintainMacUserLogs(
  layout: Pick<MacUserLayout, "stdoutPath" | "stderrPath">,
): Promise<void> {
  await rotateIfRequired(layout.stdoutPath);
  await rotateIfRequired(layout.stderrPath);
}

export async function clearMacUserLogs(
  layout: Pick<MacUserLayout, "stdoutPath" | "stderrPath" | "workRoot">,
): Promise<ClearedOperationalLogs> {
  let filesCleared = 0;
  let bytesCleared = 0;
  for (const path of [layout.stdoutPath, layout.stderrPath]) {
    const cleared = await clearActiveLog(path);
    filesCleared += cleared.files;
    bytesCleared += cleared.bytes;
    for (let index = 1; index <= MAC_LOG_ARCHIVE_COUNT; index += 1) {
      const removed = await removePrivateLog(`${path}.${index}.gz`);
      filesCleared += removed.files;
      bytesCleared += removed.bytes;
    }
  }
  const spoolRoot = join(layout.workRoot, "..", "logs");
  const diagnostic = await clearDiagnosticHistory(spoolRoot);
  filesCleared += diagnostic.filesCleared;
  bytesCleared += diagnostic.bytesCleared;
  return { filesCleared, bytesCleared };
}

export async function appendMacFatalError(
  path: string,
  component: string,
  error: unknown,
): Promise<void> {
  const detail = sanitizeDiagnostic(
    error instanceof Error ? error.message : "Unknown worker failure",
  ).slice(0, 2_000);
  const value = {
    timestamp: new Date().toISOString(),
    level: "error",
    component: safeLabel(component),
    code: errorCode(error),
    detail,
  };
  await chmodOrCreate(path, `${JSON.stringify(value)}\n`);
}

export async function readTextLogTail(
  path: string,
  lines: number,
): Promise<string> {
  const value = await readTail(path, TAIL_BYTES);
  return sanitizeDiagnostic(value.split("\n").slice(-lines).join("\n"));
}

export async function readOperationalEvents(
  layout: Pick<MacUserLayout, "workRoot">,
  filter: OperationalLogFilter,
): Promise<OperationalEvent[]> {
  if (
    !Number.isSafeInteger(filter.lines) ||
    filter.lines < 1 ||
    filter.lines > 10_000
  )
    throw new TypeError("Operational event result limit is invalid");
  const root = join(layout.workRoot, "..", "logs");
  const names = (await readdir(root).catch(() => []))
    .filter((name) => /^events-\d{12}\.jsonl$/u.test(name))
    .sort();
  names.push("events.jsonl");
  const events: OperationalEvent[] = [];
  for (const name of names) {
    const path = join(root, name);
    const information = await lstat(path).catch(() => null);
    if (!information) continue;
    assertPrivateLog(information, "Diagnostic event file");
    const contents = await readFile(path, "utf8");
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as unknown;
        if (!isRecord(record) || !isRecord(record.event)) continue;
        if (
          typeof record.recordedAt !== "string" ||
          !Number.isFinite(Date.parse(record.recordedAt))
        )
          continue;
        const event = sanitizeDiagnosticEvent(record.event);
        const level = eventLevel(event);
        if (
          filter.attemptId !== undefined &&
          event.attemptId !== filter.attemptId
        )
          continue;
        if (filter.jobId !== undefined && event.jobId !== filter.jobId)
          continue;
        if (filter.code !== undefined && event.code !== filter.code) continue;
        if (
          filter.since !== undefined &&
          Date.parse(record.recordedAt) < filter.since
        )
          continue;
        if (filter.level !== undefined && level !== filter.level) continue;
        if (filter.errorsOnly === true && level !== "error") continue;
        events.push({ recordedAt: record.recordedAt, level, event });
        if (events.length > filter.lines) events.shift();
      } catch {
        // A malformed final line is ignored in the operator view; Doctor reports
        // the durable spool marker separately.
      }
    }
  }
  return events;
}

export async function readNewOperationalEvents(
  layout: Pick<MacUserLayout, "workRoot">,
  filter: OperationalLogFilter,
  cursor: OperationalLogCursor,
): Promise<OperationalEvent[]> {
  const root = join(layout.workRoot, "..", "logs");
  const names = (await readdir(root).catch(() => []))
    .filter((name) => /^events-\d{12}\.jsonl$/u.test(name))
    .sort();
  names.push("events.jsonl");
  const seen = new Set<string>();
  const events: OperationalEvent[] = [];
  for (const name of names) {
    const path = join(root, name);
    const lines = await readNewLogLines(path, cursor, seen);
    for (const line of lines) {
      const parsed = parseOperationalEvent(line, filter);
      if (!parsed) continue;
      events.push(parsed);
      if (events.length > filter.lines) events.shift();
    }
  }
  for (const key of cursor.positions.keys())
    if (!seen.has(key)) cursor.positions.delete(key);
  return events;
}

export async function readNewTextLog(
  path: string,
  cursor: OperationalLogCursor,
): Promise<string> {
  const seen = new Set<string>();
  const lines = await readNewLogLines(path, cursor, seen);
  for (const key of cursor.positions.keys())
    if (!seen.has(key)) cursor.positions.delete(key);
  return sanitizeDiagnostic(lines.join("\n"));
}

async function readNewLogLines(
  path: string,
  cursor: OperationalLogCursor,
  seen: Set<string>,
): Promise<string[]> {
  const information = await lstat(path).catch(() => null);
  if (!information) return [];
  assertPrivateLog(information, "Worker log file");
  const key = `${information.dev}:${information.ino}`;
  seen.add(key);
  const previous = cursor.positions.get(key);
  let offset = previous?.offset ?? 0;
  let partial = previous?.partial ?? Buffer.alloc(0);
  if (offset > information.size) {
    offset = 0;
    partial = Buffer.alloc(0);
  }
  const lines: string[] = [];
  const handle = await open(path, "r");
  try {
    while (offset < information.size) {
      const length = Math.min(64 * 1024, information.size - offset);
      const chunk = Buffer.alloc(length);
      const read = await handle.read(chunk, 0, length, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
      const combined = Buffer.concat([
        partial,
        chunk.subarray(0, read.bytesRead),
      ]);
      const lastNewline = combined.lastIndexOf(10);
      if (lastNewline < 0) {
        partial = combined.length <= 8 * 1024 ? combined : Buffer.alloc(0);
        continue;
      }
      const complete = combined.subarray(0, lastNewline).toString("utf8");
      partial = Buffer.from(combined.subarray(lastNewline + 1));
      for (const line of complete.split("\n")) {
        lines.push(line);
        if (lines.length > 1_000) lines.shift();
      }
    }
  } finally {
    await handle.close();
  }
  cursor.positions.set(key, { offset, partial });
  return lines;
}

function parseOperationalEvent(
  line: string,
  filter: OperationalLogFilter,
): OperationalEvent | null {
  if (!line.trim()) return null;
  try {
    const record = JSON.parse(line) as unknown;
    if (!isRecord(record) || !isRecord(record.event)) return null;
    if (
      typeof record.recordedAt !== "string" ||
      !Number.isFinite(Date.parse(record.recordedAt))
    )
      return null;
    const event = sanitizeDiagnosticEvent(record.event);
    const level = eventLevel(event);
    if (filter.attemptId !== undefined && event.attemptId !== filter.attemptId)
      return null;
    if (filter.jobId !== undefined && event.jobId !== filter.jobId) return null;
    if (filter.code !== undefined && event.code !== filter.code) return null;
    if (
      filter.since !== undefined &&
      Date.parse(record.recordedAt) < filter.since
    )
      return null;
    if (filter.level !== undefined && level !== filter.level) return null;
    if (filter.errorsOnly === true && level !== "error") return null;
    return { recordedAt: record.recordedAt, level, event };
  } catch {
    return null;
  }
}

export async function inspectOperationalLogUsage(
  layout: Pick<MacUserLayout, "logRoot" | "workRoot">,
): Promise<OperationalLogUsage> {
  const roots = [layout.logRoot, join(layout.workRoot, "..", "logs")];
  let bytes = 0;
  let files = 0;
  for (const root of roots) {
    for (const entry of await readdir(root).catch(() => [])) {
      const path = join(root, entry);
      const information = await lstat(path).catch(() => null);
      if (!information?.isFile() || information.isSymbolicLink()) continue;
      bytes += information.size;
      files += 1;
    }
  }
  const marker = join(layout.workRoot, "..", "logs", "spool-full.marker");
  return {
    bytes,
    files,
    rotationLimitBytes: MAC_LOG_ROTATE_BYTES,
    archivesPerStream: MAC_LOG_ARCHIVE_COUNT,
    diagnosticSpoolBlocked: (await lstat(marker).catch(() => null)) !== null,
  };
}

export function formatOperationalEvent(event: OperationalEvent): string {
  const kind =
    typeof event.event.kind === "string" ? event.event.kind : "diagnostic";
  const fields = [
    event.event.jobId && `job=${String(event.event.jobId)}`,
    event.event.attemptId && `attempt=${String(event.event.attemptId)}`,
    event.event.workerId && `worker=${String(event.event.workerId)}`,
    event.event.code && `code=${String(event.event.code)}`,
    event.event.detail && `detail=${compactDetail(event.event.detail)}`,
  ].filter(Boolean);
  return `${event.recordedAt} ${event.level.toUpperCase()} ${kind}${fields.length ? ` ${fields.join(" ")}` : ""}`;
}

function compactDetail(value: unknown): string {
  return [...String(value)]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
}

export function parseSince(value: string, now = Date.now()): number {
  const match = /^(\d+)(s|m|h|d)$/u.exec(value);
  if (!match) throw new TypeError("--since must use s, m, h, or d");
  const amount = Number(match[1]);
  const units = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const milliseconds = amount * units[match[2] as keyof typeof units];
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 1 ||
    milliseconds > 30 * units.d
  )
    throw new TypeError("--since must be between 1 second and 30 days");
  return now - milliseconds;
}

async function rotateIfRequired(path: string): Promise<void> {
  const information = await lstat(path).catch(() => null);
  if (!information) return;
  if (!information.isFile() || information.isSymbolicLink())
    throw new TypeError("Worker log file is unsafe");
  if (information.size < MAC_LOG_ROTATE_BYTES) return;
  await rm(`${path}.${MAC_LOG_ARCHIVE_COUNT}.gz`, { force: true });
  for (let index = MAC_LOG_ARCHIVE_COUNT - 1; index >= 1; index -= 1) {
    await rename(`${path}.${index}.gz`, `${path}.${index + 1}.gz`).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
  }
  const temporary = `${path}.1.gz.${process.pid}.tmp`;
  try {
    await pipeline(
      createReadStream(path),
      createGzip({ level: 9 }),
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    await rename(temporary, `${path}.1.gz`);
    await truncate(path, 0);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function clearActiveLog(
  path: string,
): Promise<{ files: number; bytes: number }> {
  const information = await lstat(path).catch(() => null);
  if (information === null) return { files: 0, bytes: 0 };
  assertPrivateLog(information, "Worker log file");
  await truncate(path, 0);
  await chmod(path, 0o600);
  return { files: 1, bytes: information.size };
}

async function removePrivateLog(
  path: string,
): Promise<{ files: number; bytes: number }> {
  const information = await lstat(path).catch(() => null);
  if (information === null) return { files: 0, bytes: 0 };
  assertPrivateLog(information, "Worker log archive");
  await rm(path);
  return { files: 1, bytes: information.size };
}

function assertPrivateLog(information: Stats, label: string): void {
  if (
    !information.isFile() ||
    information.isSymbolicLink() ||
    (process.platform !== "win32" && (information.mode & 0o077) !== 0)
  )
    throw new TypeError(`${label} is unsafe`);
}

async function readTail(path: string, maximumBytes: number): Promise<string> {
  try {
    const information = await lstat(path);
    if (!information.isFile() || information.isSymbolicLink())
      throw new TypeError("Worker log file is unsafe");
    const length = Math.min(information.size, maximumBytes);
    if (length === 0) return "";
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, information.size - length);
      const text = buffer.toString("utf8");
      return information.size > length
        ? text.slice(text.indexOf("\n") + 1)
        : text;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function chmodOrCreate(path: string, value: string): Promise<void> {
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

function eventLevel(event: Record<string, unknown>): OperationalLogLevel {
  const kind = typeof event.kind === "string" ? event.kind : "";
  if (
    /failed|unavailable|resource-blocked|report-deferred/u.test(kind) ||
    (typeof event.code === "string" && /failed|error|invalid/u.test(event.code))
  )
    return "error";
  if (/stopped|recovered|drain|pause/u.test(kind)) return "warning";
  return "info";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeLabel(value: string): string {
  return /^[a-z][a-z0-9-]{0,63}$/u.test(value) ? value : "runtime";
}

function errorCode(error: unknown): string {
  const candidate = isRecord(error) ? error.code : undefined;
  return typeof candidate === "string" && /^[A-Z0-9_-]{1,64}$/u.test(candidate)
    ? candidate
    : error instanceof TypeError
      ? "TYPE_ERROR"
      : "RUNTIME_FAILED";
}
