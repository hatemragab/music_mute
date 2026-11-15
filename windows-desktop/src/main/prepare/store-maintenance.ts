import { randomUUID } from "node:crypto";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import {
  sameConsumerProcess,
  processIdentityFromWire,
  processIdentityToWire,
  type ConsumerProcessIdentity,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  StoreNativeAuthority,
  storeAuthorityForDataNative,
} from "../browser/store-native.js";
import type { HostContext } from "../host-context.js";
import { StoreSessionClient } from "../session/store-session-client.js";
import type { SessionSnapshot } from "../../shared/session-contracts.js";
import type {
  PrepareLease,
  PrepareMutationAdmission,
  PrepareTarget,
} from "./controller.js";
import { PREPARE_MAINTENANCE_KEY } from "./maintenance.js";
import {
  DesktopMaintenanceGate,
  type MaintenanceIntakeReservation,
} from "../maintenance-gate.js";
import { createDesktopFleetRecoveryActivity } from "../fleet/desktop-maintenance.js";

interface StoreMaintenanceRecord {
  version: 2;
  distribution: "microsoft-store";
  sid: string;
  target: string;
  transaction: string;
  owner: ConsumerProcessIdentity;
  authority: ConsumerProcessIdentity | null;
  instance: string | null;
  phase: "reserving" | "draining" | "drained" | "ending" | "ended";
  endRequest: string;
  resumeRequest: string;
}
export interface StorePrepareMaintenanceOptions {
  host: HostContext;
  gate: DesktopMaintenanceGate;
  /** Borrow the operations owner's genuine code/client. No second lease. */
  session(signal: AbortSignal): Promise<StoreSessionClient>;
  /** Pause GUI/browser consumers; keep the control Session and account owner. */
  pauseConsumers(reservation: MaintenanceIntakeReservation): Promise<void>;
  changed?(): void;
}
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
function denied(): never {
  throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
}
function parse(value: unknown, sid: string): StoreMaintenanceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) denied();
  const row = value as StoreMaintenanceRecord;
  if (
    Object.keys(row).sort().join() !==
      "authority,distribution,endRequest,instance,owner,phase,resumeRequest,sid,target,transaction,version" ||
    row.version !== 2 ||
    row.distribution !== "microsoft-store" ||
    row.sid !== sid ||
    typeof row.target !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.target) ||
    typeof row.transaction !== "string" ||
    !UUID.test(row.transaction) ||
    typeof row.endRequest !== "string" ||
    !UUID.test(row.endRequest) ||
    typeof row.resumeRequest !== "string" ||
    !UUID.test(row.resumeRequest) ||
    (row.instance !== null &&
      (typeof row.instance !== "string" || !UUID.test(row.instance))) ||
    !["reserving", "draining", "drained", "ending", "ended"].includes(row.phase)
  )
    denied();
  row.owner = processIdentityFromWire(processIdentityToWire(row.owner));
  if (row.authority !== null)
    row.authority = processIdentityFromWire(
      processIdentityToWire(row.authority),
    );
  if (
    row.owner.sid !== sid ||
    (row.authority && row.authority.sid !== sid) ||
    (row.authority === null) !== (row.instance === null)
  )
    denied();
  return structuredClone(row);
}

/** Store mutation drains role Jobs/GPU under the live Session. It never sends
 * maintenance_commit, retires the SessionNode, or imports legacy Ready proof. */
