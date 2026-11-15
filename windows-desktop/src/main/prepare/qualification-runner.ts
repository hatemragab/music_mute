import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import {
  createConsumerNativeTransport,
  sameConsumerProcess,
  WindowsConsumerNative,
  type ConsumerOwnedProcess,
  type ConsumerGpuIdentity,
  type ConsumerGpuLease,
  type ConsumerProcessIdentity,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import { processIdentityFromWire } from "../../../../worker/src/platform/windows/consumer-native-policy.js";
import {
  parseQualificationEvidence,
  resolveQualifiedGpuIdentity,
  parseDirectmlGpuIdentity,
  type QualificationEvidence,
} from "../../../../worker/src/enrollment/report-builder.js";
import type { HostContext } from "../host-context.js";
import { PrepareFailure } from "./controller.js";
import { PREPARATION_FIXTURE } from "./fixture.js";
import { readPrivateBytes, writePrivateAtomic } from "./private-files.js";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";

export interface PreparationChildConfig {
  version: 1;
  operation: "qualify" | "inspect";
  requestId: string;
  release: string;
  sid: string;
  manifestSha256: string;
  helperSha256: string;
  gpu: ConsumerGpuIdentity;
  approvedFixture?: ApprovedPreparationFixture;
}
export interface ApprovedPreparationFixture {
  relativePath: string;
  sha256: string;
  bytes: number;
}
export function assertApprovedPreparationFixture(
  value: unknown,
): asserts value is ApprovedPreparationFixture {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PrepareFailure("INTEGRITY_INVALID");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 3 ||
    typeof row.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.sha256) ||
    row.relativePath !== `prepare\\approved\\${row.sha256}.wav` ||
    !Number.isSafeInteger(row.bytes) ||
    (row.bytes as number) < 44 ||
    (row.bytes as number) > 64 * 1024 ** 2
  )
    throw new PrepareFailure("INTEGRITY_INVALID");
}
export interface QualificationResult {
  bootIdentity: string;
  raw: unknown;
  evidence: QualificationEvidence;
}
/** Trusted fleet admission only; never accepted from Renderer/Chrome or used as an ordinal hint. */
export interface TrustedPreparationGpuSelection {
  approvedGpu: ConsumerGpuIdentity;
  expectedBootIdentity: string;
  allowLuidRebind: boolean;
}
export function selectTrustedPreparationGpu(
  selection: TrustedPreparationGpuSelection,
  bootIdentity: string,
  current: readonly ConsumerGpuIdentity[],
): ConsumerGpuIdentity {
  if (
    !selection ||
    Object.keys(selection).sort().join() !==
      "allowLuidRebind,approvedGpu,expectedBootIdentity" ||
    typeof selection.allowLuidRebind !== "boolean" ||
    typeof selection.expectedBootIdentity !== "string" ||
    !/^[a-f0-9]{64}$/u.test(selection.expectedBootIdentity) ||
    selection.expectedBootIdentity !== bootIdentity
  )
    throw new PrepareFailure("GPU_UNSUPPORTED");
  try {
    const approved = parseDirectmlGpuIdentity(selection.approvedGpu),
      candidates = current.map(parseDirectmlGpuIdentity);
    if (
      candidates.length > 16 ||
      new Set(candidates.map((g) => g.luid)).size !== candidates.length ||
      new Set(candidates.map((g) => g.deviceIndex)).size !== candidates.length
    )
      throw new Error();
    const matching = candidates.filter((gpu) => {
      try {
        resolveQualifiedGpuIdentity(
          {
            ...approved,
            driverVersion: gpu.driverVersion,
            ...(selection.allowLuidRebind ? { luid: gpu.luid } : {}),
          },
          [gpu],
        );
        return true;
      } catch {
        return false;
      }
    });
    if (matching.length !== 1) throw new Error();
    return matching[0]!;
  } catch {
    throw new PrepareFailure("GPU_UNSUPPORTED");
  }
}
/** Engine-tree/physical-guard uncertainty must retain the caller's maintenance authority. */
export class QualificationCleanupUnconfirmed extends Error {
  constructor(cause: unknown) {
    super("QUALIFICATION_CLEANUP_UNCONFIRMED", { cause });
  }
}
async function confirmQualificationCleanup(
  work: () => Promise<void>,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    throw new QualificationCleanupUnconfirmed(error);
  }
}
export class PreparationQualificationRunner {
  private active: WindowsConsumerNative | undefined;
  private owner: ConsumerOwnedProcess | undefined;
  private stopPending: Promise<void> | undefined;
  private running = false;
  private guard: ConsumerGpuLease | undefined;
  private release: string | undefined;
  private cleanupCertified = true;
  private launchUnconfirmed = false;
  private controllerIdentity: ConsumerProcessIdentity | undefined;
  private readonly oldControllers = new Set<WindowsConsumerNative>();
  private recovering: Promise<void> | undefined;
  constructor(
    private readonly host: HostContext,
    private readonly verifyRelease: (
      release: string,
    ) => Promise<{ manifestSha256: string; helperSha256: string }>,
  ) {}
  async run(
    release: string,
    signal: AbortSignal,
    approvedFixture?: ApprovedPreparationFixture,
    selection?: TrustedPreparationGpuSelection,
    preference?: ConsumerGpuIdentity,
  ): Promise<QualificationResult> {
    if (this.running || this.cleanupPending()) throw new PrepareFailure("BUSY");
    this.running = true;
    try {
      return await this.runCandidates(
        release,
        signal,
        approvedFixture,
        selection,
        preference,
      );
    } finally {
      this.running = false;
    }
  }
  private async runCandidates(
    release: string,
    signal: AbortSignal,
    approvedFixture?: ApprovedPreparationFixture,
    selection?: TrustedPreparationGpuSelection,
    preference?: ConsumerGpuIdentity,
  ): Promise<QualificationResult> {
    signal.throwIfAborted();
    const verified = await this.verifyRelease(release);
    if (approvedFixture) assertApprovedPreparationFixture(approvedFixture);
    // Trusted selection also supports the fixed PERSONAL fixture during fleet alignment.
    await this.host.directory(`prepare\\results`);
    const guardian = await this.openGuardian(release, verified);
    this.release = release;
    this.active = guardian;
    try {
      const identity = await guardian.identity();
      this.controllerIdentity = identity;
      const bootIdentity = await guardian.bootIdentity();
      if (
        identity.sid !== this.host.identity.sid ||
        identity.sessionId !== this.host.identity.sessionId
      )
        throw new PrepareFailure("INTEGRITY_INVALID");
      if (await guardian.legacyWorkerConflict())
        throw new PrepareFailure("BUSY");
      const enumerated = await guardian.enumerateGpus();
      const preferred = (gpu: ConsumerGpuIdentity): number => {
        if (!preference || selection) return 0;
        try {
          resolveQualifiedGpuIdentity(preference, [gpu]);
          return 1;
        } catch {
          return 0;
        }
      };
      const candidates = (
        selection
          ? [selectTrustedPreparationGpu(selection, bootIdentity, enumerated)]
          : enumerated
      ).sort(
        (a, b) =>
          preferred(b) - preferred(a) ||
          b.dedicatedVideoMemoryBytes - a.dedicatedVideoMemoryBytes ||
          b.sharedSystemMemoryLimitBytes - a.sharedSystemMemoryLimitBytes ||
          a.luid.localeCompare(b.luid) ||
          a.deviceIndex - b.deviceIndex,
      );
      let contention = false;
      for (const gpu of candidates) {
        signal.throwIfAborted();
        const guard = await guardian.acquireGpuGuard(gpu);
        if (!guard) {
          contention = true;
          continue;
        }
        this.guard = guard;
        try {
          if (guard.abandoned) throw new PrepareFailure("GPU_UNSUPPORTED");
          const configuration: PreparationChildConfig = {
            version: 1,
            operation: "qualify",
            requestId: randomUUID(),
            release,
            sid: this.host.identity.sid,
            ...verified,
            gpu,
            ...(approvedFixture ? { approvedFixture } : {}),
          };
          await writePrivateAtomic(
            this.host,
            "prepare-config.json",
            Buffer.from(JSON.stringify(configuration)),
          );
          try {
            const result = await this.runCandidate(
              guardian,
              configuration,
              signal,
            );
            if ((await guardian.bootIdentity()) !== bootIdentity)
              throw new PrepareFailure("GPU_UNSUPPORTED");
            return { ...result, bootIdentity };
          } catch (error) {
            if (
              !(error instanceof PrepareFailure) ||
              error.code !== "GPU_UNSUPPORTED"
            )
              throw error;
          }
        } finally {
          await this.releaseCandidateGuard(guardian, guard);
        }
      }
      throw new PrepareFailure(contention ? "BUSY" : "GPU_UNSUPPORTED");
    } finally {
      if (!this.owner && !this.guard && !this.launchUnconfirmed) {
        await confirmQualificationCleanup(() => guardian.close());
        this.active = undefined;
        this.release = undefined;
      }
    }
  }
  private async openGuardian(
    release: string,
    verified: { manifestSha256: string; helperSha256: string },
  ): Promise<WindowsConsumerNative> {
    return new WindowsConsumerNative(
      await createConsumerNativeTransport(
        win32.join(
          this.host.personalRoot,
          "runtime",
          "releases",
          release,
          "runtime",
          "native",
          "musicmute-native.exe",
        ),
        verified.helperSha256,
      ),
      {
        verify: async (role, requested) => {
          if (role !== "prepare" || requested !== release)
            throw new PrepareFailure("INTEGRITY_INVALID");
          const check = await this.verifyRelease(release);
          if (JSON.stringify(check) !== JSON.stringify(verified))
            throw new PrepareFailure("INTEGRITY_INVALID");
          await this.host.native.validatePath(
            "personal",
            "prepare-config.json",
            "file",
          );
        },
      },
    );
  }
  private async runCandidate(
    guardian: WindowsConsumerNative,
    configuration: PreparationChildConfig,
    signal: AbortSignal,
  ): Promise<Omit<QualificationResult, "bootIdentity">> {
    let unsubscribe = () => {},
      onClosed = () => {};
    const early: ConsumerOwnedProcess[] = [];
    let ended!: () => void, failed!: (reason: Error) => void;
    const exited = new Promise<void>((resolve, reject) => {
      ended = resolve;
      failed = reject;
    });
    void exited.catch(() => {});
    // Attach immediately; fast exits are held until launch ownership is returned.
    unsubscribe = guardian.onEvent((event) => {
      if (event.kind !== "child_exit") return;
      if (!this.owner) early.push(event.owner);
      else if (
        event.owner.nonce === this.owner.nonce &&
        sameConsumerProcess(event.owner.identity, this.owner.identity)
      )
        ended();
    });
    onClosed = guardian.onClosed(() =>
      failed(new PrepareFailure("NATIVE_HELPER_UNAVAILABLE")),
    );
    const timeout = setTimeout(
      () => failed(new PrepareFailure("GPU_UNSUPPORTED")),
      15 * 60_000,
    );
    const cancel = () => failed(new PrepareFailure("PREPARE_INTERRUPTED"));
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      this.cleanupCertified = false;
      this.launchUnconfirmed = true;
      this.owner = await guardian.launchOwned("prepare", configuration.release);
      this.launchUnconfirmed = false;
      if (
        early.some(
          (owner) =>
            owner.nonce === this.owner!.nonce &&
            sameConsumerProcess(owner.identity, this.owner!.identity),
        )
      )
        ended();
      await exited;
      signal.throwIfAborted();
      const bytes = await readPrivateBytes(
        this.host,
        `prepare\\results\\${configuration.requestId}.json`,
        16384,
      );
      const raw: unknown = JSON.parse(bytes.toString("utf8"));
      const evidence = parseQualificationEvidence(raw, {
        runtimeProfile: "windows-user",
        expectedUserSid: this.host.identity.sid,
        expectedFixtureDigest:
          configuration.approvedFixture?.sha256 ?? PREPARATION_FIXTURE.sha256,
      });
      if (
        evidence.releaseManifestDigest !== configuration.manifestSha256 ||
        evidence.modelDigest !== MODEL.sha256 ||
        evidence.runtimeDiagnostics?.onnxRuntime !== "1.24.4"
      )
        throw new PrepareFailure("GPU_UNSUPPORTED");
      if (
        !evidence.gpuIdentity ||
        evidence.directmlDeviceId !== configuration.gpu.deviceIndex
      )
        throw new PrepareFailure("GPU_UNSUPPORTED");
      resolveQualifiedGpuIdentity(configuration.gpu, [evidence.gpuIdentity]);
      return { raw, evidence };
    } catch (error) {
      if (error instanceof PrepareFailure) throw error;
      throw new PrepareFailure("GPU_UNSUPPORTED");
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
      unsubscribe();
      onClosed();
      await this.confirmCandidateStop();
    }
  }
  private async releaseCandidateGuard(
    guardian: WindowsConsumerNative,
    guard: ConsumerGpuLease,
  ): Promise<void> {
    // Cleanup uncertainty takes precedence over a late successful report.
    if (this.owner || this.launchUnconfirmed)
      throw new QualificationCleanupUnconfirmed("OWNED_TREE_UNCONFIRMED");
    await confirmQualificationCleanup(() => guardian.releaseGpuGuard(guard));
    this.guard = undefined;
  }
  private async confirmCandidateStop(): Promise<void> {
    await confirmQualificationCleanup(() => this.stop());
    if (this.launchUnconfirmed)
      throw new QualificationCleanupUnconfirmed("LAUNCH_ACK_UNCONFIRMED");
    this.cleanupCertified = true;
    this.owner = undefined;
    this.stopPending = undefined;
  }
  private stop(): Promise<void> {
    const guardian = this.active,
      owner = this.owner;
    if (!guardian || !owner) return Promise.resolve();
    this.stopPending ??= guardian.stopOwned(owner);
    return this.stopPending;
  }
  cancel(): Promise<void> {
    return this.running ? this.stop() : this.recoverCleanup();
  }
  cleanupPending(): boolean {
    return !this.running && !!this.active;
  }
  /** Retry exact cleanup, never rerun qualification or infer safety from PID loss. */
  recoverCleanup(): Promise<void> {
    this.recovering ??= this.recover().finally(() => {
      this.recovering = undefined;
    });
    return this.recovering;
  }
  private async recover(): Promise<void> {
    if (this.running) throw new PrepareFailure("BUSY");
    const active = this.active;
    if (!active) return;
    let guardian = active;
    for (const previous of this.oldControllers) {
      await confirmQualificationCleanup(() => previous.close());
      this.oldControllers.delete(previous);
    }
    if (this.launchUnconfirmed) {
      // Native writes this exact controller-bound index before the child may run.
      // A missing/corrupt/foreign index is uncertainty, never a no-child shortcut.
      const bytes = await this.host.native.vaultRead(
        "fleet",
        "latest_prepare_job",
      );
      try {
        if (!bytes || bytes.length > 4096 || !this.controllerIdentity)
          throw new Error();
        const row = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
        if (
          !row ||
          Object.keys(row).sort().join() !==
            "controller,guardian,owner,version" ||
          row.version !== 1 ||
          !row.owner ||
          Object.keys(row.owner).sort().join() !== "identity,nonce,role" ||
          row.owner.role !== "prepare" ||
          typeof row.owner.nonce !== "string" ||
          !/^[a-f0-9]{64}$/u.test(row.owner.nonce) ||
          !sameConsumerProcess(
            processIdentityFromWire(row.controller),
            this.controllerIdentity,
          )
        )
          throw new Error();
        processIdentityFromWire(row.guardian);
        const identity = processIdentityFromWire(row.owner.identity);
        if (
          identity.sid !== this.host.identity.sid ||
          identity.sessionId !== this.host.identity.sessionId
        )
          throw new Error();
        this.owner = { role: "prepare", nonce: row.owner.nonce, identity };
        this.launchUnconfirmed = false;
      } catch (error) {
        throw new QualificationCleanupUnconfirmed(error);
      } finally {
        bytes?.fill(0);
      }
    }
    if (this.owner) {
      try {
        await guardian.stopOwned(this.owner);
        this.cleanupCertified = true;
      } catch (error) {
        if (
          !this.host.native.ownedTreeExited ||
          (await this.host.native.ownedTreeExited(this.owner)) !== true
        )
          throw new QualificationCleanupUnconfirmed(error);
        this.cleanupCertified = true;
      }
      this.owner = undefined;
      this.stopPending = undefined;
    }
    const retainedGuard = this.guard;
    if (retainedGuard) {
      try {
        await guardian.releaseGpuGuard(retainedGuard);
        this.guard = undefined;
      } catch (error) {
        if (!this.cleanupCertified || !this.release)
          throw new QualificationCleanupUnconfirmed(error);
        // A lost helper cannot release its lease via another helper. After the
        // exact protected Job certificate, acquire the actual current physical
        // gate through a fresh hash-verified helper; contention/abandonment denies.
        const fresh = await this.openGuardian(
          this.release,
          await this.verifyRelease(this.release),
        );
        let recovered: ConsumerGpuLease | null;
        try {
          const selected = resolveQualifiedGpuIdentity(
            retainedGuard.gpu,
            await fresh.enumerateGpus(),
          );
          recovered = await fresh.acquireGpuGuard(selected);
          if (!recovered || recovered.abandoned)
            throw new QualificationCleanupUnconfirmed(error);
        } catch (failure) {
          this.oldControllers.add(fresh);
          await confirmQualificationCleanup(() => fresh.close());
          this.oldControllers.delete(fresh);
          throw failure;
        }
        this.oldControllers.add(guardian);
        this.active = fresh;
        this.guard = recovered;
        await confirmQualificationCleanup(() =>
          fresh.releaseGpuGuard(recovered),
        );
        this.guard = undefined;
        await confirmQualificationCleanup(() => guardian.close());
        this.oldControllers.delete(guardian);
        guardian = fresh;
      }
    }
    await confirmQualificationCleanup(() => guardian.close());
    this.active = undefined;
    this.release = undefined;
  }
}
