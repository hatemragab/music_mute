import { isDeepStrictEqual, types } from "node:util";
import { sameConsumerProcess } from "../../../../../worker/src/platform/windows/consumer-native.js";
import { parseLocalRuntimeStatus } from "../../../../../worker/src/runtime/local-runtime-status.js";
import { createFleetPrivateFiles } from "./inspection.js";
import { MODEL } from "../../../../../chrome-extension/src/shared/local-model.js";
import type { HostContext } from "../../host-context.js";
import { StorePreparationOperations } from "../../prepare/store-operations.js";
import { StorePrepareMaintenance } from "../../prepare/store-maintenance.js";
import type { PrepareLease, PrepareTarget } from "../../prepare/controller.js";
import { StoreDesktopConnection } from "../../session/store-desktop-client.js";
import { StoreSessionClient } from "../../session/store-session-client.js";
import { randomUUID } from "node:crypto";
import { readStoreFleetRuntimeIdentityForGui } from "../store-active-runtime.js";
import type { FleetEnrollmentRecord } from "../store.js";
import type { LocalRuntimeStatus } from "../../../../../worker/src/runtime/local-runtime-status.js";
import {
  validateAdvancedBenchmarkReport,
  type AdvancedBenchmarkConfiguration,
} from "./benchmark-child.js";
import type { WindowsAdvancedBenchmarkRunner } from "./benchmark-runner.js";
import { parseStrictJson } from "../../../../../chrome-extension/src/shared/strict-json.js";
import { parseAdvancedJournal } from "./controller.js";
import { VaultFleetStore, fleetRecordAuthority } from "../store.js";
import { resolveQualifiedGpuIdentity } from "../../../../../worker/src/enrollment/report-builder.js";
import { StoreBenchmarkExecution } from "../../session/store-benchmark-execution.js";
import { parseStoreBenchmarkRequest } from "../../../shared/store-benchmark-contracts.js";
import { storeCpuFields } from "../../../shared/store-cpu-operation.js";
import { writePrivateAtomic } from "../../prepare/private-files.js";
import type { StorePreparationBinding } from "../../prepare/store-model-ready.js";

const TOKEN = Symbol("store-fleet-advanced-runtime");
type Ready = Awaited<
  ReturnType<StorePreparationOperations["snapshotStoreReady"]>
>;
export interface StoreAdvancedReadySnapshot {
  distribution: "microsoft-store";
  archiveSha256: null;
  release: string;
  releaseRoot: string;
  releaseVersion: string;
  manifestSha256: string;
  nativeSha256: string;
  modelSha256: string;
  bootIdentity: string;
  evidence: Ready["evidence"];
  storeBinding: Ready["binding"];
}
interface Holding {
  transaction: string;
  target: PrepareTarget | undefined;
  setup: PrepareLease | null;
  mutation: PrepareLease | null;
  opening: Promise<void>;
  releasing?: Promise<void> | undefined;
  originalRelease?: Promise<void>;
}
type BenchmarkInput = Parameters<StoreFleetAdvancedRuntime["runBenchmark"]>[1];
type BenchmarkOutput = Awaited<
  ReturnType<WindowsAdvancedBenchmarkRunner["run"]>
