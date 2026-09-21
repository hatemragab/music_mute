import { createReadStream, createWriteStream } from "node:fs";
import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  open,
  readdir,
  rename,
  rm,
  truncate,
} from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { sanitizeDiagnostic } from "../../agent/child-process.js";
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
  for (const name of ["events.jsonl", "stream-id", "spool-full.marker"]) {
    const removed = await removePrivateLog(join(spoolRoot, name));
    filesCleared += removed.files;
    bytesCleared += removed.bytes;
  }
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
  const path = join(layout.workRoot, "..", "logs", "events.jsonl");
  const contents = await readTail(path, TAIL_BYTES);
  const events: OperationalEvent[] = [];
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
      const event = sanitizeObject(record.event);
      const level = eventLevel(event);
      if (
        filter.attemptId !== undefined &&
        event.attemptId !== filter.attemptId
      )
        continue;
      if (
        filter.since !== undefined &&
        Date.parse(record.recordedAt) < filter.since
      )
        continue;
      if (filter.level !== undefined && level !== filter.level) continue;
      if (filter.errorsOnly === true && level !== "error") continue;
      events.push({ recordedAt: record.recordedAt, level, event });
    } catch {
      // A malformed final line is ignored in the operator view; Doctor reports
      // the durable spool marker separately.
    }
  }
  return events.slice(-filter.lines);
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

function sanitizeObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return JSON.parse(sanitizeDiagnostic(JSON.stringify(value))) as Record<
    string,
    unknown
  >;
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
