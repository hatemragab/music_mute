import { randomUUID } from "node:crypto";
import { statfs } from "node:fs/promises";
import { win32 } from "node:path";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import { resolveQualifiedGpuIdentity } from "../../../../worker/src/enrollment/report-builder.js";
import type { ConsumerGpuIdentity } from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  StoreNativeAuthority,
  StoreWorkerCodeAuthority,
  storeAuthorityForDataNative,
} from "../browser/store-native.js";
import type { HostContext } from "../host-context.js";
import { StoreSessionClient } from "../session/store-session-client.js";
import type { PrepareStage } from "../../shared/prepare-contracts.js";
import {
  PrepareFailure,
  type PreparationOperations,
  type PrepareLease,
  type PrepareTarget,
} from "./controller.js";
import { PREPARATION_FIXTURE } from "./fixture.js";
import { verifyPrivateFile } from "./private-files.js";
import {
  QualificationCleanupUnconfirmed,
  assertApprovedPreparationFixture,
  selectTrustedPreparationGpu,
  type ApprovedPreparationFixture,
  type QualificationResult,
  type TrustedPreparationGpuSelection,
} from "./qualification-runner.js";
import { prepareStoreModel } from "./store-model.js";
import {
  STORE_MODEL_READY_KEY,
  parseStoreModelReady,
  storePreparationTarget,
  type StoreModelReadyReceipt,
  type StorePreparationBinding,
} from "./store-model-ready.js";
import { readStoreReadiness } from "./store-readiness.js";

const TOKEN = Symbol("store-preparation-operations");
async function confirmStorePreparationCleanup(work: () => Promise<unknown>) {
  try {
    await work();
  } catch (error) {
    throw new QualificationCleanupUnconfirmed(error);
  }
}
export interface StorePreparationOptions {
  /** The living maintenance owner must fence personal/fleet work before any
   * model, qualification or readiness mutation. */
  assertMutation(target: PrepareTarget): Promise<void>;
  registerBrowser(): Promise<boolean>;
  verifyBrowser(): Promise<boolean>;
}
/** Store code is opened only by the genuine GUI owner. This implementation has
 * no archive, unsigned executable promotion, sequence or legacy Ready adapter.
 * Each qualification is issued through the actual Worker Session's private
 * role table and its original process/GPU cleanup acknowledgement. */
