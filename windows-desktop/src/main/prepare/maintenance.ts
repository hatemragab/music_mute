import { randomUUID } from "node:crypto";
import {
  sameConsumerProcess,
  processIdentityFromWire,
  processIdentityToWire,
  type ConsumerProcessIdentity,
  type WindowsConsumerNative,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import type { HostContext } from "../host-context.js";
import type {
  PrepareLease,
  PrepareMutationAdmission,
  PrepareTarget,
} from "./controller.js";
import type { SessionClient } from "../session/control.js";
import { createSessionMaintenancePort } from "../session/maintenance.js";
import { VaultSessionStateStore } from "../session/state-store.js";
import type { SessionSnapshot } from "../../shared/session-contracts.js";
import {
  DesktopMaintenanceGate,
  type MaintenanceIntakeReservation,
} from "../maintenance-gate.js";
import { createDesktopFleetRecoveryActivity } from "../fleet/desktop-maintenance.js";

export const PREPARE_MAINTENANCE_KEY = "prepare_maintenance";
interface Record {
  version: 1;
  sid: string;
  transaction: string;
  target: string;
  owner: ConsumerProcessIdentity;
  authority: ConsumerProcessIdentity | null;
  phase: "reserving" | "draining" | "retiring" | "retired";
}
export interface PrepareMaintenanceConnection {
  client: Pick<SessionClient, "command" | "waitState" | "currentAuthority">;
  close(): Promise<void>;
}
export interface PrepareMaintenanceOptions {
  host: HostContext;
  native: Pick<
    WindowsConsumerNative,
    "inspectSingletonOwner" | "waitProcessExit" | "processIdentity"
  >;
  gate: DesktopMaintenanceGate;
  /** This callback must passively attach, with launchIfAbsent:false. */
  attachExisting(): Promise<PrepareMaintenanceConnection>;
  retireHandles(reservation: MaintenanceIntakeReservation): Promise<void>;
  changed?(): void;
}
function parse(value: unknown, sid: string): Record {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
  const row = value as Record;
  if (
    Object.keys(row).sort().join() !==
      "authority,owner,phase,sid,target,transaction,version" ||
    row.version !== 1 ||
    row.sid !== sid ||
    typeof row.target !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.target) ||
    typeof row.transaction !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      row.transaction,
    ) ||
    !["reserving", "draining", "retiring", "retired"].includes(row.phase)
  )
    throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
  row.owner = processIdentityFromWire(processIdentityToWire(row.owner));
  if (row.authority !== null)
    row.authority = processIdentityFromWire(
      processIdentityToWire(row.authority),
    );
  if (row.owner.sid !== sid || (row.authority && row.authority.sid !== sid))
    throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
  return structuredClone(row);
}
/** Mutation-only Prepare fence. Uses the existing real intake/Session retirement
 * policy; cached-ready checks never invoke it. All native observations are ports. */
