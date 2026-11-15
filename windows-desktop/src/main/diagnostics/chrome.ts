import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, type FileHandle } from "node:fs/promises";
import { win32 } from "node:path";
import type { HostContext } from "../host-context.js";
import type { WindowsDiagnosticJournal } from "./journal.js";
import type { StoragePartialWriteAdmission } from "../storage/partial-write-policy.js";
import { storageBirth } from "../storage/write-journal.js";
import { sameConsumerProcess } from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  chromeDiagnosticSummary,
  parseChromeDiagnosticReport,
  type ChromeDiagnosticExport,
} from "./browser-report.js";
import { DIAGNOSTIC_UUID } from "../../shared/diagnostics-contracts.js";
import {
  CHROME_REPORT_KEY as KEY,
  CHROME_REPORT_ROOT as ROOT,
  parseChromeReportRegistry as parseRegistry,
  readChromeReportRegistry,
  type ChromeReportRegistry as Registry,
  type SavedChromeReport as Saved,
} from "./report-registry.js";
export interface WindowsChromeDiagnosticsOptions {
  host: HostContext;
  journal: Pick<WindowsDiagnosticJournal, "snapshot">;
  storage: StoragePartialWriteAdmission;
  /** Trusted Main OS sink, invoked only after exact private-file proof. Never exposed to Chrome. */
  reveal(path: string): Promise<void>;
}
/** Current-SID personal report registry; no model, worker, account token or Prepare dependency. */
export class WindowsChromeDiagnostics {
  private readonly abort = new AbortController();
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private closed = false;
  private closing: Promise<void> | undefined;
  private cleanupUncertain = false;
  private registry: Registry;
  private readonly listeners = new Set<() => void>();
  private readonly saved = new Set<(receipt: string) => void>();
  constructor(private readonly options: WindowsChromeDiagnosticsOptions) {
    this.registry = {
      version: 1,
      sid: options.host.identity.sid,
      reports: [],
      retired: [],
    };
  }
  activity() {
    const retained =
      this.registry.reports.filter((row) => row.state === "deleting").length +
      Number(this.cleanupUncertain);
    return {
      pending: this.pending,
      retained,
      idle: this.pending === 0 && retained === 0,
    };
  }
  subscribeActivity(listener: () => void) {
    this.listeners.add(listener);
    listener();
    return () => {
      this.listeners.delete(listener);
    };
  }
  subscribeSaved(listener: (receipt: string) => void) {
    this.saved.add(listener);
    const receipt = this.latestReceipt();
    if (receipt) listener(receipt);
    return () => {
      this.saved.delete(listener);
    };
  }
  latestReceipt(): string | null {
    return (
      this.registry.reports.filter((r) => r.state === "ready").at(-1)
        ?.receipt ?? null
    );
  }
  owns(receipt: string): boolean {
    return (
      this.registry.reports.some((r) => r.receipt === receipt) ||
      this.registry.retired.some((r) => r.receipt === receipt)
    );
  }
  private changed() {
    for (const listener of this.listeners)
      try {
        listener();
      } catch {}
  }
  private exported(receipt: string) {
    for (const listener of this.saved)
      try {
        listener(receipt);
      } catch {}
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("DIAGNOSTICS_CLOSED"));
    if (this.pending >= 4) return Promise.reject(new Error("DIAGNOSTICS_BUSY"));
    this.pending++;
    this.changed();
    const promise = this.tail
      .then(() => {
        if (this.closed) throw new Error("DIAGNOSTICS_CLOSED");
        return work();
      })
      .finally(() => {
        this.pending--;
        this.changed();
      });
    this.tail = promise.catch(() => undefined);
    return promise;
  }
  private canonical(row: Saved) {
    return `${ROOT}\\${row.receipt}.json`;
  }
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    const native = this.options.host.native,
      lease = await native.acquireMutex("cache");
    if (
      !lease ||
      lease.abandoned ||
      lease.scope !== "cache" ||
      !sameConsumerProcess(lease.identity, this.options.host.identity)
    ) {
      if (lease) await native.releaseMutex(lease);
      throw new Error("DIAGNOSTICS_BUSY");
    }
    try {
      return await work();
    } finally {
      await native.releaseMutex(lease);
    }
  }
  private async read(): Promise<Registry> {
    return readChromeReportRegistry(this.options.host);
  }
  private async write(registry: Registry): Promise<void> {
    const bytes = Buffer.from(
      JSON.stringify(parseRegistry(registry, this.options.host.identity.sid)),
    );
    try {
      if (bytes.length > 16384)
        throw new Error("DIAGNOSTICS_REPORT_STATE_INVALID");
      await this.options.host.native.vaultWrite("account", KEY, bytes);
      this.registry = structuredClone(registry);
    } finally {
      bytes.fill(0);
    }
  }
  private async exists(relative: string): Promise<boolean> {
    try {
      await lstat(win32.join(this.options.host.personalRoot, relative));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.options.host.native.validatePath(
        "personal",
        relative,
        "absent",
      );
      return false;
    }
  }
  private async bytes(
    row: Saved,
    relative: string,
    staged = false,
  ): Promise<Buffer> {
    const host = this.options.host;
    await host.native.validatePath("personal", relative, "file");
    const file = await open(
      win32.join(host.personalRoot, relative),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const before = await file.stat({ bigint: true }),
        p = row.proof;
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        String(before.dev) !== p.device ||
        String(before.ino) !== p.fileId ||
        String(before.birthtimeNs) !== p.bornAt ||
        before.size !== BigInt(p.bytes) ||
        (!staged &&
          (String(before.mtimeNs) !== p.writtenAt ||
            String(before.ctimeNs) !== p.changedAt))
      )
        throw new Error("DIAGNOSTICS_REPORT_CHANGED");
      const bytes = Buffer.alloc(p.bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const r = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!r.bytesRead) throw new Error("DIAGNOSTICS_REPORT_CHANGED");
        offset += r.bytesRead;
      }
      const after = await file.stat({ bigint: true }),
        named = await lstat(win32.join(host.personalRoot, relative), {
          bigint: true,
        });
      if (
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs ||
        !named.isFile() ||
        named.isSymbolicLink() ||
        named.dev !== before.dev ||
        named.ino !== before.ino ||
        named.birthtimeNs !== before.birthtimeNs ||
        named.nlink !== 1n ||
        named.size !== before.size ||
        named.mtimeNs !== after.mtimeNs ||
        named.ctimeNs !== after.ctimeNs ||
        createHash("sha256").update(bytes).digest("hex") !== p.sha256
      )
        throw new Error("DIAGNOSTICS_REPORT_CHANGED");
      parseChromeDiagnosticReport(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      return bytes;
    } finally {
      await file.close();
    }
  }
  private async recover(
    registry: Registry,
    cleanupOnly = false,
  ): Promise<void> {
    this.registry = structuredClone(registry);
    if (this.cleanupUncertain) {
      if (!this.options.host.native.recoverPersonalCleanups)
        throw new Error("DIAGNOSTICS_BUSY");
      await this.options.host.native.recoverPersonalCleanups();
      this.cleanupUncertain = false;
    }
    // Recovery removes deleting rows; snapshot the iteration to avoid skipping the next record.
    for (const row of registry.reports.slice()) {
      const canonical = this.canonical(row);
      if (row.state === "ready") {
        if (!cleanupOnly) await this.bytes(row, canonical);
        continue;
      }
      if (row.state === "deleting") {
        const native = this.options.host.native;
        this.cleanupUncertain = true;
        if (
          !native.removeChromeDiagnosticReport ||
          (await native.removeChromeDiagnosticReport(row.receipt)) !==
            "completed"
        )
          throw new Error("DIAGNOSTICS_BUSY");
        registry.reports.splice(registry.reports.indexOf(row), 1);
        registry.retired.push({
          requestId: row.requestId,
          receipt: row.receipt,
        });
        registry.retired = registry.retired.slice(-64);
        await this.write(registry);
        if (!native.recoverPersonalCleanups)
          throw new Error("DIAGNOSTICS_BUSY");
        await native.recoverPersonalCleanups();
        this.cleanupUncertain = false;
        continue;
      }
      if (cleanupOnly) continue;
      if (!(await this.exists(canonical))) {
        await this.bytes(row, row.temporary, true);
        await this.options.host.native.validatePath(
          "personal",
          canonical,
          "absent",
        );
        await rename(
          win32.join(this.options.host.personalRoot, row.temporary),
          win32.join(this.options.host.personalRoot, canonical),
        );
      }
      await this.bytes(row, canonical, true);
      const stat = await lstat(
        win32.join(this.options.host.personalRoot, canonical),
        { bigint: true },
      );
      row.proof.writtenAt = String(stat.mtimeNs);
      row.proof.changedAt = String(stat.ctimeNs);
      row.state = "ready";
      await this.write(registry);
    }
    this.registry = structuredClone(registry);
  }
  initialize(): Promise<void> {
    return this.serial(() =>
      this.locked(async () => {
        await this.recover(await this.read());
      }),
    );
  }
  exportReport(
    requestId: string,
    signal: AbortSignal,
  ): Promise<ChromeDiagnosticExport> {
    if (!DIAGNOSTIC_UUID.test(requestId))
      return Promise.reject(new Error("DIAGNOSTICS_REQUEST_INVALID"));
    const current = AbortSignal.any([signal, this.abort.signal]);
    return this.serial(async () => {
      current.throwIfAborted();
      const old = await this.locked(async () => {
        const registry = await this.read();
        await this.recover(registry);
        return registry.reports.find((r) => r.requestId === requestId);
      });
      if (old) {
        const report = await this.locked(async () =>
          chromeDiagnosticSummary(
            JSON.parse(
              (await this.bytes(old, this.canonical(old))).toString("utf8"),
            ),
          ),
        );
        current.throwIfAborted();
        this.exported(old.receipt);
        return { report, receipt: old.receipt };
      }
      if (this.registry.retired.some((r) => r.requestId === requestId))
        throw new Error("DIAGNOSTICS_REPORT_MISSING");
      const full = parseChromeDiagnosticReport(
          await this.options.journal.snapshot(true),
        ),
        report = chromeDiagnosticSummary(full),
        bytes = Buffer.from(JSON.stringify(full)),
        receipt = randomUUID(),
        canonical = `${ROOT}\\${receipt}.json`,
        temporary = `${canonical}.${requestId}.tmp`;
      current.throwIfAborted();
      await this.options.host.directory(ROOT);
      await this.options.storage.recoverPartialWrites(canonical, current);
      const lease = await this.options.storage.beginPartialWrite(
        temporary,
        bytes.length,
      );
      let file: FileHandle | undefined,
        settled = false;
      try {
        current.throwIfAborted();
        await this.options.host.native.validatePath(
          "personal",
          temporary,
          "absent",
        );
        file = await open(
          win32.join(this.options.host.personalRoot, temporary),
          "wx",
          0o600,
        );
        await lease.captureCreated(
          storageBirth(await file.stat({ bigint: true })),
        );
        current.throwIfAborted();
        await file.writeFile(bytes);
        await file.sync();
        const stat = await file.stat({ bigint: true }),
          row: Saved = {
            requestId,
            receipt,
            temporary,
            state: "staged",
            proof: {
              ...storageBirth(stat),
              writtenAt: String(stat.mtimeNs),
              changedAt: String(stat.ctimeNs),
              bytes: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          };
        await file.close();
        file = undefined;
        current.throwIfAborted();
        await this.locked(async () => {
          const registry = await this.read();
          await this.recover(registry);
          if (registry.reports.some((r) => r.requestId === requestId))
            throw new Error("DIAGNOSTICS_BUSY");
          if (registry.reports.length >= 4) {
            const oldest = registry.reports[0]!;
            await this.bytes(oldest, this.canonical(oldest));
            oldest.state = "deleting";
            await this.write(registry);
            await this.recover(registry);
          }
          registry.reports.push(row);
          await this.write(registry);
          await this.recover(registry);
        });
        await lease.settle();
        settled = true;
        current.throwIfAborted();
        this.exported(receipt);
        return { report, receipt };
      } finally {
        try {
          await file?.close();
          if (!settled) await lease.settle();
        } finally {
          bytes.fill(0);
        }
      }
    });
  }
  show(receipt: string): Promise<void> {
    return this.serial(() =>
      this.locked(async () => {
        if (!DIAGNOSTIC_UUID.test(receipt))
          throw new Error("DIAGNOSTICS_REPORT_MISSING");
        const registry = await this.read();
        await this.recover(registry);
        const row = registry.reports.find(
          (r) => r.receipt === receipt && r.state === "ready",
        );
        if (!row) throw new Error("DIAGNOSTICS_REPORT_MISSING");
        await this.bytes(row, this.canonical(row));
        await this.options.host.native.validatePath(
          "personal",
          this.canonical(row),
          "file",
        );
        await this.options.reveal(
          win32.join(this.options.host.personalRoot, this.canonical(row)),
        );
      }),
    );
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.abort.abort(new Error("DIAGNOSTICS_CLOSED"));
    let cleaned = false;
    const task = this.tail
      .then(async () => {
        await this.locked(async () => this.recover(await this.read(), true));
        if (!this.activity().idle) throw new Error("DIAGNOSTICS_BUSY");
        this.listeners.clear();
        this.saved.clear();
        cleaned = true;
      })
      .catch((error) => {
        this.cleanupUncertain = true;
        this.changed();
        throw error;
      })
      .finally(() => {
        if (this.closing === task && !cleaned) this.closing = undefined;
      });
    this.closing = task;
    return task;
  }
}
export async function createWindowsChromeDiagnostics(
  options: WindowsChromeDiagnosticsOptions,
): Promise<WindowsChromeDiagnostics> {
  const value = new WindowsChromeDiagnostics(options);
  await value.initialize();
  return value;
}
