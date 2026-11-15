import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import type { WorkerEnrollmentClient } from "../../../../worker/src/enrollment/enrollment-client.js";
import {
  createWindowsUserReportFromRuntimeObservations,
  currentHost,
  parseQualificationEvidence,
  resolveQualifiedGpuIdentity,
} from "../../../../worker/src/enrollment/report-builder.js";
import { StorePreparationOperations } from "../prepare/store-operations.js";
import { StorePrepareMaintenance } from "../prepare/store-maintenance.js";
import type { PrepareLease, PrepareTarget } from "../prepare/controller.js";
import { PREPARATION_FIXTURE } from "../prepare/fixture.js";
import type { StorePreparationBinding } from "../prepare/store-model-ready.js";
import {
  hashPrivateFile,
  writePrivateAtomic,
} from "../prepare/private-files.js";
import type { HostContext } from "../host-context.js";
import { STORE_PRODUCTS } from "../../shared/store-contracts.js";
import {
  uploadPreparedFleetQualification,
  type FleetPreparationPort,
} from "./controller.js";
import {
  parseFleetRecord,
  type FleetEnrollmentRecord,
  type FleetPreparedIdentity,
  type StoreFleetPreparedIdentity,
} from "./store.js";
import { downloadStoreQualificationFixture } from "./store-fixture-transfer.js";

const TOKEN = Symbol("store-fleet-preparation");
function denied(): never {
  throw new Error("FLEET_PREPARE_REQUIRED");
}
interface Options {
  label?: string;
  fetch?: typeof fetch;
  maintenance?: StorePrepareMaintenance;
  rebind?: () => Promise<void>;
}
interface FleetQualificationOwner {
  enrollment: FleetEnrollmentRecord;
  setup: PrepareLease | null;
  mutation: PrepareLease | null;
  task: Promise<StoreFleetPreparedIdentity>;
  settling?: Promise<void> | undefined;
  originalSettlement?: Promise<void>;
}

/** Preserve the existing enrollment/approval/upload flow using the actual
 * Store code owner. Fixture grants contain data only; no archive/legacy update
 * signature is substituted for the living package or a physical GPU lease. */