>;
interface BenchmarkOwner {
  readonly transaction: string;
  readonly requestId: string;
  input?: BenchmarkInput;
  task?: Promise<BenchmarkOutput>;
  execution?: StoreBenchmarkExecution;
  closing?: Promise<void>;
  recovering?: Promise<void> | undefined;
  ending: boolean;
  settled: boolean;
  cleanupConfirmed: boolean;
  readonly failures: Promise<void>[];
}
function captureBenchmarkInput(value: BenchmarkInput): BenchmarkInput {
  if (!value || typeof value !== "object" || types.isProxy(value)) denied();
  const optional = ["requestId", "groupSize", "candidate", "saveAudio"].filter(
      (field) => Object.hasOwn(value, field),
    ),
    row = storeCpuFields(value, [
      "operation",
      "fixture",
      "recipe",
      "warmupRuns",
      "measuredRuns",
      ...optional,
    ]);
  if (
    optional.some((field) => row[field] === undefined) ||
    types.isProxy(row.fixture)
  )
    denied();
  const fixture = storeCpuFields(row.fixture, [
      "relativePath",
      "bytes",
      "sha256",
    ]),
    requestId = row.requestId ?? randomUUID(),
    operation = row.operation,
    recipe = row.recipe,
    warmupRuns = row.warmupRuns,
    measuredRuns = row.measuredRuns;
  const digest = (item: unknown): item is string =>
    typeof item === "string" && /^[a-f0-9]{64}$/u.test(item);
  if (
    typeof requestId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      requestId,
    ) ||
    (operation !== "benchmark_file" && operation !== "benchmark_capacity") ||
    (recipe !== "kim-vocals-v2" && recipe !== "kim-vocals-v2-trim") ||
    typeof warmupRuns !== "number" ||
    !Number.isInteger(warmupRuns) ||
    warmupRuns < (operation === "benchmark_capacity" ? 1 : 0) ||
    warmupRuns > 2 ||
    typeof measuredRuns !== "number" ||
    !Number.isInteger(measuredRuns) ||
    measuredRuns < 3 ||
    measuredRuns > 10 ||
    typeof fixture.bytes !== "number" ||
    !Number.isSafeInteger(fixture.bytes) ||
    fixture.bytes < 44 ||
    fixture.bytes >
      (operation === "benchmark_capacity" ? 64 : 256) * 1024 ** 2 ||
    !digest(fixture.sha256) ||
    fixture.relativePath !==
      (operation === "benchmark_capacity"
        ? `prepare\\approved\\${fixture.sha256}.wav`
        : `prepare\\work\\${requestId}\\source.wav`) ||
    (row.groupSize !== undefined && row.groupSize !== 1) ||
    (row.saveAudio !== undefined && typeof row.saveAudio !== "boolean") ||
    (operation === "benchmark_capacity" &&
      (recipe !== "kim-vocals-v2" ||
        row.candidate !== undefined ||
        row.saveAudio === true))
  )
    denied();
  let candidate: AdvancedBenchmarkConfiguration["candidate"];
  if (row.candidate !== undefined) {
    if (types.isProxy(row.candidate)) denied();
    const original = storeCpuFields(row.candidate, [
      "release",
      "manifestSha256",
      "engineDigest",
    ]);
    if (
      !digest(original.release) ||
      !digest(original.manifestSha256) ||
      !digest(original.engineDigest)
    )
      denied();
    candidate = Object.freeze({
      release: original.release,
      manifestSha256: original.manifestSha256,
      engineDigest: original.engineDigest,
    });
  }
  return Object.freeze({
    operation,
    fixture: Object.freeze({
      relativePath: fixture.relativePath as string,
      bytes: fixture.bytes,
      sha256: fixture.sha256,
    }),
    recipe,
    warmupRuns,
    measuredRuns,
    requestId,
    ...(row.groupSize === 1 ? { groupSize: 1 as const } : {}),
    ...(candidate ? { candidate } : {}),
    ...(typeof row.saveAudio === "boolean" ? { saveAudio: row.saveAudio } : {}),
  });
}

function denied(): never {
  throw new Error("STORE_FLEET_ADVANCED_REQUIRED");
}
/** The shared Advanced business strategy consumes this actual private factory;
 * DTOs, legacy tickets and protected path descriptions cannot construct it. */
