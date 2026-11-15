import { constants, watch, type FSWatcher } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { win32 } from "node:path";
import { randomUUID } from "node:crypto";
import {
  parseLocalRuntimeStatus,
  type LocalRuntimeStatus,
} from "../../../../../worker/src/runtime/local-runtime-status.js";
import { sanitizeDiagnosticEvent } from "../../../../../worker/src/runtime/diagnostic-spool.js";
import {
  investigateJob,
  investigateErrors,
  explainError,
  type InvestigationSource,
} from "../../../../../worker/src/platform/shared/investigation.js";
import { buildPerformanceReport } from "../../../../../worker/src/platform/shared/performance-report.js";
import {
  parseSince,
  type OperationalEvent,
  type OperationalLogFilter,
} from "../../../../../worker/src/platform/shared/operational-logs.js";
import {
  sameConsumerProcess,
  processIdentityFromWire,
  processIdentityToWire,
  type WindowsConsumerNative,
  type ConsumerOwnedProcess,
} from "../../../../../worker/src/platform/windows/consumer-native.js";
import type { HostContext } from "../../host-context.js";
import { resolveQualifiedGpuIdentity } from "../../../../../worker/src/enrollment/report-builder.js";
import { MODEL } from "../../../../../chrome-extension/src/shared/local-model.js";
import { hashPrivateFile } from "../../prepare/private-files.js";
import type { SessionClient } from "../../session/control.js";
import { parseFleetTicket } from "../channel.js";
import { readActiveFleetIdentity } from "../active-runtime.js";
import type {
  FleetAdvancedFilter,
  FleetAdvancedRead,
} from "../../../shared/fleet-advanced-contracts.js";
import type { AdvancedReadySnapshot } from "./benchmark-runner.js";
import {
  StoreFleetAdvancedRuntime,
  type StoreAdvancedReadySnapshot,
} from "./store-runtime.js";
import type { FleetEnrollmentRecord } from "../store.js";
import { assertConsumerRelativePath } from "../../../../../worker/src/platform/windows/consumer-native-policy.js";
export interface FleetPrivateFiles {
  root: string;
  read(
    relative: string,
    maximum: number,
    appendOnly?: boolean,
  ): Promise<Buffer>;
  names(relative: string): Promise<string[]>;
}
/** Every read retains and verifies its descriptor, path identity and current-user ACL. */
export function createFleetPrivateFiles(
  native: Pick<WindowsConsumerNative, "validatePath">,
  root: string,
): FleetPrivateFiles {
  return {
    root,
    read: async (relative, maximum, appendOnly = false) => {
      assertConsumerRelativePath(relative);
      await lstat(win32.join(root, relative));
      await native.validatePath("fleet", relative, "file");
      const path = win32.join(root, relative),
        file = await open(
          path,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
      try {
        const before = await file.stat({ bigint: true });
        if (
          !before.isFile() ||
          before.nlink !== 1n ||
          before.size > BigInt(maximum) ||
          before.ino === 0n
        )
          throw new Error("ADVANCED_FILE_INVALID");
        const bytes = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < bytes.length) {
          const read = await file.read(
            bytes,
            offset,
            bytes.length - offset,
            offset,
          );
          if (!read.bytesRead) throw new Error("ADVANCED_FILE_CHANGED");
          offset += read.bytesRead;
        }
        await native.validatePath("fleet", relative, "file");
        const after = await file.stat({ bigint: true }),
          named = await lstat(path, { bigint: true });
        if (
          !named.isFile() ||
          named.isSymbolicLink() ||
          named.nlink !== 1n ||
          named.dev !== before.dev ||
          named.ino !== before.ino ||
          (!appendOnly &&
            (after.size !== before.size ||
              after.mtimeNs !== before.mtimeNs ||
              after.ctimeNs !== before.ctimeNs)) ||
          (appendOnly && after.size < before.size)
        )
          throw new Error("ADVANCED_FILE_CHANGED");
        return bytes;
      } finally {
        await file.close();
      }
    },
    names: async (relative) => {
      assertConsumerRelativePath(relative);
      await lstat(win32.join(root, relative));
      await native.validatePath("fleet", relative, "directory");
      const names = await readdir(win32.join(root, relative));
      if (names.length > 512) throw new Error("ADVANCED_FILE_LIMIT");
      return names;
    },
  };
}
function missing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
export class WindowsFleetInspection implements InvestigationSource {
  private watcher: FSWatcher | undefined;
  constructor(
    private readonly options: {
      host: HostContext;
      native?: Pick<WindowsConsumerNative, "isOwnedProcess">;
      storeRuntime?: StoreFleetAdvancedRuntime;
      files: FleetPrivateFiles;
      session: Pick<SessionClient, "command">;
      record(): Promise<FleetEnrollmentRecord>;
      ready(
        signal: AbortSignal,
      ): Promise<AdvancedReadySnapshot | StoreAdvancedReadySnapshot>;
      readyStatus(
        signal: AbortSignal,
      ): Promise<AdvancedReadySnapshot | StoreAdvancedReadySnapshot>;
      capacity(signal: AbortSignal): Promise<unknown>;
      now?: () => number;
    },
  ) {}
  readonly events = async (
    filter: OperationalLogFilter,
  ): Promise<OperationalEvent[]> => {
    if (
      !Number.isInteger(filter.lines) ||
      filter.lines < 1 ||
      filter.lines > 10000
    )
      throw new Error("ADVANCED_REQUEST_INVALID");
    let names: string[];
    try {
      names = await this.options.files.names("logs");
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    names = names
      .filter((name) => /^(?:events-\d{12}|events)\.jsonl$/u.test(name))
      .sort();
    if (names.length > 128) throw new Error("ADVANCED_FILE_LIMIT");
    const results: OperationalEvent[] = [];
    let total = 0;
    for (const name of names) {
      const bytes = await this.options.files.read(
        `logs\\${name}`,
        2 * 1024 ** 2,
        true,
      );
      total += bytes.length;
      if (total > 100 * 1024 ** 2) throw new Error("ADVANCED_FILE_LIMIT");
      for (const line of bytes.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > 8192)
          throw new Error("ADVANCED_FILE_INVALID");
        let raw: Record<string, unknown>;
        try {
          raw = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (
          !raw ||
          typeof raw.recordedAt !== "string" ||
          !Number.isFinite(Date.parse(raw.recordedAt)) ||
          !raw.event ||
          typeof raw.event !== "object" ||
          Array.isArray(raw.event)
        )
          continue;
        const event = sanitizeDiagnosticEvent(
            raw.event as Record<string, unknown>,
          ),
          kind = String(event.kind ?? ""),
          code = String(event.code ?? "");
        const level =
          /failed|unavailable|resource-blocked|report-deferred/u.test(kind) ||
          /failed|error|invalid/u.test(code)
            ? "error"
            : /stopped|recovered|drain|pause/u.test(kind)
              ? "warning"
              : "info";
        if (
          (filter.jobId !== undefined && event.jobId !== filter.jobId) ||
          (filter.attemptId !== undefined &&
            event.attemptId !== filter.attemptId) ||
          (filter.code !== undefined && event.code !== filter.code) ||
          (filter.since !== undefined &&
            Date.parse(raw.recordedAt) < filter.since) ||
          (filter.level !== undefined && level !== filter.level) ||
          (filter.errorsOnly && level !== "error")
        )
          continue;
        results.push({ recordedAt: raw.recordedAt, level, event });
        if (results.length > filter.lines) results.shift();
      }
    }
    return results;
  };
  readonly status = async (): Promise<LocalRuntimeStatus | null> => {
    try {
      return parseLocalRuntimeStatus(
        JSON.parse(
          (
            await this.options.files.read("state\\runtime-status.json", 16384)
          ).toString("utf8"),
        ),
      );
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  };
  private async current(status: LocalRuntimeStatus | null): Promise<boolean> {
    if (
      !status?.processId ||
      (this.options.now?.() ?? Date.now()) - Date.parse(status.updatedAt) >
        120000 ||
      Date.parse(status.updatedAt) > (this.options.now?.() ?? Date.now()) + 5000
    )
      return false;
    if (this.options.storeRuntime) {
      StoreFleetAdvancedRuntime.prototype.assertHost.call(
        this.options.storeRuntime,
        this.options.host,
      );
      return StoreFleetAdvancedRuntime.prototype.current.call(
        this.options.storeRuntime,
        status,
      );
    }
    if (!this.options.native) throw new Error("STORE_FLEET_ADVANCED_REQUIRED");
    const bytes = await this.options.host.native.vaultRead(
      "fleet",
      "fleet_ticket",
    );
    if (!bytes || bytes.length > 4096) return false;
    try {
      const raw = JSON.parse(bytes.toString("utf8")) as {
          owner: ConsumerOwnedProcess;
        },
        owner = raw.owner;
      if (
        !owner ||
        owner.role !== "fleet" ||
        owner.identity.pid !== status.processId ||
        owner.identity.sid !== this.options.host.identity.sid ||
        owner.identity.sessionId !== this.options.host.identity.sessionId
      )
        return false;
      owner.identity = processIdentityFromWire(
        processIdentityToWire(owner.identity),
      );
      const ticket = parseFleetTicket(raw, owner, this.options.now?.());
      const actual = await this.options.host.processIdentity(
        owner.identity.pid,
      );
      return (
        !!actual &&
        sameConsumerProcess(actual, owner.identity) &&
        (await this.options.native.isOwnedProcess(owner, ticket.server))
      );
    } catch {
      return false;
    }
  }
  async read(
    section: FleetAdvancedRead,
    filter: FleetAdvancedFilter,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const record = await this.options.record(),
      now = this.options.now?.() ?? Date.now();
    const since =
      filter.since === undefined
        ? now - 7 * 86400000
        : parseSince(filter.since, now);
    const layout = {
      workRoot: win32.join(this.options.files.root, "work"),
      runtimeStatusPath: win32.join(
        this.options.files.root,
        "state",
        "runtime-status.json",
      ),
    };
    if (section === "logs")
      return {
        scope: "retained-local-fleet-history",
        events: await this.events({
          lines: filter.lines ?? 200,
          since,
          ...(filter.level ? { level: filter.level } : {}),
          ...(filter.jobId ? { jobId: filter.jobId } : {}),
          ...(filter.attemptId ? { attemptId: filter.attemptId } : {}),
          ...(filter.code ? { code: filter.code } : {}),
          ...(filter.errorsOnly === undefined
            ? {}
            : { errorsOnly: filter.errorsOnly }),
        }),
      };
    if (section === "job")
      return investigateJob(layout, filter.jobId!, since, this);
    if (section === "errors")
      return investigateErrors(
        layout,
        since,
        filter.last ?? 50,
        undefined,
        this,
      );
    if (section === "explain") {
      const result = (await explainError(
        layout,
        filter.code!,
        since,
        this,
      )) as { nextSteps: string[] };
      // Present native consumer controls, not service/elevated CLI directions.
      return {
        ...result,
        nextSteps: result.nextSteps.map((step) =>
          step.replace(
            /mw (?:status --local|doctor --full|doctor|errors --since 1d|job <job-id>)/gu,
            "Open the corresponding Worker Advanced Status, Doctor, Errors or Job view",
          ),
        ),
      };
    }
    if (section === "performance") {
      const events = await this.events({
          lines: 10000,
          since,
          ...(filter.jobId ? { jobId: filter.jobId } : {}),
        }),
        status = await this.status();
      return buildPerformanceReport(events, {
        last: filter.last ?? 20,
        since,
        ...(filter.recipe ? { recipeId: filter.recipe } : {}),
        ...(filter.jobId ? { jobId: filter.jobId } : {}),
        incompleteHistory: status?.diagnostics?.incompleteHistory ?? true,
        truncatedByQueryLimit: events.length === 10000,
      });
    }
    if (section === "capacity") return this.options.capacity(signal);
    const status = await this.status(),
      session = await this.options.session.command(
        { version: 1, request_id: randomUUID(), action: "status" },
        signal,
      ),
      current = await this.current(status);
    if (section === "status")
      return {
        scope: "windows-user-fleet",
        savedIntent: session.fleet.intent,
        phase: session.fleet.phase,
        problem: session.fleet.problem,
        current,
        runtime: status,
        currentAttempts: current ? (status?.currentAttempts ?? []) : [],
        retainedHistory: !current,
        serverPolicy: {
          source: "runtime-cache",
          current: false,
          policy: status?.cachedPolicy ?? null,
        },
      };
    let ready: AdvancedReadySnapshot | StoreAdvancedReadySnapshot;
    try {
      ready = await (section === "doctor" && filter.full
        ? this.options.ready(signal)
        : this.options.readyStatus(signal));
    } catch {
      signal.throwIfAborted();
      if (section === "versions")
        return {
          installationProfile: "windows-user",
          ready: false,
          verifiedCurrentVersion: null,
          problem: "FLEET_PREPARE_REQUIRED",
          reportedAtEnrollment: {
            workerVersion: record.prepared.report.runtime.workerVersion,
            manifestSha256: record.prepared.manifestDigest,
            modelSha256: record.prepared.modelDigest,
            providerRuntimeVersion:
              record.prepared.report.runtime.providerRuntimeVersion,
          },
        };
      return {
        schemaVersion: 1,
        depth: filter.full ? "full" : "quick",
        healthy: false,
        checks: [
          {
            name: "owned-runtime",
            status: current ? "passed" : "warning",
            code: current ? "OK" : "RUNTIME_NOT_CURRENT",
          },
          {
            name: "runtime-and-model-ready",
            status: "failed",
            code: "FLEET_PREPARE_REQUIRED",
          },
          {
            name: "live-directml-inference",
            status: "not-run",
            code: "RUN_EXPLICIT_GUARDED_BENCHMARK",
          },
        ],
        current,
        retainedHistory: status?.diagnostics ?? null,
      };
    }
    let activeBinding = false;
    try {
      if (this.options.storeRuntime) {
        await StoreFleetAdvancedRuntime.prototype.active.call(
          this.options.storeRuntime,
          record,
          signal,
        );
      } else {
        if (ready.archiveSha256 === null)
          throw new Error("STORE_FLEET_ADVANCED_REQUIRED");
        await readActiveFleetIdentity(this.options.host.native, record, {
          release: ready.release,
          manifestDigest: ready.manifestSha256,
          archiveDigest: ready.archiveSha256,
          modelDigest: ready.modelSha256,
        });
      }
      activeBinding = true;
    } catch {
      /* A stale overlay is not current fleet readiness. */
    }
    if (section === "versions")
      return {
        installationProfile: "windows-user",
        release: ready.release,
        runtimeVersion: ready.releaseVersion,
        manifestSha256: ready.manifestSha256,
        modelSha256: ready.modelSha256,
        enrolledManifestSha256: record.prepared.manifestDigest,
        driverVersion: ready.evidence.gpuIdentity?.driverVersion ?? null,
        runtime: ready.evidence.runtimeDiagnostics,
        preparedMatchesEnrollment:
          ready.manifestSha256 === record.prepared.manifestDigest,
        activeFleetBinding: activeBinding,
      };
    let gpuCurrent = false;
    try {
      if (ready.evidence.gpuIdentity) {
        resolveQualifiedGpuIdentity(
          ready.evidence.gpuIdentity,
          await this.options.host.native.enumerateGpus(),
        );
        gpuCurrent = true;
      }
    } catch {
      /* A current driver mismatch requires qualification; it is never a passed check. */
    }
    if (
      filter.full &&
      (await hashPrivateFile(
        this.options.host,
        `models\\${MODEL.filename}`,
        MODEL.bytes,
        signal,
      )) !== MODEL.sha256
    )
      throw new Error("ADVANCED_MODEL_INVALID");
    return {
      schemaVersion: 1,
      depth: filter.full ? "full" : "quick",
      healthy:
        current &&
        gpuCurrent &&
        session.fleet.problem === null &&
        activeBinding,
      checks: [
        { name: "current-user", status: "passed", code: "OK" },
        {
          name: "owned-runtime",
          status: current ? "passed" : "warning",
          code: current ? "OK" : "RUNTIME_NOT_CURRENT",
        },
        { name: "signed-inventory", status: "passed", code: "OK" },
        {
          name: "qualified-physical-gpu",
          status: gpuCurrent ? "passed" : "failed",
          code: gpuCurrent ? "OK" : "GPU_REQUALIFICATION_REQUIRED",
        },
        {
          name: "model-receipt",
          status: "passed",
          code: "READY_RECEIPT_VERIFIED",
        },
        {
          name: "fleet-runtime-binding",
          status: activeBinding ? "passed" : "failed",
          code: activeBinding ? "OK" : "FLEET_PREPARE_REQUIRED",
        },
        {
          name: "live-directml-inference",
          status: "not-run",
          code: "RUN_EXPLICIT_GUARDED_BENCHMARK",
        },
      ],
      activeAttempts: current ? (status?.activeAttemptIds.length ?? 0) : null,
      retainedHistory: status?.diagnostics ?? null,
    };
  }
  /** Directory notifications re-read local publications; no recurring HTTP/status timer. */
  async watch(
    onChanged: () => void,
    onError: (code: string) => void,
  ): Promise<void> {
    if (this.watcher) return;
    await this.options.host.native.validatePath("fleet", "", "directory");
    const watcher = watch(
      this.options.files.root,
      { recursive: true },
      (_event, name) => {
        if (
          name &&
          /^(?:logs[\\/](?:events(?:-\d{12})?\.jsonl|history\.json)|state[\\/]runtime-status\.json)$/u.test(
            String(name),
          )
        )
          onChanged();
      },
    );
    watcher.on("error", () => {
      watcher.close();
      if (this.watcher === watcher) this.watcher = undefined;
      onError("ADVANCED_WATCH_UNAVAILABLE");
    });
    this.watcher = watcher;
  }
  close(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }
}
