import { lstat } from "node:fs/promises";
import { win32 } from "node:path";
import type { HostContext } from "../host-context.js";
import {
  readPrivateBytes,
  writePrivateAtomic,
} from "../prepare/private-files.js";
import {
  decodeHistory,
  encodeHistory,
  emptyHistory,
  HISTORY_MAX_BYTES,
  type HistoryRecord,
  type HistoryScope,
} from "./model.js";
export interface HistoryRead {
  state: "ready" | "recovery-required" | "unsupported" | "unavailable";
  record: HistoryRecord | null;
  errorCode: string | null;
}
export interface HistoryStore {
  read(scope: HistoryScope): Promise<HistoryRead>;
  write(scope: HistoryScope, record: HistoryRecord): Promise<void>;
  recover(scope: HistoryScope): Promise<HistoryRead>;
  clear(scope: HistoryScope): Promise<HistoryRead>;
}
export interface HistoryFilePort {
  read(path: string): Promise<Buffer | null>;
  write(path: string, bytes: Buffer): Promise<void>;
}
function path(scope: HistoryScope, name: string) {
  if (
    !/^[a-f0-9]{64}$/.test(scope.deviceKey) ||
    !/^[a-f0-9]{64}$/.test(scope.ownerKey)
  )
    throw new Error("HISTORY_SCOPE_INVALID");
  return `history\\${scope.ownerKey}\\${name}.json`;
}
/** Atomic primary + independently validated last-good copy; corrupt data is not silently reset. */
export class AtomicHistoryStore implements HistoryStore {
  constructor(private readonly files: HistoryFilePort) {}
  async read(scope: HistoryScope): Promise<HistoryRead> {
    try {
      const primary = await this.files.read(path(scope, "primary"));
      if (primary) {
        try {
          return {
            state: "ready",
            record: decodeHistory(primary, scope),
            errorCode: null,
          };
        } catch (e) {
          if (e instanceof Error && e.message === "HISTORY_VERSION_UNSUPPORTED")
            return { state: "unsupported", record: null, errorCode: e.message };
        }
      }
      const backup = await this.files.read(path(scope, "last-good"));
      if (backup) {
        try {
          return {
            state: "recovery-required",
            record: decodeHistory(backup, scope),
            errorCode: "HISTORY_RECOVERY_REQUIRED",
          };
        } catch {}
      }
      return primary || backup
        ? {
            state: "recovery-required",
            record: null,
            errorCode: "HISTORY_CORRUPT",
          }
        : { state: "ready", record: emptyHistory(scope), errorCode: null };
    } catch {
      return {
        state: "unavailable",
        record: null,
        errorCode: "HISTORY_STORAGE_UNAVAILABLE",
      };
    }
  }
  async write(scope: HistoryScope, record: HistoryRecord): Promise<void> {
    const bytes = encodeHistory(record);
    decodeHistory(bytes, scope);
    await this.files.write(path(scope, "primary"), bytes);
    // A backup failure cannot undo the committed primary or make a retry count twice.
    try {
      await this.files.write(path(scope, "last-good"), bytes);
    } catch {
      /* A current primary remains authoritative. */
    }
  }
  async recover(scope: HistoryScope): Promise<HistoryRead> {
    const read = await this.read(scope);
    if (read.state !== "recovery-required" || !read.record)
      throw new Error("HISTORY_RECOVERY_UNAVAILABLE");
    const damaged = await this.files.read(path(scope, "primary"));
    if (damaged)
      await this.files.write(path(scope, "recovery-original"), damaged);
    await this.write(scope, read.record);
    return this.read(scope);
  }
  async clear(scope: HistoryScope): Promise<HistoryRead> {
    const bytes = encodeHistory(emptyHistory(scope));
    // Explicit Clear removes the ledger and its recoverable copies. Write the
    // copies first so a completed clear cannot resurrect the previous history.
    await this.files.write(path(scope, "last-good"), bytes);
    await this.files.write(path(scope, "recovery-original"), bytes);
    await this.files.write(path(scope, "primary"), bytes);
    return this.read(scope);
  }
}
export class WindowsHistoryStore extends AtomicHistoryStore {
  constructor(host: HostContext) {
    super({
      read: async (relative) => {
        await host.directory(win32.dirname(relative));
        try {
          const stat = await lstat(win32.join(host.personalRoot, relative));
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.nlink !== 1 ||
            stat.size > HISTORY_MAX_BYTES
          )
            throw new Error("HISTORY_STORAGE_UNAVAILABLE");
        } catch (e) {
          if (
            e &&
            typeof e === "object" &&
            "code" in e &&
            e.code === "ENOENT"
          ) {
            await host.native.validatePath("personal", relative, "absent");
            return null;
          }
          throw e;
        }
        return readPrivateBytes(host, relative, HISTORY_MAX_BYTES);
      },
      write: (relative, bytes) => writePrivateAtomic(host, relative, bytes),
    });
  }
}
