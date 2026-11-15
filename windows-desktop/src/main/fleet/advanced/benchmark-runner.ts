import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { statfs } from "node:fs/promises";
import {
  createConsumerNativeTransport,
  WindowsConsumerNative,
  sameConsumerProcess,
  type ConsumerOwnedProcess,
  type ConsumerGpuLease,
} from "../../../../../worker/src/platform/windows/consumer-native.js";
import { resolveQualifiedGpuIdentity } from "../../../../../worker/src/enrollment/report-builder.js";
import type { HostContext } from "../../host-context.js";
import type { WindowsPreparationOperations } from "../../prepare/operations.js";
import {
  readPrivateBytes,
  writePrivateAtomic,
} from "../../prepare/private-files.js";
import {
  parseAdvancedBenchmarkConfiguration,
  validateAdvancedBenchmarkReport,
  type AdvancedBenchmarkConfiguration,
} from "./benchmark-child.js";

export type AdvancedReadySnapshot = Awaited<
  ReturnType<WindowsPreparationOperations["snapshotReady"]>
>;
export type AdvancedBenchmarkGuardian = Pick<
  WindowsConsumerNative,
  | "identity"
  | "bootIdentity"
  | "legacyWorkerConflict"
  | "enumerateGpus"
  | "acquireGpuGuard"
  | "releaseGpuGuard"
  | "launchOwned"
  | "stopOwned"
  | "onEvent"
  | "onClosed"
  | "close"