export class StoreFleetAdvancedRuntime {
  #host: HostContext;
  #operations: StorePreparationOperations;
  #connection: StoreDesktopConnection;
  #maintenance: StorePrepareMaintenance;
  #rebind: () => Promise<void>;
  #holding: Holding | undefined;
  #benchmarks = new Map<string, BenchmarkOwner>();
  #rebinding = false;
  #closed = false;
  private constructor(
    token: symbol,
    host: HostContext,
    operations: StorePreparationOperations,
    connection: StoreDesktopConnection,
    maintenance: StorePrepareMaintenance,
    rebind: () => Promise<void>,
  ) {
    if (token !== TOKEN) denied();
    this.#host = host;
    this.#operations = operations;
    this.#connection = connection;
    this.#maintenance = maintenance;
    this.#rebind = rebind;
    Object.freeze(this);
  }
  static open(
    host: HostContext,
    operations: StorePreparationOperations,
    connection: StoreDesktopConnection,
    maintenance: StorePrepareMaintenance,
    rebind: () => Promise<void>,
  ) {
    if (arguments.length !== 5 || typeof rebind !== "function") denied();
    StorePreparationOperations.prototype.assertHost.call(operations, host);
    StoreDesktopConnection.prototype.assertHost.call(
      connection,
      host,
      operations,
    );
    StorePrepareMaintenance.prototype.assertHost.call(maintenance, host);
    return new StoreFleetAdvancedRuntime(
      TOKEN,
      host,
      operations,
      connection,
      maintenance,
      rebind,
    );
  }
  assertHost(host: HostContext) {
    if (arguments.length !== 1 || host !== this.#host || this.#closed) denied();
    StorePreparationOperations.prototype.assertHost.call(
      this.#operations,
      host,
    );
    StoreDesktopConnection.prototype.assertHost.call(
      this.#connection,
      host,
      this.#operations,
    );
    StorePrepareMaintenance.prototype.assertHost.call(this.#maintenance, host);
  }
  mutationActive() {
    if (arguments.length) denied();
    this.assertHost(this.#host);
    return !!this.#holding;
  }
  async authorizeRecovery(): Promise<boolean> {
    if (arguments.length) denied();
    this.assertHost(this.#host);
    const held = this.#holding;
    if (!held) return false;
    const bytes = await this.#host.native.vaultRead(
      "fleet",
      "advanced_journal",
    );
    if (!bytes) return false;
    try {
      const text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
      if (text.charCodeAt(0) === 0xfeff) denied();
      const journal = parseAdvancedJournal(parseStrictJson(text, 16384, 512)),
        store = new VaultFleetStore(this.#host.native, this.#host.identity.sid),
        record = await store.read(),
        tombstone = record ? null : await store.readPurgedTombstone();
      this.assertHost(this.#host);
      return (
        this.#holding === held &&
        journal.phase !== "complete" &&
        journal.transaction === held.transaction &&
        journal.identity.sid === this.#host.identity.sid &&
        (record
          ? journal.identity.digest === fleetRecordAuthority(record) &&
            journal.identity.machineId === record.machineId &&
            journal.identity.revision === record.onboardingRevision
          : !!tombstone &&
            journal.identity.digest === tombstone.authority &&
            journal.identity.machineId === tombstone.machineId &&
            journal.identity.revision === tombstone.onboardingRevision)
      );
    } finally {
      bytes.fill(0);
    }
  }
  async recoverAcquisition(transaction: string) {
    this.assertHost(this.#host);
    const held = this.#holding;
    if (arguments.length !== 1 || !held || held.transaction !== transaction)
      throw new Error("ADVANCED_RECOVERY_REQUIRED");
    // The failed original admission is retained. Explicit recovery settles
    // that exact owner; reacquiring would repeat a permanently rejected ACK.
    await held.opening.catch(() => undefined);
    await this.#release(held);
  }
  authorizesRebind() {
    if (arguments.length) denied();
    this.assertHost(this.#host);
    return !!this.#holding && this.#rebinding;
  }
  async ready(signal: AbortSignal): Promise<StoreAdvancedReadySnapshot> {
    this.assertHost(this.#host);
    const ready =
        await StorePreparationOperations.prototype.snapshotStoreReady.call(
          this.#operations,
          signal,
        ),
      view = await StorePreparationOperations.prototype.mediaCodeView.call(
        this.#operations,
        signal,
      ),
      helper = view.manifest.entries.find(
        (entry) => entry.path === "runtime/native/musicmute-native.exe",
      );
    if (
      !helper ||
      helper.kind !== "file" ||
      JSON.stringify(view.binding) !== JSON.stringify(ready.binding)
    )
      denied();
    this.assertHost(this.#host);
    signal.throwIfAborted();
    return {
      distribution: "microsoft-store",
      archiveSha256: null,
      release: ready.binding.inventorySha256,
      releaseRoot: view.workerRoot,
      releaseVersion: view.manifest.releaseVersion,
      manifestSha256: ready.binding.runtimeManifestSha256,
      nativeSha256: helper.sha256,
      modelSha256: MODEL.sha256,
      bootIdentity: ready.binding.bootIdentity,
      evidence: ready.evidence,
      storeBinding: structuredClone(ready.binding),
    };
  }
  async active(record: FleetEnrollmentRecord, signal: AbortSignal) {
    this.assertHost(this.#host);
    const value = await readStoreFleetRuntimeIdentityForGui(
      this.#host,
      this.#operations,
      record,
      signal,
    );
    this.assertHost(this.#host);
    return value;
  }
  async current(status: LocalRuntimeStatus | null): Promise<boolean> {
    if (arguments.length !== 1) denied();
    this.assertHost(this.#host);
    if (!status?.processId) return false;
    const session =
      await StorePreparationOperations.prototype.controlSession.call(
        this.#operations,
        new AbortController().signal,
        { launchIfAbsent: false },
      );
    if (!session) return false;
    const original =
      await StoreSessionClient.prototype.currentFleetOwner.call(session);
    if (!original || original.identity.pid !== status.processId) return false;
    const root = await this.#host.native.ensurePrivateDirectory("fleet"),
      bytes = await createFleetPrivateFiles(this.#host.native, root).read(
        "state\\runtime-status.json",
        16384,
      );
    let observed: LocalRuntimeStatus;
    try {
      const text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
      if (text.charCodeAt(0) === 0xfeff) denied();
      observed = parseLocalRuntimeStatus(parseStrictJson(text, 16384, 1024));
    } finally {
      bytes.fill(0);
    }
    if (
      !isDeepStrictEqual(status, observed) ||
      !(await StoreSessionClient.prototype.inspectFleetPeer.call(
        session,
        original,
        original.identity,
      ))
    )
      return false;
    const current =
      await StoreSessionClient.prototype.currentFleetOwner.call(session);
    this.assertHost(this.#host);
    return (
      !!current &&
      current.nonce === original.nonce &&
      sameConsumerProcess(current.identity, original.identity)
    );
  }
  maintenancePort() {
    this.assertHost(this.#host);
    return {
      acquire: async (transaction: string, signal: AbortSignal) => {
        this.assertHost(this.#host);
        if (
          !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
            transaction,
          )
        )
          denied();
        let held = this.#holding;
        if (held && held.transaction !== transaction)
          throw new Error("ADVANCED_BUSY");
        if (!held) {
          held = {
            transaction,
            target: undefined,
            setup: null,
            mutation: null,
            opening: Promise.resolve(),
          };
          this.#holding = held;
          const original = held;
          original.opening = Promise.resolve().then(async () => {
            original.target =
              await StorePreparationOperations.prototype.target.call(
                this.#operations,
                signal,
              );
            original.setup =
              await StorePreparationOperations.prototype.lock.call(
                this.#operations,
                original.target,
              );
            if (!original.setup) throw new Error("ADVANCED_BUSY");
            original.mutation =
              await StorePrepareMaintenance.prototype.beforeMutation.call(
                this.#maintenance,
                original.target,
                signal,
              );
          });
          void original.opening.catch(() => {});
        }
        await held.opening;
        return { release: () => this.#release(held!) };
      },
      cancel: async (transaction: string, _signal: AbortSignal) => {
        this.assertHost(this.#host);
        const held = this.#holding;
        if (!held) return this.#cancelUnheld(transaction, _signal);
        if (held.transaction !== transaction)
          throw new Error("ADVANCED_RECOVERY_REQUIRED");
        await this.#release(held);
      },
    };
  }
  async #cancelUnheld(transaction: string, signal: AbortSignal) {
    const present =
      await StorePreparationOperations.prototype.controlSession.call(
        this.#operations,
        signal,
        { launchIfAbsent: false },
      );
    if (!present) return; // actual passive absence, no replacement activation
    const snapshot = await StoreSessionClient.prototype.command.call(
      present,
      { version: 1, request_id: randomUUID(), action: "status" },
      signal,
    );
    this.assertHost(this.#host);
    if (!snapshot.maintenance) return;
    if (
      snapshot.maintenance.transaction !== transaction ||
      snapshot.maintenance.phase !== "idle"
    )
      throw new Error("ADVANCED_RECOVERY_REQUIRED");
    await this.adoptForced(transaction, signal);
    await this.#release(this.#holding!);
  }
  async adoptForced(transaction: string, signal: AbortSignal) {
    this.assertHost(this.#host);
    if (arguments.length !== 2) throw new Error("ADVANCED_BUSY");
    const existing = this.#holding;
    if (existing) {
      if (existing.transaction !== transaction)
        throw new Error("ADVANCED_BUSY");
      await existing.opening;
      if (
        this.#holding !== existing ||
        !existing.target ||
        !existing.setup ||
        !existing.mutation
      )
        throw new Error("ADVANCED_RECOVERY_REQUIRED");
      await StorePreparationOperations.prototype.assertHeldMutation.call(
        this.#operations,
        existing.target,
        signal,
      );
      if (this.#holding !== existing)
        throw new Error("ADVANCED_RECOVERY_REQUIRED");
      return;
    }
    // Do not activate a replacement Session while recovering a force reply.
    const present =
      await StorePreparationOperations.prototype.controlSession.call(
        this.#operations,
        signal,
        { launchIfAbsent: false },
      );
    if (!present) throw new Error("ADVANCED_RECOVERY_REQUIRED");
    const held: Holding = {
      transaction,
      target: undefined,
      setup: null,
      mutation: null,
      opening: Promise.resolve(),
    };
    this.#holding = held;
    held.opening = Promise.resolve().then(async () => {
      held.target = await StorePreparationOperations.prototype.target.call(
        this.#operations,
        signal,
      );
      held.setup = await StorePreparationOperations.prototype.lock.call(
        this.#operations,
        held.target,
      );
      if (!held.setup) throw new Error("ADVANCED_BUSY");
      held.mutation =
        await StorePrepareMaintenance.prototype.beforeForcedMutation.call(
          this.#maintenance,
          held.target,
          transaction,
          signal,
        );
    });
    void held.opening.catch(() => {});
    await held.opening;
  }
  async recoverForcedAdmission(
    transaction: string,
    signal: AbortSignal,
  ): Promise<"ready" | "interrupted"> {
    this.assertHost(this.#host);
    const held = this.#holding;
    if (arguments.length !== 2 || !held || held.transaction !== transaction)
      throw new Error("ADVANCED_RECOVERY_REQUIRED");
    let admitted = false;
    try {
      await held.opening;
      admitted = true;
    } catch {
      /* preserve original failure */
    }
    if (admitted) {
      await this.adoptForced(transaction, signal);
      return "ready";
    }
    // The private admission promise failed before the strategy could execute
    // its backend effect. Settle the exact force/WAL owner, never replay it.
    await this.#release(held);
    return "interrupted";
  }
  #release(held: Holding) {
    if (held.releasing) return held.releasing;
    const attempt = this.#finish(held);
    held.releasing = attempt;
    held.originalRelease ??= attempt;
    void attempt.catch(() => {
      if (held.releasing === attempt) held.releasing = undefined;
    });
    return attempt;
  }
  async #finish(held: Holding) {
    await held.opening.catch(() => undefined);
    this.assertHost(this.#host);
    if (this.#holding !== held) denied();
    const benchmark = this.#benchmarks.get(held.transaction);
    if (benchmark && (!benchmark.settled || !benchmark.cleanupConfirmed))
      throw new Error("ADVANCED_BENCHMARK_TREE_UNCERTAIN");
    if (
      StorePreparationOperations.prototype.cleanupPending.call(this.#operations)
    ) {
      await StorePrepareMaintenance.prototype.recoverMutation.call(
        this.#maintenance,
      );
      await StorePreparationOperations.prototype.recoverCleanup.call(
        this.#operations,
      );
    }
    if (
      StorePrepareMaintenance.prototype.cleanupPending.call(this.#maintenance)
    )
      await StorePrepareMaintenance.prototype.recoverCleanup.call(
        this.#maintenance,
      );
    if (held.setup) {
      await held.setup.release();
      held.setup = null;
    }
    if (held.mutation) {
      await held.mutation.release();
      held.mutation = null;
    }
    await StorePrepareMaintenance.prototype.settle.call(
      this.#maintenance,
      held.opening,
      async () => {
        this.#rebinding = true;
        try {
          await this.#rebind();
        } finally {
          this.#rebinding = false;
        }
      },
    );
    this.#holding = undefined;
    this.#benchmarks.delete(held.transaction);
  }
  async assertAvailable(action: string) {
    if (arguments.length !== 1 || typeof action !== "string") denied();
    this.assertHost(this.#host);
  }
  /** Retain a no-effect staging owner before the business strategy acquires
   * scratch writers. An imported journal cannot construct this private row. */
  stageBenchmark(transaction: string, requestId: string): void {
    if (
      arguments.length !== 2 ||
      typeof requestId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
        requestId,
      )
    )
      denied();
    this.#originalHolding(transaction);
    const prior = this.#benchmarks.get(transaction);
    if (prior) {
      if (prior.requestId !== requestId || prior.ending || prior.task)
        throw new Error("ADVANCED_BUSY");
      return;
    }
    if (this.#benchmarks.size >= 16) throw new Error("ADVANCED_BUSY");
    this.#benchmarks.set(transaction, {
      transaction,
      requestId,
      ending: false,
      settled: true,
      cleanupConfirmed: true,
      failures: [],
    });
  }
  async currentCandidate(release: string, signal: AbortSignal) {
    if (
      arguments.length !== 2 ||
      typeof release !== "string" ||
      !(signal instanceof AbortSignal)
    )
      denied();
    const held = this.#originalHolding();
    await this.#checkHolding(held, signal);
    const session =
        await StorePreparationOperations.prototype.maintenanceSession.call(
          this.#operations,
          signal,
        ),
      view = await StoreSessionClient.prototype.benchmarkCodeView.call(session);
    await this.#checkHolding(held, signal);
    if (release !== view.binding.inventorySha256)
      throw new Error("ADVANCED_CANDIDATE_UNAVAILABLE");
    return Object.freeze({
      release,
      manifestSha256: view.binding.runtimeManifestSha256,
      engineDigest: view.engineDigest,
    });
  }
  runBenchmark(
    transaction: string,
    input: {
      requestId?: string;
      operation: AdvancedBenchmarkConfiguration["operation"];
      fixture: AdvancedBenchmarkConfiguration["fixture"];
      recipe: AdvancedBenchmarkConfiguration["recipe"];
      warmupRuns: number;
      measuredRuns: number;
      groupSize?: 1;
      candidate?: AdvancedBenchmarkConfiguration["candidate"];
      saveAudio?: boolean;
    },
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<WindowsAdvancedBenchmarkRunner["run"]>>> {
    try {
      if (arguments.length !== 3 || !(signal instanceof AbortSignal)) denied();
      const captured = captureBenchmarkInput(input),
        held = this.#originalHolding(transaction);
      let original = this.#benchmarks.get(transaction);
      if (!original) {
        this.stageBenchmark(transaction, captured.requestId!);
        original = this.#benchmarks.get(transaction)!;
      }
      if (original.requestId !== captured.requestId || original.ending)
        throw new Error("ADVANCED_BUSY");
      if (original.input && !isDeepStrictEqual(original.input, captured))
        throw new Error("ADVANCED_BENCHMARK_REQUEST_CHANGED");
      original.input ??= captured;
      if (!original.task) {
        const owner = original;
        owner.settled = false;
        // This exact returned promise and owner exist before any factory IO.
        owner.task = Promise.resolve()
          .then(() => this.#runBenchmark(owner, held, signal))
          .finally(() => {
            owner.settled = true;
          });
        void owner.task.catch(() => {});
      }
      return original.task!;
    } catch (error) {
      return Promise.reject(error);
    }
  }
  #originalHolding(transaction?: string): Holding {
    this.assertHost(this.#host);
    const held = this.#holding;
    if (
      !held ||
      (transaction !== undefined && held.transaction !== transaction) ||
      !held.target ||
      !held.setup ||
      !held.mutation ||
      held.releasing
    )
      throw new Error("ADVANCED_RECOVERY_REQUIRED");
    return held;
  }
  async #checkHolding(held: Holding, signal: AbortSignal) {
    signal.throwIfAborted();
    this.#originalHolding(held.transaction);
    await StorePreparationOperations.prototype.assertHeldMutation.call(
      this.#operations,
      held.target!,
      signal,
    );
    if (this.#holding !== held) denied();
    signal.throwIfAborted();
  }
  async #runBenchmark(
    owner: BenchmarkOwner,
    held: Holding,
    signal: AbortSignal,
  ): Promise<BenchmarkOutput> {
    let result: BenchmarkOutput | undefined,
      originalBinding: StorePreparationBinding | undefined,
      workError: unknown,
      failed = false;
    try {
      await this.#checkHolding(held, signal);
      if (owner.ending || !owner.input) throw new Error("ADVANCED_CANCELLED");
      const ready = await this.ready(signal),
        session =
          await StorePreparationOperations.prototype.maintenanceSession.call(
            this.#operations,
            signal,
          ),
        view =
          await StoreSessionClient.prototype.benchmarkCodeView.call(session);
      if (
        !isDeepStrictEqual(view.binding, ready.storeBinding) ||
        view.helperSha256 !== ready.nativeSha256 ||
        !ready.evidence.gpuIdentity
      )
        throw new Error("ADVANCED_RUNTIME_CHANGED");
      if (
        owner.input.candidate &&
        (owner.input.candidate.release !== view.binding.inventorySha256 ||
          owner.input.candidate.manifestSha256 !==
            view.binding.runtimeManifestSha256 ||
          owner.input.candidate.engineDigest !== view.engineDigest)
      )
        throw new Error("ADVANCED_CANDIDATE_INVALID");
      const gpu = resolveQualifiedGpuIdentity(
          ready.evidence.gpuIdentity,
          await this.#host.native.enumerateGpus(),
        ),
        request = parseStoreBenchmarkRequest(
          Buffer.from(
            JSON.stringify({
              version: 1,
              requestId: owner.requestId,
              operation: owner.input.operation,
              binding: view.binding,
              configuration: {
                version: 1,
                ...owner.input,
                bootIdentity: view.binding.bootIdentity,
                release: view.binding.inventorySha256,
                sid: view.binding.sid,
                manifestSha256: view.binding.runtimeManifestSha256,
                helperSha256: view.helperSha256,
                gpu,
              },
            }),
          ),
        );
      originalBinding = request.binding;
      await this.#checkHolding(held, signal);
      if (owner.ending) throw new Error("ADVANCED_CANCELLED");
      owner.execution = await StoreSessionClient.prototype.openBenchmark.call(
        session,
        request,
      );
      owner.cleanupConfirmed = false;
      StoreBenchmarkExecution.prototype.assertHost.call(
        owner.execution,
        this.#host,
      );
      if (owner.ending) throw new Error("ADVANCED_CANCELLED");
      await StoreBenchmarkExecution.prototype.launch.call(
        owner.execution,
        signal,
      );
      await StoreBenchmarkExecution.prototype.run.call(owner.execution, signal);
      const observation =
          StoreBenchmarkExecution.prototype.resultObservation.call(
            owner.execution,
          ),
        raw = await StoreBenchmarkExecution.prototype.readResult.call(
          owner.execution,
        );
      try {
        const text = new TextDecoder("utf8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(raw);
        if (text.charCodeAt(0) === 0xfeff) denied();
        result = {
          configuration: request.configuration,
          report: validateAdvancedBenchmarkReport(
            parseStrictJson(text, 8 * 1024 ** 2, 16384),
            request.configuration,
            observation.wallSeconds,
          ),
          relativePath: `prepare\\results\\${owner.requestId}.benchmark.json`,
        };
      } finally {
        raw.fill(0);
      }
    } catch (error) {
      failed = true;
      workError = error;
    }
    try {
      await this.#closeBenchmark(owner);
    } catch (error) {
      throw new AggregateError(
        failed ? [workError, error] : [error],
        "ADVANCED_BENCHMARK_CLEANUP_UNCONFIRMED",
      );
    }
    if (failed) throw workError;
    if (!result) denied();
    await this.#checkHolding(held, signal);
    const current = await this.ready(signal);
    if (
      !isDeepStrictEqual(current.storeBinding, originalBinding) ||
      current.nativeSha256 !== result.configuration.helperSha256
    )
      throw new Error("ADVANCED_RUNTIME_CHANGED");
    const bytes = Buffer.from(JSON.stringify(result.report));
    try {
      if (bytes.length > 2 * 1024 ** 2)
        throw new Error("ADVANCED_RESULT_TOO_LARGE");
      await writePrivateAtomic(this.#host, result.relativePath, bytes);
      await this.#checkHolding(held, signal);
      return result;
    } finally {
      bytes.fill(0);
    }
  }
  #closeBenchmark(owner: BenchmarkOwner): Promise<void> {
    owner.ending = true;
    if (owner.cleanupConfirmed) return Promise.resolve();
    if (!owner.execution)
      return Promise.reject(new Error("ADVANCED_BENCHMARK_TREE_UNCERTAIN"));
    owner.closing ??= StoreBenchmarkExecution.prototype.close
      .call(owner.execution)
      .then(() => {
        owner.cleanupConfirmed = true;
      });
    void owner.closing.catch(() => {});
    return owner.closing;
  }
  async recoverBenchmark(transaction: string): Promise<void> {
    if (arguments.length !== 1) denied();
    this.assertHost(this.#host);
    // Original cleanup remains reachable after its Prepare lease was released
    // and a later maintenance/end/rebind ACK failed. No new launch is allowed.
    if (this.#holding?.transaction !== transaction)
      throw new Error("ADVANCED_RECOVERY_REQUIRED");
    const original = this.#benchmarks.get(transaction);
    if (!original) throw new Error("ADVANCED_BENCHMARK_TREE_UNCERTAIN");
    if (original.recovering) return original.recovering;
    original.ending = true;
    const attempt = (async () => {
      // Close the original execution concurrently with its event waiter, then
      // join the original task so an in-construction factory cannot escape.
      const closing = this.#closeBenchmark(original);
      await closing.catch(() => {});
      await original.task?.catch(() => {});
      if (original.cleanupConfirmed) return;
      if (!original.execution || !original.closing)
        throw new Error("ADVANCED_BENCHMARK_TREE_UNCERTAIN");
      if (!original.failures.includes(original.closing))
        original.failures.push(original.closing);
      await StoreBenchmarkExecution.prototype.recoverClose.call(
        original.execution,
      );
      original.cleanupConfirmed = true;
    })();
    original.recovering = attempt;
    void attempt.then(
      () => {
        if (original.recovering === attempt) original.recovering = undefined;
      },
      () => {
        if (original.recovering === attempt) original.recovering = undefined;
      },
    );
    return attempt;
  }
  async close() {
    if (this.#holding) throw new Error("ADVANCED_RECOVERY_REQUIRED");
    this.#closed = true;
  }
}
