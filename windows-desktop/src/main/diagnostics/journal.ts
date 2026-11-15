import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { win32 } from "node:path";
import type { HostContext } from "../host-context.js";
import { writePrivateAtomic } from "../prepare/private-files.js";
import type {
  WindowsDiagnosticIdentity,
  WindowsDiagnosticEvent,
  WindowsDiagnosticReport,
} from "../../shared/diagnostics-contracts.js";
import {
  diagnosticReport,
  parseDiagnosticIdentity,
  parseDiagnosticRecord,
  projectDiagnosticInput,
} from "./projection.js";
const FILES = 4,
  SEGMENT = 256 * 1024,
  EVENT = 4096;
interface Retained {
  segments: Buffer[];
  events: WindowsDiagnosticEvent[];
  malformed: number;
  recovered: number;
  incomplete: boolean;
  bytes: number;
}
/** Fixed current-user files, serialized writers and native cache authority; never owns media or fleet logs. */
export class WindowsDiagnosticJournal {
  private readonly identity: WindowsDiagnosticIdentity;
  private readonly session = randomUUID();
  private lane: Promise<unknown> = Promise.resolve();
  private closing = false;
  private failedWrites = 0;
  private reportedFailedWrites = 0;
  private failure: string | null = null;
  private pending = 0;
  private readonly activityListeners = new Set<() => void>();
  constructor(
    private readonly host: HostContext,
    identity: WindowsDiagnosticIdentity,
    private readonly options: {
      now?: () => number;
      segmentBytes?: number;
    } = {},
  ) {
    this.identity = parseDiagnosticIdentity(identity);
    if (
      options.segmentBytes !== undefined &&
      (!Number.isSafeInteger(options.segmentBytes) ||
        options.segmentBytes < 4096 ||
        options.segmentBytes > SEGMENT)
    )
      throw new Error("DIAGNOSTICS_QUOTA_INVALID");
  }
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.pending >= 64)
      return Promise.reject(new Error("DIAGNOSTICS_BUSY"));
    this.pending++;
    this.changed();
    const result = this.lane.then(task).finally(() => {
      this.pending--;
      this.changed();
    });
    this.lane = result.catch(() => {});
    return result;
  }
  activity() {
    return { pending: this.pending, idle: this.pending === 0 };
  }
  subscribeActivity(listener: () => void) {
    this.activityListeners.add(listener);
    listener();
    return () => {
      this.activityListeners.delete(listener);
    };
  }
  private changed() {
    for (const listener of this.activityListeners)
      try {
        listener();
      } catch {
        /* Diagnostics observers do not own disk writes. */
      }
  }
  private relative(index: number) {
    return `diagnostics\\events-${index}.jsonl`;
  }
  private get maximum() {
    return this.options.segmentBytes ?? SEGMENT;
  }
  private async locked<T>(action: () => Promise<T>): Promise<T> {
    const lease = await this.host.native.acquireMutex("cache");
    if (!lease) throw new Error("DIAGNOSTICS_BUSY");
    try {
      if (
        lease.scope !== "cache" ||
        lease.abandoned ||
        lease.identity.sid !== this.host.identity.sid ||
        lease.identity.sessionId !== this.host.identity.sessionId
      )
        throw new Error("DIAGNOSTICS_STORAGE_UNSAFE");
      return await action();
    } finally {
      await this.host.native.releaseMutex(lease);
    }
  }
  private async read(index: number): Promise<Buffer> {
    const relative = this.relative(index),
      path = win32.join(this.host.personalRoot, relative);
    let file: FileHandle | undefined;
    try {
      const named = await lstat(path, { bigint: true });
      if (
        !named.isFile() ||
        named.isSymbolicLink() ||
        named.nlink !== 1n ||
        named.size > BigInt(this.maximum)
      )
        throw new Error("DIAGNOSTICS_STORAGE_UNSAFE");
      await this.host.native.validatePath("personal", relative, "file");
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const before = await file.stat({ bigint: true });
      const same = (v: typeof named) =>
        v.dev === before.dev &&
        v.ino === before.ino &&
        v.size === before.size &&
        v.mtimeNs === before.mtimeNs &&
        v.ctimeNs === before.ctimeNs &&
        v.nlink === 1n &&
        !v.isSymbolicLink();
      if (!same(named)) throw new Error("DIAGNOSTICS_STORAGE_UNSAFE");
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const read = await file.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (!read.bytesRead) throw new Error("DIAGNOSTICS_STORAGE_UNSAFE");
        offset += read.bytesRead;
      }
      if (
        !same(await file.stat({ bigint: true })) ||
        !same(await lstat(path, { bigint: true }))
      )
        throw new Error("DIAGNOSTICS_STORAGE_UNSAFE");
      await this.host.native.validatePath("personal", relative, "file");
      return bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.host.native.validatePath("personal", relative, "absent");
        return Buffer.alloc(0);
      }
      throw error;
    } finally {
      await file?.close();
    }
  }
  private async retained(): Promise<Retained> {
    try {
      await lstat(win32.join(this.host.personalRoot, "diagnostics"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.host.native.validatePath("personal", "diagnostics", "absent");
      return {
        segments: Array.from({ length: FILES }, () => Buffer.alloc(0)),
        events: [],
        malformed: 0,
        recovered: 0,
        incomplete: false,
        bytes: 0,
      };
    }
    await this.host.native.validatePath("personal", "diagnostics", "directory");
    const segments: Buffer[] = [],
      events: WindowsDiagnosticEvent[] = [],
      seen = new Set<number>();
    let malformed = 0,
      recovered = 0,
      retainedBytes = 0,
      incomplete = false;
    for (let index = FILES - 1; index >= 0; index--) {
      const bytes = await this.read(index);
      retainedBytes += bytes.length;
      const accepted: Buffer[] = [];
      const end = bytes.lastIndexOf(10);
      if (bytes.length && end !== bytes.length - 1) {
        recovered += bytes.length - end - 1;
        incomplete = true;
      }
      for (const line of bytes
        .subarray(0, end + 1)
        .toString("utf8")
        .split("\n")) {
        if (!line) continue;
        try {
          if (Buffer.byteLength(line) > EVENT) throw new Error();
          const event = parseDiagnosticRecord(JSON.parse(line));
          if (seen.has(event.sequence)) {
            incomplete = true;
            continue;
          }
          seen.add(event.sequence);
          events.push(event);
          accepted.push(Buffer.from(JSON.stringify(event) + "\n"));
        } catch {
          malformed++;
          incomplete = true;
        }
      }
      segments[index] = Buffer.concat(accepted);
    }
    events.sort((a, b) => a.sequence - b.sequence);
    if (events[0]?.sequence !== undefined && events[0].sequence !== 1)
      incomplete = true;
    for (let i = 1; i < events.length; i++)
      if (events[i]!.sequence !== events[i - 1]!.sequence + 1)
        incomplete = true;
    return {
      segments,
      events,
      malformed,
      recovered,
      incomplete,
      bytes: retainedBytes,
    };
  }
  async record(input: unknown, verifiedModelSha256?: string): Promise<boolean> {
    if (this.closing) return false;
    if (this.pending >= 64) {
      this.failedWrites++;
      this.failure = "DIAGNOSTICS_WRITE_FAILED";
      return false;
    }
    const projection = projectDiagnosticInput(input);
    return this.enqueue(async () => {
      try {
        return await this.locked(async () => {
          await this.host.directory("diagnostics");
          const old = await this.retained(),
            event: WindowsDiagnosticEvent = {
              version: 1,
              session: this.session,
              sequence: (old.events.at(-1)?.sequence ?? 0) + 1,
              at: new Date(this.options.now?.() ?? Date.now()).toISOString(),
              identity: this.identity,
              rejectedFields: projection.rejected,
              ...projection.input,
              ...(verifiedModelSha256 === undefined
                ? {}
                : { verifiedModelSha256 }),
            };
          const records: WindowsDiagnosticEvent[] = [];
          const { verifiedModelSha256: _verified, ...recovery } = event;
          if (this.failedWrites > this.reportedFailedWrites) {
            records.push({
              ...recovery,
              sequence: event.sequence,
              event: "recovered",
              subsystem: "lifecycle",
              severity: "warning",
              code: "DIAGNOSTICS_WRITE_FAILED",
              phase: "recovery",
              job: null,
              rejectedFields: 0,
              metrics: {
                failed_writes: this.failedWrites - this.reportedFailedWrites,
              },
            });
            event.sequence++;
          }
          if (old.malformed || old.recovered) {
            records.push({
              ...recovery,
              sequence: event.sequence,
              event: "recovered",
              subsystem: "lifecycle",
              severity: "warning",
              code: "DIAGNOSTICS_RECOVERED",
              phase: "recovery",
              job: null,
              rejectedFields: 0,
              metrics: {
                malformed_records: old.malformed,
                recovered_tail_bytes: old.recovered,
              },
            });
            event.sequence++;
          }
          records.push(event);
          const lines = records.map((record) =>
            Buffer.from(JSON.stringify(parseDiagnosticRecord(record)) + "\n"),
          );
          if (lines.some((line) => line.length > EVENT))
            throw new Error("DIAGNOSTICS_EVENT_TOO_LARGE");
          let latest = old.segments[0]!;
          for (const line of lines) {
            if (latest.length + line.length > this.maximum) {
              for (let i = FILES - 1; i > 0; i--) {
                await writePrivateAtomic(
                  this.host,
                  this.relative(i),
                  old.segments[i - 1]!,
                );
                old.segments[i] = old.segments[i - 1]!;
              }
              latest = Buffer.alloc(0);
            }
            latest = Buffer.concat([latest, line]);
            await writePrivateAtomic(this.host, this.relative(0), latest);
            old.segments[0] = latest;
          }
          this.failure = null;
          this.reportedFailedWrites = this.failedWrites;
          return true;
        });
      } catch {
        this.failedWrites++;
        this.failure = "DIAGNOSTICS_WRITE_FAILED";
        return false;
      }
    });
  }
  snapshot(full = false): Promise<WindowsDiagnosticReport> {
    return this.enqueue(async () => {
      let old: Retained = {
        segments: [],
        events: [],
        malformed: 0,
        recovered: 0,
        incomplete: true,
        bytes: 0,
      };
      try {
        old = await this.locked(() => this.retained());
      } catch {
        this.failure = "DIAGNOSTICS_STORAGE_UNSAFE";
      }
      return diagnosticReport({
        events: old.events,
        identity: this.identity,
        now: this.options.now?.() ?? Date.now(),
        availability: this.failure
          ? "unavailable"
          : this.closing
            ? "closed"
            : old.events.length
              ? "available"
              : "no-logs",
        failureCode: this.failure,
        malformed: old.malformed,
        recovered: old.recovered,
        rejected: old.events.reduce((n, e) => n + e.rejectedFields, 0),
        failedWrites: this.failedWrites,
        retained: old.bytes,
        maximum: this.maximum * FILES,
        incomplete: old.incomplete,
        full,
      });
    });
  }
  clear(): Promise<void> {
    return this.enqueue(() =>
      this.locked(async () => {
        if (this.closing) throw new Error("DIAGNOSTICS_CLOSED");
        const old = await this.retained();
        if (!old.bytes && !old.events.length) {
          this.failedWrites = 0;
          this.reportedFailedWrites = 0;
          this.failure = null;
          return;
        }
        try {
          for (let i = FILES - 1; i >= 0; i--)
            await writePrivateAtomic(
              this.host,
              this.relative(i),
              Buffer.alloc(0),
            );
          this.failedWrites = 0;
          this.reportedFailedWrites = 0;
          this.failure = null;
        } catch {
          this.failedWrites++;
          this.failure = "DIAGNOSTICS_WRITE_FAILED";
          throw new Error("DIAGNOSTICS_CLEAR_FAILED");
        }
      }),
    );
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.lane;
  }
}