export class StoreFleetPreparation implements FleetPreparationPort {
  #host: HostContext;
  #operations: StorePreparationOperations;
  #options: Options;
  #owned: FleetQualificationOwner | undefined;
  private constructor(
    token: symbol,
    host: HostContext,
    operations: StorePreparationOperations,
    options: Options,
  ) {
    if (token !== TOKEN) denied();
    this.#host = host;
    this.#operations = operations;
    this.#options = Object.freeze({ ...options });
    Object.freeze(this);
  }
  static open(
    host: HostContext,
    operations: StorePreparationOperations,
    options: Options = {},
  ) {
    if (
      arguments.length < 2 ||
      arguments.length > 3 ||
      !options ||
      Object.getPrototypeOf(options) !== Object.prototype ||
      Reflect.ownKeys(options).some(
        (key) =>
          !["label", "fetch", "maintenance", "rebind"].includes(String(key)),
      )
    )
      denied();
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(options),
    )) {
      if (
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        (key === "label"
          ? typeof descriptor.value !== "string"
          : key === "maintenance"
            ? !descriptor.value
            : typeof descriptor.value !== "function")
      )
        denied();
    }
    StorePreparationOperations.prototype.assertHost.call(operations, host);
    if (!options.maintenance || !options.rebind) denied();
    StorePrepareMaintenance.prototype.assertHost.call(
      options.maintenance,
      host,
    );
    return new StoreFleetPreparation(TOKEN, host, operations, options);
  }
  async #ready(signal: AbortSignal) {
    StorePreparationOperations.prototype.assertHost.call(
      this.#operations,
      this.#host,
    );
    const ready =
      await StorePreparationOperations.prototype.snapshotStoreReady.call(
        this.#operations,
        signal,
      );
    StorePreparationOperations.prototype.assertHost.call(
      this.#operations,
      this.#host,
    );
    return ready;
  }
  /** Main may exempt only its exact enrolled controller/scope from its own
   * qualification drain. This observation cannot authorize mutation or work. */
  qualificationActive(): boolean {
    if (arguments.length !== 0 || !this.#options.maintenance) denied();
    StorePreparationOperations.prototype.assertHost.call(
      this.#operations,
      this.#host,
    );
    StorePrepareMaintenance.prototype.assertHost.call(
      this.#options.maintenance,
      this.#host,
    );
    return this.#owned !== undefined;
  }
  async #report(
    raw: unknown,
    binding: StorePreparationBinding,
    fixture: string,
    label: string,
    signal: AbortSignal,
  ) {
    StorePreparationOperations.prototype.assertHost.call(
      this.#operations,
      this.#host,
    );
    const identity = await this.#host.native.identity(),
      view = await StorePreparationOperations.prototype.mediaCodeView.call(
        this.#operations,
        signal,
      );
    if (
      identity.sid !== this.#host.identity.sid ||
      identity.sessionId !== this.#host.identity.sessionId ||
      binding.sid !== identity.sid ||
      JSON.stringify(binding) !== JSON.stringify(view.binding) ||
      view.manifest.releaseVersion !== STORE_PRODUCTS.worker.appVersion
    )
      denied();
    const report = createWindowsUserReportFromRuntimeObservations({
      label,
      host: currentHost(),
      expectedUserSid: identity.sid,
      expectedFixtureDigest: fixture,
      workerVersion: view.manifest.releaseVersion,
      manifestDigest: binding.runtimeManifestSha256,
      modelDigest: MODEL.sha256,
      diagnostics: {
        status: "ok",
        ...parseQualificationEvidence(raw, {
          runtimeProfile: "windows-user",
          expectedUserSid: identity.sid,
          expectedFixtureDigest: fixture,
        }).runtimeDiagnostics,
      },
      qualification: raw,
      currentGpus: await this.#host.native.enumerateGpus(),
      recipeDigests: binding.recipeDigests,
    });
    const current =
        await StorePreparationOperations.prototype.mediaCodeView.call(
          this.#operations,
          signal,
        ),
      after = await this.#host.native.identity();
    if (
      JSON.stringify(current.binding) !== JSON.stringify(binding) ||
      after.sid !== identity.sid ||
      after.sessionId !== identity.sessionId
    )
      denied();
    StorePreparationOperations.prototype.assertHost.call(
      this.#operations,
      this.#host,
    );
    signal.throwIfAborted();
    return report;
  }
  async snapshot(signal: AbortSignal): Promise<StoreFleetPreparedIdentity> {
    const ready = await this.#ready(signal);
    if (!ready.evidence.gpuIdentity) denied();
    const report = await this.#report(
      ready.receipt.qualification,
      ready.binding,
      PREPARATION_FIXTURE.sha256,
      this.#options.label ?? "MusicMute Windows",
      signal,
    );
    return {
      distribution: "microsoft-store",
      archiveDigest: null,
      storeBinding: structuredClone(ready.binding),
      bootIdentity: ready.binding.bootIdentity,
      release: ready.binding.inventorySha256,
      manifestDigest: ready.binding.runtimeManifestSha256,
      modelDigest: MODEL.sha256,
      fixtureDigest: PREPARATION_FIXTURE.sha256,
      gpu: ready.evidence.gpuIdentity,
      qualificationPath: null,
      output: {
        path: ready.evidence.uploadCandidate.path,
        bytes: ready.evidence.uploadCandidate.resultBytes,
        sha256: ready.evidence.uploadCandidate.resultDigest,
      },
      report,
    };
  }
  async verify(
    identity: FleetPreparedIdentity,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      identity.distribution !== "microsoft-store" ||
      identity.archiveDigest !== null
    )
      denied();
    const ready = await this.#ready(signal);
    if (
      JSON.stringify(identity.storeBinding) !== JSON.stringify(ready.binding) ||
      identity.release !== ready.binding.inventorySha256 ||
      identity.manifestDigest !== ready.binding.runtimeManifestSha256 ||
      identity.bootIdentity !== ready.binding.bootIdentity ||
      identity.modelDigest !== MODEL.sha256 ||
      !ready.evidence.gpuIdentity
    )
      denied();
    resolveQualifiedGpuIdentity(identity.gpu, [ready.evidence.gpuIdentity]);
  }
  async qualify(
    record: FleetEnrollmentRecord,
    client: WorkerEnrollmentClient,
    signal: AbortSignal,
  ): Promise<StoreFleetPreparedIdentity> {
    const maintenance = this.#options.maintenance;
    if (!maintenance || !this.#options.rebind) denied();
    StorePrepareMaintenance.prototype.assertHost.call(maintenance, this.#host);
    if (this.#owned) {
      const previous = this.#owned;
      if (
        !isDeepStrictEqual(
          previous.enrollment,
          parseFleetRecord(record, this.#host.identity.sid),
        )
      )
        denied();
      await this.#settleQualification(previous);
      // Recover the exact old task; never replay its qualification effects as
      // an implicit consequence of an uncertain cleanup acknowledgement.
      return previous.task;
    }
    const owned = {
      enrollment: parseFleetRecord(record, this.#host.identity.sid),
      setup: null as PrepareLease | null,
      mutation: null as PrepareLease | null,
      task: undefined as unknown as Promise<StoreFleetPreparedIdentity>,
    };
    owned.task = Promise.resolve().then(async () => {
      const target = await StorePreparationOperations.prototype.target.call(
        this.#operations,
        signal,
      );
      owned.setup = await StorePreparationOperations.prototype.lock.call(
        this.#operations,
        target,
      );
      if (!owned.setup) throw new Error("FLEET_PREPARE_BUSY");
      owned.mutation =
        await StorePrepareMaintenance.prototype.beforeMutation.call(
          maintenance,
          target,
          signal,
        );
      return this.#qualifyRecord(owned.enrollment, client, target, signal);
    });
    this.#owned = owned;
    let result: StoreFleetPreparedIdentity | undefined;
    let failure: unknown;
    try {
      result = await owned.task;
    } catch (error) {
      failure = error;
    }
    try {
      await this.#settleQualification(owned);
    } catch (error) {
      if (failure !== undefined)
        throw new AggregateError(
          [failure, error],
          "FLEET_QUALIFICATION_CLEANUP_UNCONFIRMED",
        );
      throw error;
    }
    if (failure !== undefined) throw failure;
    if (!result) denied();
    return result;
  }
  #settleQualification(owned: FleetQualificationOwner): Promise<void> {
    if (owned.settling) return owned.settling;
    const attempt = this.#finishQualification(owned);
    owned.settling = attempt;
    owned.originalSettlement ??= attempt;
    // Only an explicit later qualify call joins recovery of this exact owner.
    // The original task/closure result is retained; qualification is not run again.
    void attempt.catch(() => {
      if (owned.settling === attempt) owned.settling = undefined;
    });
    return attempt;
  }
  async #finishQualification(owned: FleetQualificationOwner) {
    await owned.task.catch(() => undefined);
    const maintenance = this.#options.maintenance;
    if (!maintenance || !this.#options.rebind || this.#owned !== owned)
      denied();
    StorePreparationOperations.prototype.assertHost.call(
      this.#operations,
      this.#host,
    );
    StorePrepareMaintenance.prototype.assertHost.call(maintenance, this.#host);
    if (
      StorePreparationOperations.prototype.cleanupPending.call(this.#operations)
    ) {
      await StorePrepareMaintenance.prototype.recoverMutation.call(maintenance);
      await StorePreparationOperations.prototype.recoverCleanup.call(
        this.#operations,
      );
    }
    if (StorePrepareMaintenance.prototype.cleanupPending.call(maintenance))
      await StorePrepareMaintenance.prototype.recoverCleanup.call(maintenance);
    // Resume needs the original native Prepare mutex positively released.
    if (owned.setup) {
      await owned.setup.release();
      owned.setup = null;
    }
    if (owned.mutation) {
      await owned.mutation.release();
      owned.mutation = null;
    }
    await StorePrepareMaintenance.prototype.settle.call(
      maintenance,
      owned.task,
      this.#options.rebind,
    );
    this.#owned = undefined;
  }
  async #qualifyRecord(
    record: FleetEnrollmentRecord,
    client: WorkerEnrollmentClient,
    target: PrepareTarget,
    signal: AbortSignal,
  ): Promise<StoreFleetPreparedIdentity> {
    await this.verify(record.prepared, signal);
    if (
      record.prepared.distribution !== "microsoft-store" ||
      record.sid !== this.#host.identity.sid ||
      !record.installationId ||
      !record.installationCredential
    )
      denied();
    const artifacts = await client.storeQualificationArtifacts(
      record.installationId,
      record.installationCredential,
      signal,
    );
    if (
      artifacts.model.sha256 !== MODEL.sha256 ||
      artifacts.model.bytes !== MODEL.bytes ||
      artifacts.model.filename !== MODEL.filename ||
      artifacts.fixture.bytes < 44 ||
      artifacts.fixture.bytes > 64 * 1024 ** 2 ||
      Date.parse(artifacts.fixture.expiresAt) <= Date.now()
    )
      denied();
    const transferred = await downloadStoreQualificationFixture({
        host: this.#host,
        operations: this.#operations,
        fixture: artifacts.fixture,
        signal,
        ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
      }),
      relative = transferred.relativePath;
    if (
      (await hashPrivateFile(
        this.#host,
        relative,
        artifacts.fixture.bytes,
        signal,
      )) !== artifacts.fixture.sha256
    )
      denied();
    const result =
        await StorePreparationOperations.prototype.qualifyApprovedFixtureHeld.call(
          this.#operations,
          target,
          {
            relativePath: relative,
            bytes: artifacts.fixture.bytes,
            sha256: artifacts.fixture.sha256,
          },
          signal,
        ),
      evidence = parseQualificationEvidence(result.raw, {
        runtimeProfile: "windows-user",
        expectedUserSid: record.sid,
        expectedFixtureDigest: artifacts.fixture.sha256,
      }),
      ready = await this.#ready(signal);
    if (
      evidence.releaseManifestDigest !== ready.binding.runtimeManifestSha256 ||
      evidence.modelDigest !== MODEL.sha256 ||
      result.bootIdentity !== ready.binding.bootIdentity ||
      !evidence.gpuIdentity
    )
      denied();
    resolveQualifiedGpuIdentity(record.prepared.gpu, [evidence.gpuIdentity]);
    const report = await this.#report(
        result.raw,
        ready.binding,
        artifacts.fixture.sha256,
        record.label,
        signal,
      ),
      qualificationRelative = `prepare\\approved\\qualification-${createHash("sha256").update(record.requests.report).digest("hex")}.json`;
    await writePrivateAtomic(
      this.#host,
      qualificationRelative,
      Buffer.from(JSON.stringify(result.raw)),
    );
    await this.verify(record.prepared, signal);
    return {
      ...record.prepared,
      storeBinding: structuredClone(ready.binding),
      bootIdentity: ready.binding.bootIdentity,
      fixtureDigest: evidence.fixtureDigest,
      gpu: evidence.gpuIdentity,
      qualificationPath: win32.join(
        this.#host.personalRoot,
        qualificationRelative,
      ),
      output: {
        path: evidence.uploadCandidate.path,
        bytes: evidence.uploadCandidate.resultBytes,
        sha256: evidence.uploadCandidate.resultDigest,
      },
      report,
    };
  }
  async upload(
    record: FleetEnrollmentRecord,
    client: WorkerEnrollmentClient,
    signal: AbortSignal,
  ): Promise<void> {
    await this.verify(record.prepared, signal);
    const relative = win32.relative(
      this.#host.personalRoot,
      record.prepared.output.path,
    );
    if (
      (await hashPrivateFile(
        this.#host,
        relative,
        record.prepared.output.bytes,
        signal,
      )) !== record.prepared.output.sha256
    )
      denied();
    await uploadPreparedFleetQualification(
      record,
      client,
      signal,
      this.#options.fetch,
    );
  }
}