export class PrepareMaintenance implements PrepareMutationAdmission {
  private record: Record | null = null;
  private connection: PrepareMaintenanceConnection | undefined;
  private sessionLease:
    | Awaited<
        ReturnType<ReturnType<typeof createSessionMaintenancePort>["acquire"]>
      >
    | undefined;
  private activityLease:
    | Awaited<
        ReturnType<
          ReturnType<
            typeof createDesktopFleetRecoveryActivity
          >["consumerActivity"]["acquire"]
        >
      >
    | undefined;
  private readonly activity;
  private restored = false;
  private entering: Promise<PrepareLease> | undefined;
  private settling: Promise<void> | undefined;
  private failed = false;
  private released = false;
  private rebinding = false;
  private ownsRecord = false;
  private commitAttempted = false;
  private retiredProof = false;
  private precommitEnded = false;
  private readonly state;
  constructor(private readonly options: PrepareMaintenanceOptions) {
    this.state = new VaultSessionStateStore(options.host.native);
    this.activity = createDesktopFleetRecoveryActivity(
      options.gate,
      async (reservation) => {
        if (!this.record)
          throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
        if (!(await this.retired())) {
          if (!this.sessionLease)
            throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
          await this.sessionLease.commit();
        }
        if (!(await this.retired()))
          throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
        await options.retireHandles(reservation);
        this.record.phase = "retired";
        await this.persist();
        this.retiredProof = true;
      },
    );
  }
  private changed(): void {
    try {
      this.options.changed?.();
    } catch {}
  }
  admitting(): boolean {
    return !!this.entering;
  }
  ownsReservation(): boolean {
    return this.activity.ownsReservation();
  }
  busy(): boolean {
    return (
      this.failed || this.record !== null || !!this.entering || !!this.settling
    );
  }
  recoveryPending(): boolean {
    return this.failed;
  }
  cleanupPending(): boolean {
    return this.failed && this.ownsRecord && this.record !== null;
  }
  authorizesRebind(): boolean {
    return this.rebinding && this.released && this.retiredProof;
  }
  snapshot() {
    return {
      busy: this.busy(),
      recoveryPending: this.failed,
      admitting: this.admitting(),
      retired: this.retiredProof,
      controllerReleased: this.released,
      rebinding: this.rebinding,
    };
  }
  /** Trusted Operations callback only. Never a renderer-selected assertion. */
  async assertMutation(target: PrepareTarget): Promise<void> {
    const record = this.record;
    if (
      !record ||
      !this.ownsRecord ||
      this.failed ||
      this.released ||
      this.rebinding ||
      !this.retiredProof ||
      record.phase !== "retired" ||
      record.target !== target.identity ||
      record.sid !== target.sid ||
      !this.activityLease ||
      !this.activity.ownsReservation()
    )
      throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
    const actual = await this.options.native.processIdentity(process.pid);
    await this.activityLease.assertIdle(AbortSignal.timeout(30000));
    if (
      !actual ||
      !sameConsumerProcess(actual, record.owner) ||
      !(await this.retired()) ||
      this.record !== record ||
      this.released ||
      !this.activity.ownsReservation()
    )
      throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
  }
  async restore(): Promise<void> {
    if (this.restored) return;
    const bytes = await this.options.host.native.vaultRead(
      "account",
      PREPARE_MAINTENANCE_KEY,
    );
    try {
      if (bytes) {
        if (bytes.length > 4096)
          throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
        this.record = parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
          this.options.host.identity.sid,
        );
        this.failed = true;
      }
      this.restored = true;
    } catch (error) {
      this.failed = true;
      throw error;
    } finally {
      bytes?.fill(0);
      this.changed();
    }
  }
  private async persist(): Promise<void> {
    if (!this.record) throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
    parse(this.record, this.options.host.identity.sid);
    await this.options.host.native.vaultWrite(
      "account",
      PREPARE_MAINTENANCE_KEY,
      Buffer.from(JSON.stringify(this.record)),
    );
  }
  private async retired(): Promise<boolean> {
    const record = this.record;
    if (!record) return false;
    const state = await this.state.read();
    if (record.authority)
      return (
        !!state &&
        state.sid === record.sid &&
        !state.owner &&
        !state.maintenance &&
        (await this.options.native.waitProcessExit(record.authority, 30000))
      );
    return (
      (await this.options.native.inspectSingletonOwner("session")).state ===
        "absent" &&
      (!state || (!state.owner && !state.maintenance))
    );
  }
  beforeMutation(
    target: PrepareTarget,
    signal: AbortSignal,
  ): Promise<PrepareLease> {
    this.entering ??= this.enter(target, signal).finally(() => {
      this.entering = undefined;
      this.changed();
    });
    this.changed();
    return this.entering;
  }
  async recoverBeforeReady(
    target: PrepareTarget,
    signal: AbortSignal,
  ): Promise<PrepareLease | null> {
    await this.restore();
    return this.record ? this.beforeMutation(target, signal) : null;
  }
  private async enter(
    target: PrepareTarget,
    signal: AbortSignal,
  ): Promise<PrepareLease> {
    await this.claim(target, signal);
    if (this.precommitEnded)
      throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
    this.released = false;
    try {
      await this.persist();
      this.activityLease ??= await this.activity.consumerActivity.acquire(
        this.record!.transaction,
        signal,
      );
      const record = this.record!;
      if (record.phase !== "retired") {
        const current =
          await this.options.native.inspectSingletonOwner("session");
        if (current.state === "active") {
          if (
            !current.sameSession ||
            (record.authority &&
              !sameConsumerProcess(current.owner, record.authority))
          )
            throw new Error("PREPARE_MAINTENANCE_BUSY");
          record.authority = current.owner;
          this.connection ??= await this.options.attachExisting();
          record.phase = "draining";
          await this.persist();
          let snapshot: SessionSnapshot = await this.connection.client.command(
            {
              version: 1,
              request_id: randomUUID(),
              action: "maintenance_begin",
              transaction: record.transaction,
            },
            signal,
          );
          const expected = this.connection.client.currentAuthority();
          if (!expected || !sameConsumerProcess(expected, current.owner))
            throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
          while (
            snapshot.maintenance?.transaction === record.transaction &&
            snapshot.maintenance.phase === "draining"
          ) {
            const next = await this.connection.client.waitState(
              snapshot.revision,
              snapshot.instance_id,
              signal,
            );
            signal.throwIfAborted();
            if (
              next.instance_id !== snapshot.instance_id ||
              next.revision < snapshot.revision
            )
              throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
            snapshot = next;
          }
          if (
            snapshot.maintenance?.transaction !== record.transaction ||
            snapshot.maintenance.phase !== "idle"
          )
            throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
          this.sessionLease = await createSessionMaintenancePort(
            this.connection.client,
          ).acquire(record.transaction, signal);
        } else if (record.authority && !(await this.retired())) {
          throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
        }
        signal.throwIfAborted();
        record.phase = "retiring";
        await this.persist();
      }
      signal.throwIfAborted();
      this.commitAttempted = true;
      await this.activity.commit();
      this.failed = false;
      this.changed();
      return {
        release: async () => {
          await this.activityLease!.release();
          this.released = true;
          this.changed();
        },
      };
    } catch (error) {
      this.failed = true;
      this.changed();
      throw error;
    }
  }
  private async claim(
    target: PrepareTarget,
    signal: AbortSignal,
  ): Promise<void> {
    await this.restore();
    signal.throwIfAborted();
    if (this.rebinding || (this.failed && !this.record))
      throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
    const owner = await this.options.native.processIdentity(process.pid);
    if (
      !owner ||
      owner.pid !== process.pid ||
      owner.sid !== target.sid ||
      target.sid !== this.options.host.identity.sid ||
      owner.sessionId !== this.options.host.identity.sessionId ||
      !/^[a-f0-9]{64}$/u.test(target.identity)
    )
      throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
    if (this.record && !this.ownsRecord) {
      const previous = await this.options.native.processIdentity(
        this.record.owner.pid,
      );
      if (previous && sameConsumerProcess(previous, this.record.owner))
        throw new Error("PREPARE_MAINTENANCE_BUSY");
      this.record.owner = owner;
      this.ownsRecord = true;
      this.commitAttempted = ["retiring", "retired"].includes(
        this.record.phase,
      );
    }
    if (!this.record) {
      this.record = {
        version: 1,
        sid: target.sid,
        transaction: randomUUID(),
        target: target.identity,
        owner,
        authority: null,
        phase: "reserving",
      };
      this.ownsRecord = true;
    }
    if (this.record.target !== target.identity)
      throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
  }
  /** Called by Controller Cancel only while it holds a genuine Prepare lease. */
  async cancelRecovery(
    target: PrepareTarget,
    signal: AbortSignal,
  ): Promise<PrepareLease | null> {
    await this.restore();
    if (!this.record) {
      if (this.failed && !(this.released && this.retiredProof))
        throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
      return null;
    }
    await this.claim(target, signal);
    if (
      this.commitAttempted ||
      ["retiring", "retired"].includes(this.record.phase)
    )
      return this.beforeMutation(target, signal);
    await this.cancelCleanup();
    return null;
  }
  /** Retry the exact durable transaction; the Controller still owns Prepare. */
  async recoverMutation(): Promise<void> {
    if (
      !this.record ||
      !this.ownsRecord ||
      this.released ||
      this.record.phase !== "retired"
    )
      throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
    // The existing retained Controller lease will release this same admission
    // after operations cleanup. Releasing it here would deny that cleanup.
    await this.beforeMutation(
      { sid: this.record.sid, identity: this.record.target },
      AbortSignal.timeout(30_000),
    );
  }
  async recoverCleanup(): Promise<void> {
    if (!this.record || !this.ownsRecord) return;
    if (this.precommitEnded) return this.cancelCleanup();
    const lease = await this.beforeMutation(
      { sid: this.record.sid, identity: this.record.target },
      AbortSignal.timeout(30_000),
    );
    await lease.release();
  }
  /** Abort only an uncommitted drain, after an acknowledged maintenance_end.
   * Retirement ACK uncertainty must recover the original transaction instead. */
  async cancelCleanup(): Promise<void> {
    if (!this.record || !this.ownsRecord) return;
    if (
      this.commitAttempted ||
      ["retiring", "retired"].includes(this.record.phase)
    ) {
      await this.recoverCleanup();
      return;
    }
    try {
      if (!this.precommitEnded && this.record.authority) {
        this.connection ??= await this.options.attachExisting();
        const authority = this.connection.client.currentAuthority();
        if (
          !authority ||
          !sameConsumerProcess(authority, this.record.authority)
        )
          throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
        const snapshot = await this.connection.client.command(
          {
            version: 1,
            request_id: randomUUID(),
            action: "maintenance_end",
            transaction: this.record.transaction,
          },
          AbortSignal.timeout(30_000),
        );
        if (
          snapshot.maintenance ||
          !sameConsumerProcess(
            this.connection.client.currentAuthority() ?? {
              ...authority,
              pid: 0,
            },
            authority,
          )
        )
          throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
      }
      this.precommitEnded = true;
      await this.connection?.close();
      this.connection = undefined;
      await this.activityLease?.release();
      this.activityLease = undefined;
      await this.options.host.native.vaultDelete(
        "account",
        PREPARE_MAINTENANCE_KEY,
      );
      this.clear();
    } catch (error) {
      this.failed = true;
      throw error;
    } finally {
      this.changed();
    }
  }
  private clear(): void {
    this.record = null;
    this.ownsRecord = false;
    this.failed = false;
    this.released = false;
    this.retiredProof = false;
    this.commitAttempted = false;
    this.precommitEnded = false;
    this.activityLease = undefined;
    this.sessionLease = undefined;
  }
  /** Root's callback may rebind only current fully verified Ready, under its one
   * explicit internal-rebind exemption. Outsider intake remains fenced. */
  settle(task: Promise<unknown>, rebind: () => Promise<void>): Promise<void> {
    this.settling ??= this.finish(task, rebind).finally(() => {
      this.settling = undefined;
      this.changed();
    });
    this.changed();
    return this.settling;
  }
  private async finish(
    task: Promise<unknown>,
    rebind: () => Promise<void>,
  ): Promise<void> {
    await task.catch(() => undefined);
    if (!this.record && !this.failed) return;
    try {
      if (
        !this.released ||
        (this.record &&
          (this.record.phase !== "retired" || !(await this.retired())))
      )
        throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
      if (this.record) {
        this.retiredProof = true;
        await this.connection?.close();
        this.connection = undefined;
        this.activity.finishCommitted();
        this.activityLease = undefined;
        await this.options.host.native.vaultDelete(
          "account",
          PREPARE_MAINTENANCE_KEY,
        );
        this.record = null;
        this.ownsRecord = false;
        this.activityLease = undefined;
        this.sessionLease = undefined;
      }
      if (!this.retiredProof)
        throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
      this.rebinding = true;
      this.changed();
      await rebind();
      this.clear();
    } catch (error) {
      this.failed = true;
      throw error;
    } finally {
      this.rebinding = false;
      this.changed();
    }
  }
}