>;
export interface BenchmarkOwnershipJournal {
  version: 1;
  transaction: string;
  requestId: string;
  release: string;
  phase: "staging" | "launching" | "owned" | "exited";
  owner: ConsumerOwnedProcess | null;
}
export interface AdvancedBenchmarkRunnerOptions {
  host: HostContext;
  ready(signal: AbortSignal): Promise<AdvancedReadySnapshot>;
  ownership: {
    read(): Promise<BenchmarkOwnershipJournal | null>;
    write(value: BenchmarkOwnershipJournal): Promise<void>;
  };
  guardian?(
    snapshot: AdvancedReadySnapshot,
  ): Promise<AdvancedBenchmarkGuardian>;
  result?(relativePath: string): Promise<unknown>;
  publishConfiguration?(
    configuration: AdvancedBenchmarkConfiguration,
  ): Promise<void>;
  beforeLaunch?(configuration: AdvancedBenchmarkConfiguration): Promise<void>;
  trackWorkspace?(
    configuration: AdvancedBenchmarkConfiguration,
    owner: ConsumerOwnedProcess,
  ): Promise<{ release(): Promise<void> }>;
  timeoutMs?: number;
  checkStorage?(): Promise<void>;
}
/** The physical guard covers all Python cohort/FFmpeg descendants, including cancellation. */
export class WindowsAdvancedBenchmarkRunner {
  private running = false;
  private current: {
    guardian: AdvancedBenchmarkGuardian;
    owner: ConsumerOwnedProcess;
  } | null = null;
  constructor(private readonly options: AdvancedBenchmarkRunnerOptions) {}
  async run(
    transaction: string,
    input: {
      operation: AdvancedBenchmarkConfiguration["operation"];
      requestId?: string;
      fixture: AdvancedBenchmarkConfiguration["fixture"];
      recipe: AdvancedBenchmarkConfiguration["recipe"];
      warmupRuns: number;
      measuredRuns: number;
      groupSize?: 1;
      candidate?: AdvancedBenchmarkConfiguration["candidate"];
      saveAudio?: boolean;
    },
    signal: AbortSignal,
  ) {
    if (this.running) throw new Error("ADVANCED_BUSY");
    this.running = true;
    let guardian: AdvancedBenchmarkGuardian | undefined,
      guard: ConsumerGpuLease | null = null,
      owner: ConsumerOwnedProcess | undefined;
    let unsubscribe = () => {},
      unclosed = () => {},
      cancel = () => {},
      timer: NodeJS.Timeout | undefined;
    let ownedJournal: BenchmarkOwnershipJournal | undefined,
      lease: { release(): Promise<void> } | null = null;
    let stopped = true;
    let workspace: { release(): Promise<void> } | undefined;
    try {
      signal.throwIfAborted();
      const ready = await this.options.ready(signal);
      lease = await this.options.host.prepareLease({
        sid: this.options.host.identity.sid,
        identity: ready.release,
      });
      if (!lease) throw new Error("ADVANCED_BUSY");
      const recheck = await this.options.ready(signal);
      if (
        ready.release !== recheck.release ||
        ready.manifestSha256 !== recheck.manifestSha256 ||
        ready.nativeSha256 !== recheck.nativeSha256 ||
        ready.bootIdentity !== recheck.bootIdentity
      )
        throw new Error("ADVANCED_RUNTIME_CHANGED");
      if (this.options.checkStorage) await this.options.checkStorage();
      else {
        await this.options.host.native.validatePath(
          "personal",
          "",
          "directory",
        );
        const free = await statfs(this.options.host.personalRoot, {
          bigint: true,
        });
        if (free.bavail * free.bsize < BigInt(3 * 1024 ** 3))
          throw new Error("DISK_SPACE_LOW");
      }
      guardian = await (this.options.guardian?.(ready) ??
        this.openGuardian(ready));
      const identity = await guardian.identity();
      if ((await guardian.bootIdentity()) !== ready.bootIdentity)
        throw new Error("ADVANCED_GPU_REQUALIFICATION_REQUIRED");
      if (
        identity.sid !== this.options.host.identity.sid ||
        identity.sessionId !== this.options.host.identity.sessionId ||
        (await guardian.legacyWorkerConflict())
      )
        throw new Error("ADVANCED_IDENTITY_INVALID");
      if (!ready.evidence.gpuIdentity)
        throw new Error("ADVANCED_GPU_REQUALIFICATION_REQUIRED");
      const gpus = await guardian.enumerateGpus(),
        resolved = resolveQualifiedGpuIdentity(
          ready.evidence.gpuIdentity,
          gpus,
        ),
        gpu = gpus.find(
          (candidate) => candidate.deviceIndex === resolved.deviceIndex,
        );
      if (!gpu) throw new Error("ADVANCED_GPU_REQUALIFICATION_REQUIRED");
      guard = await guardian.acquireGpuGuard(gpu);
      if (!guard) throw new Error("ADVANCED_GPU_BUSY");
      if (guard.abandoned)
        throw new Error("ADVANCED_GPU_REQUALIFICATION_REQUIRED");
      const configuration = parseAdvancedBenchmarkConfiguration({
        version: 1,
        bootIdentity: ready.bootIdentity,
        ...input,
        requestId: input.requestId ?? randomUUID(),
        release: ready.release,
        sid: identity.sid,
        manifestSha256: ready.manifestSha256,
        helperSha256: ready.nativeSha256,
        gpu,
      });
      await (this.options.publishConfiguration?.(configuration) ??
        writePrivateAtomic(
          this.options.host,
          "prepare-config.json",
          Buffer.from(JSON.stringify(configuration)),
        ));
      ownedJournal = {
        version: 1,
        transaction,
        requestId: configuration.requestId,
        release: ready.release,
        phase: "launching",
        owner: null,
      };
      await this.options.beforeLaunch?.(configuration);
      await this.options.ownership.write(ownedJournal);
      let resolveExit!: () => void, rejectExit!: (error: Error) => void;
      const exited = new Promise<void>((resolve, reject) => {
        resolveExit = resolve;
        rejectExit = reject;
      });
      void exited.catch(() => {});
      const early: ConsumerOwnedProcess[] = [];
      const matches = (candidate: ConsumerOwnedProcess) =>
        !!owner &&
        candidate.nonce === owner.nonce &&
        sameConsumerProcess(candidate.identity, owner.identity);
      unsubscribe = guardian.onEvent((event) => {
        if (event.kind === "child_exit") {
          if (!owner) early.push(event.owner);
          else if (matches(event.owner)) resolveExit();
        }
      });
      unclosed = guardian.onClosed(() =>
        rejectExit(new Error("ADVANCED_HELPER_LOST")),
      );
      cancel = () => rejectExit(new Error("ADVANCED_CANCELLED"));
      signal.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(
        () => rejectExit(new Error("ADVANCED_BENCHMARK_TIMEOUT")),
        this.options.timeoutMs ?? 120 * 60_000,
      );
      signal.throwIfAborted();
      stopped = false;
      owner = await guardian.launchOwned("prepare", ready.release);
      this.current = { guardian, owner };
      ownedJournal = { ...ownedJournal, phase: "owned", owner };
      await this.options.ownership.write(ownedJournal);
      workspace = await this.options.trackWorkspace?.(configuration, owner);
      if (early.some(matches)) resolveExit();
      await exited;
      signal.throwIfAborted();
      const relative = `prepare\\results\\${configuration.requestId}.benchmark.json`;
      const raw = await (this.options.result?.(relative) ??
        readPrivateBytes(this.options.host, relative, 8 * 1024 ** 2).then(
          (bytes) => JSON.parse(bytes.toString("utf8")) as unknown,
        ));
      return {
        configuration,
        report: validateAdvancedBenchmarkReport(
          raw,
          configuration,
          undefined,
          true,
        ),
        relativePath: relative,
      };
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      unsubscribe();
      unclosed();
      let cleanupError: unknown;
      if (guardian && owner) {
        try {
          await guardian.stopOwned(owner);
          stopped = true;
          if (ownedJournal)
            await this.options.ownership.write({
              ...ownedJournal,
              phase: "exited",
            });
        } catch (error) {
          cleanupError = error;
        }
      }
      // A rejected launch can have an ambiguous ACK. Closing its guardian lets the
      // independent native keeper kill/wait the exact nested GPU Job; never release early.
      if (guardian && guard && stopped) {
        try {
          await guardian.releaseGpuGuard(guard);
        } catch (error) {
          cleanupError ??= error;
        }
      }
      if (workspace && stopped) {
        try {
          await workspace.release();
        } catch (error) {
          cleanupError ??= error;
        }
      }
      if (guardian) {
        try {
          await guardian.close();
        } catch (error) {
          cleanupError ??= error;
        }
      }
      if (lease) {
        try {
          await lease.release();
        } catch (error) {
          cleanupError ??= error;
        }
      }
      this.current = null;
      this.running = false;
      if (!stopped || cleanupError)
        // A valid report never overrides uncertain descendant shutdown.
        // oxlint-disable-next-line no-unsafe-finally
        throw new Error("ADVANCED_BENCHMARK_TREE_UNCERTAIN");
    }
  }
  private async openGuardian(
    ready: AdvancedReadySnapshot,
  ): Promise<AdvancedBenchmarkGuardian> {
    return new WindowsConsumerNative(
      await createConsumerNativeTransport(
        win32.join(
          ready.releaseRoot,
          "runtime",
          "native",
          "musicmute-native.exe",
        ),
        ready.nativeSha256,
      ),
      {
        verify: async (role, release) => {
          if (role !== "prepare" || release !== ready.release)
            throw new Error("ADVANCED_RUNTIME_CHANGED");
          const current = await this.options.ready(
            new AbortController().signal,
          );
          if (
            current.release !== release ||
            current.manifestSha256 !== ready.manifestSha256 ||
            current.nativeSha256 !== ready.nativeSha256
          )
            throw new Error("ADVANCED_RUNTIME_CHANGED");
          await this.options.host.native.validatePath(
            "personal",
            "prepare-config.json",
            "file",
          );
        },
      },
    );
  }
  async recover(transaction: string): Promise<void> {
    const receipt = await this.options.ownership.read();
    if (!receipt || receipt.transaction !== transaction)
      throw new Error("ADVANCED_BENCHMARK_TREE_UNCERTAIN");
    if (receipt.phase === "staging") return;
    if (!receipt.owner) throw new Error("ADVANCED_BENCHMARK_TREE_UNCERTAIN");
    if (
      this.current &&
      sameConsumerProcess(
        this.current.owner.identity,
        receipt.owner.identity,
      ) &&
      this.current.owner.nonce === receipt.owner.nonce
    )
      await this.current.guardian.stopOwned(receipt.owner);
    else if (!(await this.options.host.ownedTreeExited(receipt.owner)))
      throw new Error("ADVANCED_BENCHMARK_TREE_UNCERTAIN");
    await this.options.ownership.write({ ...receipt, phase: "exited" });
  }
}