export class StorePreparationOperations implements PreparationOperations {
  #host: HostContext;
  #authority: StoreNativeAuthority;
  #workerCode: StoreWorkerCodeAuthority | undefined;
  #codeOpening: Promise<StoreWorkerCodeAuthority> | undefined;
  get #code(): StoreWorkerCodeAuthority {
    if (!this.#workerCode)
      throw new PrepareFailure("NATIVE_HELPER_UNAVAILABLE");
    return this.#workerCode;
  }
  #options: StorePreparationOptions;
  #binding: StorePreparationBinding | undefined;
  #lease: PrepareLease | undefined;
  #session: StoreSessionClient | undefined;
  #sessionOpening: Promise<StoreSessionClient | undefined> | undefined;
  #qualification: QualificationResult | undefined;
  #preference: ConsumerGpuIdentity | undefined;
  #running = false;
  #ending = false;
  #closing: Promise<void> | undefined;
  #closeFailed = false;
  #closeFailures: Promise<void>[] = [];
  #sessionCloseStarted = false;
  #codeCloseStarted = false;
  private constructor(
    token: symbol,
    host: HostContext,
    authority: StoreNativeAuthority,
    options: StorePreparationOptions,
  ) {
    if (token !== TOKEN) throw new Error("STORE_PREPARATION_DENIED");
    this.#host = host;
    this.#authority = authority;
    this.#options = options;
    Object.freeze(this);
  }
  static async open(host: HostContext, options: StorePreparationOptions) {
    const authority = host.storeAuthority;
    if (
      !authority ||
      !options ||
      ["assertMutation", "registerBrowser", "verifyBrowser"].some(
        (key) =>
          typeof Object.getOwnPropertyDescriptor(options, key)?.value !==
          "function",
      )
    )
      throw new Error("STORE_PREPARATION_DENIED");
    if (storeAuthorityForDataNative(host.native) !== authority)
      throw new Error("STORE_PREPARATION_DENIED");
    StoreNativeAuthority.prototype.creatorProof.call(authority);
    // GUI account/Library data remain available before Worker installation.
    // The first Prepare target read acquires code through this genuine helper.
    return new StorePreparationOperations(TOKEN, host, authority, options);
  }
  /** Same living GUI data/code owner only; observations cannot construct it. */
  assertHost(host: HostContext): void {
    if (
      arguments.length !== 1 ||
      host !== this.#host ||
      this.#ending ||
      storeAuthorityForDataNative(host.native) !== this.#authority
    )
      throw new Error("STORE_PREPARATION_DENIED");
    StoreNativeAuthority.prototype.creatorProof.call(this.#authority);
  }
  async #openCode(signal: AbortSignal): Promise<void> {
    if (this.#workerCode) return;
    if (!this.#codeOpening) {
      const observed = await StoreNativeAuthority.prototype.inspectWorker.call(
        this.#authority,
      );
      signal.throwIfAborted();
      if (this.#ending) throw new PrepareFailure("BUSY");
      if (observed.state === "missing")
        throw new PrepareFailure("NATIVE_HELPER_UNAVAILABLE");
      this.#codeOpening ??= StoreNativeAuthority.prototype.openWorkerCode.call(
        this.#authority,
      );
    }
    // Retain the exact pending/rejected native acquisition. Missing Worker is
    // a passive observation, while uncertain code acquisition is never reset.
    const code = await this.#codeOpening;
    this.#workerCode = code;
    StoreWorkerCodeAuthority.prototype.assertDataNative.call(
      code,
      this.#host.native,
    );
    signal.throwIfAborted();
  }
  async #current(signal: AbortSignal): Promise<StorePreparationBinding> {
    signal.throwIfAborted();
    if (this.#ending) throw new PrepareFailure("BUSY");
    await this.#openCode(signal);
    StoreWorkerCodeAuthority.prototype.assertDataNative.call(
      this.#code,
      this.#host.native,
    );
    const binding =
      await StoreWorkerCodeAuthority.prototype.preparationBinding.call(
        this.#code,
      );
    signal.throwIfAborted();
    if (
      binding.sid !== this.#host.identity.sid ||
      (this.#binding &&
        JSON.stringify(this.#binding) !== JSON.stringify(binding))
    )
      throw new PrepareFailure("INTEGRITY_INVALID");
    this.#binding ??= binding;
    return binding;
  }
  async #target(target: PrepareTarget, signal: AbortSignal) {
    const binding = await this.#current(signal);
    if (
      target.sid !== binding.sid ||
      target.identity !== storePreparationTarget(binding)
    )
      throw new PrepareFailure("INTEGRITY_INVALID");
    return binding;
  }
  async #mutation(target: PrepareTarget, signal: AbortSignal) {
    await this.#target(target, signal);
    const lease = this.#lease;
    if (!lease) throw new PrepareFailure("BUSY");
    await this.#options.assertMutation(target);
    if (this.#lease !== lease) throw new PrepareFailure("BUSY");
    await this.#target(target, signal);
  }
  async target(signal: AbortSignal): Promise<PrepareTarget> {
    const binding = await this.#current(signal);
    return { identity: storePreparationTarget(binding), sid: binding.sid };
  }
  /** For Store recovery publication only: the private original Prepare owner
   * and its live maintenance drain are checked again, including after IO. */
  async assertHeldMutation(target: PrepareTarget, signal: AbortSignal) {
    if (arguments.length !== 2) throw new Error("STORE_PREPARATION_DENIED");
    await this.#mutation(target, signal);
  }
  async lock(target: PrepareTarget): Promise<PrepareLease | null> {
    if (this.#lease || this.#ending) return null;
    await this.#target(target, AbortSignal.timeout(35_000));
    const actual = await this.#host.prepareLease(target);
    if (!actual) return null;
    const lease: PrepareLease = {
      release: async () => {
        if (this.cleanupPending())
          throw new QualificationCleanupUnconfirmed(
            new Error("STORE_PREPARE_CLEANUP_PENDING"),
          );
        await actual.release();
        if (this.#lease === lease) this.#lease = undefined;
      },
    };
    this.#lease = lease;
    return lease;
  }
  async space(target: PrepareTarget, signal: AbortSignal) {
    await this.#target(target, signal);
    const disk = await statfs(this.#host.personalRoot, { bigint: true });
    signal.throwIfAborted();
    const available = disk.bavail * disk.bsize;
    return {
      // Package downloads are owned by Windows. Reserve mutable model partial,
      // verified model, qualification scratch and the existing headroom only.
      requiredBytes: MODEL.bytes * 2 + 512 * 1024 ** 2,
      availableBytes: Number(
        available > BigInt(Number.MAX_SAFE_INTEGER)
          ? BigInt(Number.MAX_SAFE_INTEGER)
          : available,
      ),
    };
  }
  async cachedReady(target: PrepareTarget, signal: AbortSignal) {
    await this.#target(target, signal);
    if (this.cleanupPending()) return false;
    try {
      return !!(await readStoreReadiness(this.#host, this.#code, signal));
    } catch {
      signal.throwIfAborted();
      return false;
    }
  }
  async browserReady(target: PrepareTarget, signal: AbortSignal) {
    await this.#target(target, signal);
    const ready = await this.#options.verifyBrowser();
    await this.#target(target, signal);
    return ready;
  }
  async reuse(stage: PrepareStage, target: PrepareTarget, signal: AbortSignal) {
    await this.#target(target, signal);
    if (stage === "inspect" || stage === "space" || stage === "runtime")
      return true;
    if (stage !== "model") return false;
    try {
      const model = await verifyPrivateFile(
        this.#host,
        `models\\${MODEL.filename}`,
        MODEL.bytes,
        signal,
      );
      const fixture = await verifyPrivateFile(
        this.#host,
        `fixtures\\${PREPARATION_FIXTURE.filename}`,
        PREPARATION_FIXTURE.bytes,
        signal,
      );
      await this.#target(target, signal);
      return (
        model.sha256 === MODEL.sha256 &&
        fixture.sha256 === PREPARATION_FIXTURE.sha256
      );
    } catch {
      signal.throwIfAborted();
      return false;
    }
  }
  #openSession(launchIfAbsent?: true): Promise<StoreSessionClient>;
  #openSession(launchIfAbsent: false): Promise<StoreSessionClient | undefined>;
  async #openSession(launchIfAbsent = true) {
    if (this.#session) return this.#session;
    if (this.#ending) throw new PrepareFailure("BUSY");
    const opening = (this.#sessionOpening ??= (
      launchIfAbsent
        ? StoreSessionClient.open(this.#host, this.#code)
        : StoreSessionClient.tryOpen(this.#host, this.#code)
    ).then((session) => {
      this.#session = session;
      return session;
    }));
    const session = await opening;
    // Only an actual fulfilled passive absence may retire this probe. A
    // rejected bind retains its original pending native/code owner instead.
    if (!session && this.#sessionOpening === opening)
      this.#sessionOpening = undefined;
    if (!session && launchIfAbsent) return this.#openSession();
    return session;
  }
  /** Borrow the original live control client for acknowledged maintenance.
   * This opens no second code lease and grants no model/GPU mutation rights;
   * the caller must retain its durable maintenance transaction separately. */
  async maintenanceSession(signal: AbortSignal): Promise<StoreSessionClient> {
    if (arguments.length !== 1) throw new Error("STORE_PREPARATION_DENIED");
    await this.#current(signal);
    const session = await this.#openSession();
    await this.#current(signal);
    signal.throwIfAborted();
    return session;
  }
  /** Borrow this operation owner's original control client. Passive callers
   * cannot activate the Worker or turn a failed bind into absence. Closing a
   * UI/browser adapter must never close this shared maintenance/Prepare owner. */
  async controlSession(
    signal: AbortSignal,
    options: { launchIfAbsent?: boolean } = {},
  ): Promise<StoreSessionClient | undefined> {
    if (
      arguments.length < 1 ||
      arguments.length > 2 ||
      !(signal instanceof AbortSignal) ||
      !options ||
      Object.getPrototypeOf(options) !== Object.prototype ||
      Reflect.ownKeys(options).some((key) => key !== "launchIfAbsent")
    )
      throw new Error("STORE_PREPARATION_DENIED");
    const descriptor = Object.getOwnPropertyDescriptor(
      options,
      "launchIfAbsent",
    );
    if (
      descriptor &&
      (!descriptor.enumerable ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "boolean")
    )
      throw new Error("STORE_PREPARATION_DENIED");
    await this.#current(signal);
    const session =
      descriptor?.value === false
        ? await this.#openSession(false)
        : await this.#openSession();
    await this.#current(signal);
    if (session)
      StoreSessionClient.prototype.assertCodeAuthority.call(
        session,
        this.#code,
      );
    signal.throwIfAborted();
    return session;
  }
  /** Passive protected code observations for the Store media port. Execution
   * still needs that port's actual Session/Creator child factory. */
  async mediaCodeView(signal: AbortSignal) {
    if (arguments.length !== 1) throw new Error("STORE_PREPARATION_DENIED");
    const binding = await this.#current(signal),
      manifest = await StoreWorkerCodeAuthority.prototype.readManifest.call(
        this.#code,
      );
    await this.#current(signal);
    return Object.freeze({
      binding,
      manifest,
      workerRoot: win32.join(binding.package.installedLocation, "worker"),
    });
  }
  async #qualify(
    signal: AbortSignal,
    fixture?: ApprovedPreparationFixture,
    selection?: TrustedPreparationGpuSelection,
  ): Promise<QualificationResult> {
    if (this.#running || this.cleanupPending())
      throw new PrepareFailure("BUSY");
    this.#running = true;
    try {
      const binding = await this.#current(signal);
      if (fixture) {
        assertApprovedPreparationFixture(fixture);
        if (
          (
            await verifyPrivateFile(
              this.#host,
              fixture.relativePath,
              fixture.bytes,
              signal,
            )
          ).sha256 !== fixture.sha256
        )
          throw new PrepareFailure("INTEGRITY_INVALID");
      }
      const current = await this.#host.native.enumerateGpus(),
        preferred = (gpu: ConsumerGpuIdentity) => {
          if (!this.#preference || selection) return 0;
          try {
            resolveQualifiedGpuIdentity(this.#preference, [gpu]);
            return 1;
          } catch {
            return 0;
          }
        },
        candidates = (
          selection
            ? [
                selectTrustedPreparationGpu(
                  selection,
                  binding.bootIdentity,
                  current,
                ),
              ]
            : current
        ).sort(
          (a, b) =>
            preferred(b) - preferred(a) ||
            b.dedicatedVideoMemoryBytes - a.dedicatedVideoMemoryBytes ||
            b.sharedSystemMemoryLimitBytes - a.sharedSystemMemoryLimitBytes ||
            a.luid.localeCompare(b.luid) ||
            a.deviceIndex - b.deviceIndex,
        );
      const session = await this.#openSession();
      StoreSessionClient.prototype.assertCodeAuthority.call(
        session,
        this.#code,
      );
      let contention = false;
      for (const gpu of candidates) {
        signal.throwIfAborted();
        // The Creator grants the actual physical lease and suspended child. A
        // GUI candidate observation alone never grants an engine/GPU role.
        const launch = await session.launchPrepare({
          version: 1,
          requestId: randomUUID(),
          operation: "qualify",
          binding,
          gpu,
          fixture: fixture
            ? { kind: "approved", ...fixture }
            : { kind: "fixed" },
        });
        try {
          const result = await session.awaitPrepareResult(launch, { signal });
          if (!result.evidence) throw new PrepareFailure("GPU_UNSUPPORTED");
          await this.#current(signal);
          return {
            bootIdentity: result.result.bootIdentity,
            raw: result.result.raw,
            evidence: result.evidence,
          };
        } catch (error) {
          if (
            !(error instanceof PrepareFailure) ||
            !["GPU_UNSUPPORTED", "BUSY"].includes(error.code)
          )
            throw error;
          if (error.code === "BUSY") contention = true;
        } finally {
          // Retain the genuine session/lease when exact Job/GPU closure cannot
          // be proved. Never mask uncertain cleanup as a qualification PASS.
          await confirmStorePreparationCleanup(() =>
            session.cancelPrepare(launch),
          );
        }
      }
      throw new PrepareFailure(contention ? "BUSY" : "GPU_UNSUPPORTED");
    } finally {
      this.#running = false;
    }
  }
  async perform(
    stage: PrepareStage,
    target: PrepareTarget,
    signal: AbortSignal,
    progress: (completed: number, total: number) => void,
  ) {
    const binding = await this.#target(target, signal);
    if (stage === "inspect" || stage === "space" || stage === "runtime") return;
    await this.#mutation(target, signal);
    if (stage === "model") {
      await prepareStoreModel(this.#host, this.#code, signal, progress);
      return;
    }
    if (stage === "gpu") {
      // An explicit approved repair may already own this exact fresh result.
      // Reuse requires the private result plus current held readiness checks;
      // a stored observation alone never populates this qualification owner.
      if (await this.verifyReady(target, signal)) return;
      this.#qualification = await this.#qualify(signal);
      return;
    }
    const qualification = this.#qualification;
    if (
      !qualification ||
      this.cleanupPending() ||
      qualification.bootIdentity !== binding.bootIdentity
    )
      throw new PrepareFailure("GPU_UNSUPPORTED");
    const model = await verifyPrivateFile(
      this.#host,
      `models\\${MODEL.filename}`,
      MODEL.bytes,
      signal,
    );
    if (model.sha256 !== MODEL.sha256)
      throw new PrepareFailure("INTEGRITY_INVALID", "model");
    const receipt: StoreModelReadyReceipt = {
      version: 1,
      distribution: "microsoft-store",
      target: target.identity,
      packageFullName: binding.package.fullName,
      inventorySha256: binding.inventorySha256,
      runtimeManifestSha256: binding.runtimeManifestSha256,
      sid: binding.sid,
      bootIdentity: binding.bootIdentity,
      modelSha256: MODEL.sha256,
      fixtureSha256: PREPARATION_FIXTURE.sha256,
      modelFingerprint: model.fingerprint,
      qualification: qualification.raw,
      qualifiedAt: new Date().toISOString(),
    };
    const bytes = Buffer.from(JSON.stringify(receipt));
    parseStoreModelReady(bytes, binding);
    await this.#mutation(target, signal);
    await this.#host.native.vaultWrite("account", STORE_MODEL_READY_KEY, bytes);
    await this.#target(target, signal);
  }
  async verifyReady(target: PrepareTarget, signal: AbortSignal) {
    await this.#target(target, signal);
    if (!this.#qualification || this.cleanupPending()) return false;
    const ready = await readStoreReadiness(this.#host, this.#code, signal);
    return (
      !!ready &&
      JSON.stringify(ready.evidence) ===
        JSON.stringify(this.#qualification.evidence)
    );
  }
  async registerBrowser(target: PrepareTarget, signal: AbortSignal) {
    await this.#target(target, signal);
    const registered = await this.#options.registerBrowser();
    await this.#target(target, signal);
    return registered;
  }
  cleanupPending() {
    return this.#session?.cleanupPending() === true;
  }
  async cancelOwned() {
    await this.#session?.recoverCleanup();
  }
  async recoverCleanup() {
    await this.#session?.recoverCleanup();
  }
  async cancelCleanup() {
    await this.recoverCleanup();
  }
  async repair(target: PrepareTarget, _previous: unknown, signal: AbortSignal) {
    await this.cancelOwned();
    await this.#mutation(target, signal);
    await this.#host.native.vaultDelete("account", STORE_MODEL_READY_KEY);
    this.#qualification = undefined;
  }
  /** Explicit Store snapshot: package inventory and model receipt, with no
   * fake archive signature, writable release root or legacy execution grant. */
  async snapshotStoreReady(signal: AbortSignal) {
    await this.#current(signal);
    const ready = await readStoreReadiness(this.#host, this.#code, signal);
    if (!ready || this.cleanupPending())
      throw new PrepareFailure("INTEGRITY_INVALID");
    return ready;
  }
  setGpuPreference(gpu: ConsumerGpuIdentity | undefined) {
    this.#preference = gpu;
  }
  async requalifyInstalled(
    signal: AbortSignal,
    selection?: TrustedPreparationGpuSelection,
  ) {
    const target = await this.target(signal);
    await this.#mutation(target, signal);
    // A boot, driver or Store update invalidates the old receipt. Requalify
    // the unchanged held model/fixture under this real mutation owner rather
    // than requiring the stale receipt to authorize its own replacement.
    if (!(await this.reuse("model", target, signal)))
      throw new PrepareFailure("INTEGRITY_INVALID");
    this.#qualification = await this.#qualify(signal, undefined, selection);
    await this.perform("activate", target, signal, () => {});
  }
  /** Borrow only this operation owner's already-held Prepare lease. The
   * genuine maintenance callback must still prove its acknowledged drain;
   * neither a target DTO nor an approved fixture grants mutation authority. */
  async qualifyApprovedFixtureHeld(
    target: PrepareTarget,
    fixture: ApprovedPreparationFixture,
    signal: AbortSignal,
    selection?: TrustedPreparationGpuSelection,
  ): Promise<QualificationResult> {
    if (arguments.length < 3 || arguments.length > 4)
      throw new Error("STORE_PREPARATION_DENIED");
    assertApprovedPreparationFixture(fixture);
    await this.#mutation(target, signal);
    if (!(await this.reuse("model", target, signal)))
      throw new PrepareFailure("INTEGRITY_INVALID");
    const result = await this.#qualify(signal, fixture, selection);
    await this.#mutation(target, signal);
    return result;
  }
  async qualifyApprovedFixture(
    fixture: ApprovedPreparationFixture,
    signal: AbortSignal,
  ): Promise<QualificationResult> {
    await this.snapshotStoreReady(signal);
    const target = await this.target(signal),
      lease = await this.lock(target);
    if (!lease) throw new PrepareFailure("BUSY");
    try {
      return await this.qualifyApprovedFixtureHeld(target, fixture, signal);
    } finally {
      await lease.release();
    }
  }
  close(): Promise<void> {
    if (arguments.length !== 0) throw new Error("STORE_PREPARATION_DENIED");
    if (this.#closing && !this.#closeFailed) return this.#closing;
    if (this.#closing) this.#closeFailures.push(this.#closing);
    this.#closeFailed = false;
    this.#ending = true;
    const closing = (async () => {
      // Preserve pending/failed session acquisition and original cleanup ACKs.
      const session = this.#session ?? (await this.#sessionOpening);
      if (session) {
        const recovery = this.#sessionCloseStarted;
        this.#sessionCloseStarted = true;
        if (recovery)
          await StoreSessionClient.prototype.recoverClose.call(session);
        else await StoreSessionClient.prototype.close.call(session);
      }
      await this.#lease?.release();
      const code = this.#workerCode ?? (await this.#codeOpening);
      if (code) {
        const recovery = this.#codeCloseStarted;
        this.#codeCloseStarted = true;
        if (recovery)
          await StoreWorkerCodeAuthority.prototype.recoverClose.call(code);
        else await StoreWorkerCodeAuthority.prototype.close.call(code);
      }
    })();
    this.#closing = closing;
    void closing.catch(() => {
      this.#closeFailed = true;
    });
    return closing;
  }
}