export class StorePrepareMaintenance implements PrepareMutationAdmission {
  #record: StoreMaintenanceRecord | null = null;
  #authority: StoreNativeAuthority;
  #client: StoreSessionClient | undefined;
  #opening: Promise<StoreSessionClient> | undefined;
  #activity;
  #activityLease:
    | Awaited<
        ReturnType<
          ReturnType<
            typeof createDesktopFleetRecoveryActivity
          >["consumerActivity"]["acquire"]
        >
      >
    | undefined;
  #restored = false;
  #owned = false;
  #failed = false;
  #released = false;
  #drained = false;
  #rebinding = false;
  #mutationSettled = false;
  #cancelled = false;
  #resumed = false;
  #intakeCommitAttempted = false;
  #reclaimControl = false;
  #entering: Promise<PrepareLease> | undefined;
  #settling: Promise<void> | undefined;
  constructor(private readonly options: StorePrepareMaintenanceOptions) {
    const authority = options.host.storeAuthority;
    if (
      !authority ||
      storeAuthorityForDataNative(options.host.native) !== authority
    )
      denied();
    StoreNativeAuthority.prototype.creatorProof.call(authority);
    this.#authority = authority;
    this.#activity = createDesktopFleetRecoveryActivity(
      options.gate,
      options.pauseConsumers,
    );
  }
  assertHost(host: HostContext): void {
    if (
      arguments.length !== 1 ||
      host !== this.options.host ||
      host.storeAuthority !== this.#authority ||
      storeAuthorityForDataNative(host.native) !== this.#authority
    )
      denied();
    StoreNativeAuthority.prototype.creatorProof.call(this.#authority);
  }
  #changed() {
    try {
      this.options.changed?.();
    } catch {}
  }
  busy() {
    return (
      this.#failed || !!this.#record || !!this.#entering || !!this.#settling
    );
  }
  admitting() {
    return !!this.#entering;
  }
  recoveryPending() {
    return this.#failed;
  }
  cleanupPending() {
    return this.#failed && this.#owned && !!this.#record;
  }
  ownsReservation() {
    return this.#activity.ownsReservation();
  }
  authorizesRebind() {
    return (
      this.#rebinding && this.#released && (this.#drained || this.#cancelled)
    );
  }
  snapshot() {
    return {
      busy: this.busy(),
      recoveryPending: this.#failed,
      admitting: this.admitting(),
      drained: this.#drained,
      controllerReleased: this.#released,
      rebinding: this.#rebinding,
    };
  }
  async #gui() {
    if (
      this.options.host.storeAuthority !== this.#authority ||
      storeAuthorityForDataNative(this.options.host.native) !== this.#authority
    )
      denied();
    const proof = StoreNativeAuthority.prototype.creatorProof.call(
        this.#authority,
      ),
      actual = await this.options.host.processIdentity(process.pid);
    if (
      !actual ||
      !sameConsumerProcess(actual, proof.gui) ||
      actual.pid !== process.pid ||
      actual.sid !== this.options.host.identity.sid ||
      actual.sessionId !== this.options.host.identity.sessionId
    )
      denied();
    return actual;
  }
  async restore() {
    if (this.#restored) return;
    await this.#gui();
    const bytes = await this.options.host.native.vaultRead(
      "account",
      PREPARE_MAINTENANCE_KEY,
    );
    try {
      if (bytes) {
        if (bytes.length > 4096) denied();
        this.#failed = true;
        this.#record = parse(
          parseStrictJson(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            4096,
          ),
          this.options.host.identity.sid,
        );
      }
      this.#restored = true;
    } catch (error) {
      this.#failed = true;
      throw error;
    } finally {
      bytes?.fill(0);
      this.#changed();
    }
  }
  async #persist() {
    if (!this.#record) denied();
    parse(this.#record, this.options.host.identity.sid);
    await this.options.host.native.vaultWrite(
      "account",
      PREPARE_MAINTENANCE_KEY,
      Buffer.from(JSON.stringify(this.#record)),
    );
  }
  async #session(signal: AbortSignal) {
    this.#opening ??= this.options.session(signal).then((client) => {
      // Private-brand methods, rather than a caller-created transport adapter.
      StoreSessionClient.prototype.currentAuthority.call(client);
      this.#client = client;
      return client;
    });
    const client = this.#client ?? (await this.#opening);
    signal.throwIfAborted();
    return client;
  }
  #sameSession(client: StoreSessionClient, snapshot: SessionSnapshot) {
    const record = this.#record,
      current = StoreSessionClient.prototype.currentAuthority.call(client);
    if (
      !record ||
      !current ||
      !record.authority ||
      !sameConsumerProcess(current, record.authority) ||
      snapshot.instance_id !== record.instance ||
      !/^[a-f0-9]{64}$/u.test(snapshot.release)
    )
      denied();
  }
  async #status(signal: AbortSignal) {
    const client = await this.#session(signal),
      snapshot = await StoreSessionClient.prototype.command.call(
        client,
        { version: 1, request_id: randomUUID(), action: "status" },
        signal,
      );
    this.#sameSession(client, snapshot);
    return snapshot;
  }
  async #idle(signal: AbortSignal) {
    const snapshot = await this.#status(signal);
    if (
      !snapshot.maintenance ||
      snapshot.maintenance.transaction !== this.#record?.transaction ||
      snapshot.maintenance.phase !== "idle"
    )
      denied();
    return snapshot;
  }
  async #claim(target: PrepareTarget, signal: AbortSignal) {
    await this.restore();
    signal.throwIfAborted();
    const owner = await this.#gui();
    if (
      this.#rebinding ||
      (this.#failed && !this.#record) ||
      target.sid !== owner.sid ||
      !/^[a-f0-9]{64}$/u.test(target.identity)
    )
      denied();
    if (this.#record && !this.#owned) {
      const old = await this.options.host.processIdentity(
        this.#record.owner.pid,
      );
      if (old && sameConsumerProcess(old, this.#record.owner))
        throw new Error("PREPARE_MAINTENANCE_BUSY");
      this.#record.owner = owner;
      this.#reclaimControl = this.#record.authority !== null;
      if (this.#record.phase === "ending" || this.#record.phase === "ended")
        this.#record.phase = "reserving";
      this.#owned = true;
    }
    this.#record ??= {
      version: 2,
      distribution: "microsoft-store",
      sid: owner.sid,
      target: target.identity,
      transaction: randomUUID(),
      endRequest: randomUUID(),
      resumeRequest: randomUUID(),
      owner,
      authority: null,
      instance: null,
      phase: "reserving",
    };
    this.#owned = true;
    if (this.#record.target !== target.identity) denied();
  }
  beforeMutation(
    target: PrepareTarget,
    signal: AbortSignal,
  ): Promise<PrepareLease> {
    this.#entering ??= this.#enter(target, signal).finally(() => {
      this.#entering = undefined;
      this.#changed();
    });
    this.#changed();
    return this.#entering;
  }
  /** Adopt only the actual live Session's acknowledged force drain. The
   * transaction string alone never grants a fence or changes an existing WAL. */
  async beforeForcedMutation(
    target: PrepareTarget,
    transaction: string,
    signal: AbortSignal,
  ): Promise<PrepareLease> {
    if (arguments.length !== 3 || !UUID.test(transaction)) denied();
    await this.restore();
    if (this.#record && this.#record.transaction !== transaction) denied();
    const client = await this.#session(signal),
      authority = StoreSessionClient.prototype.currentAuthority.call(client),
      snapshot = await StoreSessionClient.prototype.command.call(
        client,
        { version: 1, request_id: randomUUID(), action: "status" },
        signal,
      );
    if (
      !authority ||
      snapshot.maintenance?.transaction !== transaction ||
      snapshot.maintenance.phase !== "idle"
    )
      denied();
    const existing = this.#record;
    await this.#claim(target, signal);
    if (existing && this.#record !== existing) denied();
    const record = this.#record!;
    if (!existing) record.transaction = transaction;
    record.authority ??= authority;
    record.instance ??= snapshot.instance_id;
    this.#sameSession(client, snapshot);
    // beforeMutation reissues maintenance_begin through the real current
    // peer; the Supervisor rejects a different still-live owner and drains
    // afresh after positively observed dead-owner adoption.
    return this.beforeMutation(target, signal);
  }
  async #enter(
    target: PrepareTarget,
    signal: AbortSignal,
  ): Promise<PrepareLease> {
    await this.#claim(target, signal);
    const record = this.#record!;
    if (record.phase === "ending" || record.phase === "ended") denied();
    this.#released = false;
    try {
      await this.#persist();
      this.#activityLease ??= await this.#activity.consumerActivity.acquire(
        record.transaction,
        signal,
      );
      const client = await this.#session(signal),
        authority = StoreSessionClient.prototype.currentAuthority.call(client);
      if (
        !authority ||
        authority.sid !== record.sid ||
        (record.authority && !sameConsumerProcess(authority, record.authority))
      )
        denied();
      const observed = await StoreSessionClient.prototype.command.call(
        client,
        { version: 1, request_id: randomUUID(), action: "status" },
        signal,
      );
      record.authority ??= authority;
      record.instance ??= observed.instance_id;
      this.#sameSession(client, observed);
      record.phase = "draining";
      await this.#persist();
      // Publish the exact live control owner before mutation IO. A lost begin
      // ACK must retain enough lineage to end/recover that same transaction.
      let snapshot = await StoreSessionClient.prototype.command.call(
        client,
        {
          version: 1,
          request_id: randomUUID(),
          action: "maintenance_begin",
          transaction: record.transaction,
        },
        signal,
      );
      this.#sameSession(client, snapshot);
      while (
        snapshot.maintenance?.transaction === record.transaction &&
        snapshot.maintenance.phase === "draining"
      ) {
        const next = await StoreSessionClient.prototype.waitState.call(
          client,
          snapshot.revision,
          snapshot.instance_id,
          signal,
        );
        signal.throwIfAborted();
        this.#sameSession(client, next);
        if (next.revision < snapshot.revision) denied();
        snapshot = next;
      }
      if (
        snapshot.maintenance?.transaction !== record.transaction ||
        snapshot.maintenance.phase !== "idle"
      )
        denied();
      await this.#idle(signal);
      this.#intakeCommitAttempted = true;
      await this.#activity.commit();
      record.phase = "drained";
      await this.#persist();
      this.#drained = true;
      this.#reclaimControl = false;
      this.#failed = false;
      return {
        release: async () => {
          if (this.#record !== record || !this.#owned || !this.#drained)
            denied();
          await this.#activityLease!.release();
          this.#released = true;
          this.#changed();
        },
      };
    } catch (error) {
      this.#failed = true;
      throw error;
    } finally {
      this.#changed();
    }
  }
  async assertMutation(target: PrepareTarget) {
    try {
      const record = this.#record;
      if (
        !record ||
        !this.#owned ||
        this.#failed ||
        this.#released ||
        this.#rebinding ||
        !this.#drained ||
        record.phase !== "drained" ||
        record.target !== target.identity ||
        record.sid !== target.sid ||
        !this.#activityLease ||
        !this.#activity.ownsReservation()
      )
        denied();
      if (!sameConsumerProcess(await this.#gui(), record.owner)) denied();
      await this.#activityLease.assertIdle(AbortSignal.timeout(30_000));
      await this.#idle(AbortSignal.timeout(30_000));
      if (
        this.#record !== record ||
        this.#released ||
        !this.#activity.ownsReservation()
      )
        denied();
    } catch (error) {
      this.#failed = true;
      this.#changed();
      throw error;
    }
  }
  async recoverBeforeReady(target: PrepareTarget, signal: AbortSignal) {
    await this.restore();
    return this.#record ? this.beforeMutation(target, signal) : null;
  }
  async recoverMutation() {
    if (
      !this.#record ||
      !this.#owned ||
      this.#released ||
      this.#record.phase !== "drained"
    )
      denied();
    await this.beforeMutation(
      { sid: this.#record.sid, identity: this.#record.target },
      AbortSignal.timeout(30_000),
    );
  }
  async recoverCleanup() {
    if (!this.#record || !this.#owned || this.#released) return;
    const lease = await this.beforeMutation(
      { sid: this.#record.sid, identity: this.#record.target },
      AbortSignal.timeout(30_000),
    );
    await lease.release();
  }
  async cancelRecovery(target: PrepareTarget, signal: AbortSignal) {
    await this.restore();
    if (!this.#record) {
      if (this.#failed) denied();
      return null;
    }
    await this.#claim(target, signal);
    if (this.#record!.phase === "drained" || this.#reclaimControl)
      return this.beforeMutation(target, signal);
    await this.cancelCleanup();
    return null;
  }
  async #end() {
    const record = this.#record;
    if (!record || !this.#owned) denied();
    if (!sameConsumerProcess(await this.#gui(), record.owner)) denied();
    if (record.authority) {
      const client = await this.#session(AbortSignal.timeout(30_000));
      record.phase = "ending";
      await this.#persist();
      const snapshot = await StoreSessionClient.prototype.command.call(
        client,
        {
          version: 1,
          request_id: record.endRequest,
          action: "maintenance_end",
          transaction: record.transaction,
        },
        AbortSignal.timeout(30_000),
      );
      this.#sameSession(client, snapshot);
      if (snapshot.maintenance) denied();
    }
    record.phase = "ended";
    await this.#persist();
  }
  async cancelCleanup() {
    if (!this.#record || !this.#owned) return;
    if (this.#cancelled && this.#mutationSettled) return;
    if (
      this.#drained ||
      this.#record.phase === "drained" ||
      this.#reclaimControl ||
      this.#intakeCommitAttempted
    )
      return this.recoverCleanup();
    try {
      await this.#end();
      await this.#activityLease?.release();
      if (this.#activity.ownsReservation()) denied();
      await this.options.host.native.vaultDelete(
        "account",
        PREPARE_MAINTENANCE_KEY,
      );
      // Controller cancellation still owns its actual Prepare mutex here.
      // Retain this terminal transaction until settle observes task completion
      // and the Session's native admission check permits an exact resume.
      this.#activityLease = undefined;
      this.#released = true;
      this.#cancelled = true;
      this.#mutationSettled = true;
      this.#failed = false;
    } catch (error) {
      this.#failed = true;
      throw error;
    } finally {
      this.#changed();
    }
  }
  settle(task: Promise<unknown>, rebind: () => Promise<void>) {
    this.#settling ??= this.#finish(task, rebind).finally(() => {
      this.#settling = undefined;
      this.#changed();
    });
    this.#changed();
    return this.#settling;
  }
  async #finish(task: Promise<unknown>, rebind: () => Promise<void>) {
    await task.catch(() => undefined);
    if (!this.#record && !this.#failed) return;
    try {
      if (
        !this.#record ||
        !this.#owned ||
        !this.#released ||
        (!this.#drained && !this.#cancelled)
      )
        denied();
      if (!this.#mutationSettled) {
        if (this.#record.phase === "drained")
          await this.#idle(AbortSignal.timeout(30_000));
        await this.#end();
        // The actual end ACK precedes WAL deletion. The same control Session
        // remains live; unknown drain/end/helper cleanup keeps this record/fence.
        await this.options.host.native.vaultDelete(
          "account",
          PREPARE_MAINTENANCE_KEY,
        );
        this.#activity.finishCommitted();
        this.#activityLease = undefined;
        this.#mutationSettled = true;
      } else if (!sameConsumerProcess(await this.#gui(), this.#record.owner))
        denied();
      if (!this.#resumed) {
        const record = this.#record;
        if (record.authority) {
          const client = await this.#session(AbortSignal.timeout(30_000));
          const snapshot = await StoreSessionClient.prototype.command.call(
            client,
            {
              version: 1,
              request_id: record.resumeRequest,
              action: "maintenance_resume",
              transaction: record.transaction,
              instance_id: record.instance!,
            },
            AbortSignal.timeout(30_000),
          );
          this.#sameSession(client, snapshot);
          if (snapshot.maintenance) denied();
        }
        // Only the actual original Session's reply can acknowledge its resume.
        // A lost reply keeps the same request/instance for explicit recovery.
        this.#resumed = true;
      }
      // Rebinding may fail after the mutation has already settled. Retain its
      // original owner, but never reopen that ended WAL or replay mutation IO.
      this.#rebinding = true;
      this.#changed();
      await rebind();
      this.#clear();
    } catch (error) {
      this.#failed = true;
      throw error;
    } finally {
      this.#rebinding = false;
      this.#changed();
    }
  }
  #clear() {
    this.#record = null;
    this.#owned = false;
    this.#failed = false;
    this.#released = false;
    this.#drained = false;
    this.#mutationSettled = false;
    this.#cancelled = false;
    this.#resumed = false;
    this.#intakeCommitAttempted = false;
    this.#reclaimControl = false;
    this.#activityLease = undefined;
  }
}
