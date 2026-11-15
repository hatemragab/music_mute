import { randomUUID } from "node:crypto";
import {
  sameConsumerProcess,
  type ConsumerMutexLease,
  type ConsumerProcessIdentity,
  type WindowsConsumerNative,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import type { HostContext } from "../host-context.js";
import { QualificationCleanupUnconfirmed } from "../prepare/qualification-runner.js";
import type { WindowsPreparationOperations } from "../prepare/operations.js";
import type { ConsumerUpdateActivityPort } from "../update/factory.js";
import { createSessionMaintenancePort } from "../session/maintenance.js";
import type { SessionClient } from "../session/control.js";
import { VaultSessionStateStore } from "../session/state-store.js";
import { VaultFleetStore, fleetRecordAuthority } from "./store.js";
import {
  readOperationalFleetIdentity,
  fleetGpuReadyAligned,
} from "./active-runtime.js";
import { refreshApprovedFleetRuntime } from "./update-preparation.js";

const KEY = "requalification",
  HASH = /^[a-f0-9]{64}$/u,
  UUID =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
interface Journal {
  version: 1;
  sid: string;
  transaction: string;
  authority: string;
  runtimeIdentity: string;
  bootIdentity: string;
  phase: "fencing" | "fencing-uncertain" | "qualified" | "retiring" | "retired";
  owner: ConsumerProcessIdentity;
  session: ConsumerProcessIdentity | null;
}
interface RecoverySessionLease {
  authority: ConsumerProcessIdentity | null;
  commit(): Promise<void>;
  release(): Promise<void>;
}
export interface FleetRecoveryMaintenancePort {
  acquire(
    transaction: string,
    signal: AbortSignal,
  ): Promise<RecoverySessionLease>;
  cancel(transaction: string, signal: AbortSignal): Promise<void>;
  /** Requires durable supervisor retirement AND exact old Node birth exit. */
  retired(authority: ConsumerProcessIdentity | null): Promise<boolean>;
}
/** Reuse the existing supervisor's actual role-tree idle fence, without resetting saved intent. */
export function createFleetRecoveryMaintenancePort(
  host: HostContext,
  native: Pick<
    WindowsConsumerNative,
    "processIdentity" | "waitProcessExit" | "acquireMutex" | "releaseMutex"
  >,
  client: Pick<SessionClient, "command" | "currentAuthority">,
): FleetRecoveryMaintenancePort {
  const existing = createSessionMaintenancePort(client),
    stateStore = new VaultSessionStateStore(host.native);
  const retired = async (authority: ConsumerProcessIdentity | null) => {
    const state = await stateStore.read();
    return (
      !!state &&
      state.sid === host.identity.sid &&
      !state.owner &&
      !state.maintenance &&
      (!authority || (await native.waitProcessExit(authority)))
    );
  };
  return {
    retired,
    cancel: existing.cancel,
    acquire: async (transaction, signal) => {
      signal.throwIfAborted();
      try {
        const lease = await existing.acquire(transaction, signal),
          authority = client.currentAuthority() ?? null;
        if (!authority)
          throw new Error("FLEET_REQUALIFICATION_RECOVERY_REQUIRED");
        return {
          authority,
          release: lease.release,
          commit: async () => {
            if (!(await retired(authority))) await lease.commit();
            if (!(await retired(authority)))
              throw new Error("FLEET_REQUALIFICATION_RECOVERY_REQUIRED");
          },
        };
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "SESSION_UNAVAILABLE"
        )
          throw error;
        const singleton = await native.acquireMutex("session");
        if (
          !singleton ||
          !sameConsumerProcess(singleton.identity, host.identity)
        ) {
          if (singleton) await native.releaseMutex(singleton);
          throw new Error("FLEET_REQUALIFICATION_BUSY");
        }
        try {
          const state = await stateStore.read();
          if (
            !state ||
            state.sid !== host.identity.sid ||
            (state.owner &&
              (!state.maintenance?.idle ||
                state.maintenance.transaction !== transaction)) ||
            (!state.owner &&
              state.maintenance &&
              (!state.maintenance.idle ||
                state.maintenance.transaction !== transaction))
          )
            throw new Error("FLEET_REQUALIFICATION_RECOVERY_REQUIRED");
          const authority = state.owner?.identity ?? null;
          // maintenance.idle is written only after both exact role Job trees stopped.
          if (authority && !(await native.waitProcessExit(authority)))
            throw new Error("FLEET_REQUALIFICATION_BUSY");
          let released = false;
          const finish = async () => {
            if (released) return;
            await stateStore.write({
              ...state,
              owner: null,
              maintenance: null,
              revision: state.revision + 1,
            });
            await native.releaseMutex(singleton);
            released = true;
          };
          return { authority, commit: finish, release: finish };
        } catch (failure) {
          await native.releaseMutex(singleton);
          throw failure;
        }
      }
    },
  };
}
export interface FleetRecoveryOptions {
  host: HostContext;
  operations: Pick<
    WindowsPreparationOperations,
    "snapshotReady" | "requalifyInstalled"
  >;
  consumerActivity: ConsumerUpdateActivityPort;
  maintenance: FleetRecoveryMaintenancePort;
  /** Called after Prepare is released. Schedule rebind after run() settles, using existing saved intent. */
  onSessionRetired(): Promise<void>;
  /** Test adapters only; production uses verified retained fixture and the owned GPU runner. */
  qualification?: Pick<
    Parameters<typeof refreshApprovedFleetRuntime>[0],
    "qualify" | "readFixture" | "readOriginalQualification"
  >;
}
type ActivityLease = Awaited<ReturnType<ConsumerUpdateActivityPort["acquire"]>>;
interface Held {
  journal: Journal;
  activity: ActivityLease;
  session: RecoverySessionLease | null;
  prepare: ConsumerMutexLease | null;
  journalCleared: boolean;
}
function identity(
  value: unknown,
  sid: string,
): value is ConsumerProcessIdentity {
  const v = value as ConsumerProcessIdentity;
  return (
    !!v &&
    Object.keys(v).sort().join() === "creationTime,pid,sessionId,sid" &&
    v.sid === sid &&
    Number.isSafeInteger(v.pid) &&
    v.pid > 0 &&
    Number.isSafeInteger(v.sessionId) &&
    v.sessionId > 0 &&
    typeof v.creationTime === "string" &&
    /^\d{1,30}$/u.test(v.creationTime)
  );
}
async function readRecoveryJournal(
  host: Pick<HostContext, "native" | "identity">,
): Promise<Journal | null> {
  const bytes = await host.native.vaultRead("fleet", KEY);
  if (!bytes) return null;
  try {
    const v = parseStrictJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      4096,
    ) as Journal;
    if (
      !v ||
      Object.keys(v).sort().join() !==
        "authority,bootIdentity,owner,phase,runtimeIdentity,session,sid,transaction,version" ||
      v.version !== 1 ||
      v.sid !== host.identity.sid ||
      typeof v.transaction !== "string" ||
      !UUID.test(v.transaction) ||
      [v.authority, v.runtimeIdentity, v.bootIdentity].some(
        (s) => typeof s !== "string" || !HASH.test(s),
      ) ||
      ![
        "fencing",
        "fencing-uncertain",
        "qualified",
        "retiring",
        "retired",
      ].includes(v.phase) ||
      !identity(v.owner, v.sid) ||
      (v.session !== null && !identity(v.session, v.sid))
    )
      throw new Error();
    return v;
  } catch {
    throw new Error("FLEET_REQUALIFICATION_STATE_INVALID");
  } finally {
    bytes.fill(0);
  }
}
/** Read-only startup fence; malformed/unreadable protected state never becomes absence. */
export async function inspectWindowsFleetRecovery(
  host: Pick<HostContext, "native" | "identity">,
): Promise<{ recoveryRequired: boolean; invalidState: boolean }> {
  try {
    return {
      recoveryRequired: (await readRecoveryJournal(host)) !== null,
      invalidState: false,
    };
  } catch {
    return { recoveryRequired: true, invalidState: true };
  }
}
/** Explicit approved-fixture recovery; no account/enrollment calls or second saved-intent authority. */
export class WindowsFleetRecovery {
  private pending: Promise<"none" | "current" | "requalified"> | undefined;
  private retained: Held | undefined;
  private reserved: string | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly abort = new AbortController();
  private closed = false;
  constructor(private readonly options: FleetRecoveryOptions) {}
  activity() {
    return {
      busy: !!this.pending || !!this.retained || !!this.reserved,
      idle: !this.pending && !this.retained && !this.reserved,
    };
  }
  subscribeActivity(listener: () => void) {
    this.listeners.add(listener);
    listener();
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed() {
    for (const listener of this.listeners)
      try {
        listener();
      } catch {}
  }
  private journal(): Promise<Journal | null> {
    return readRecoveryJournal(this.options.host);
  }
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    const { host } = this.options,
      lease = await host.native.acquireMutex("cache");
    if (
      !lease ||
      lease.scope !== "cache" ||
      !sameConsumerProcess(lease.identity, host.identity)
    ) {
      if (lease) await host.native.releaseMutex(lease);
      throw new Error("FLEET_REQUALIFICATION_BUSY");
    }
    try {
      return await work();
    } finally {
      await host.native.releaseMutex(lease);
    }
  }
  private async save(
    value: Journal | null,
    expected: string | null,
    claim = false,
  ) {
    await this.locked(async () => {
      const current = await this.journal();
      if (
        (current?.transaction ?? null) !== expected &&
        !(
          value === null &&
          current === null &&
          this.retained?.journal.phase === "retired"
        )
      )
        throw new Error("FLEET_REQUALIFICATION_STATE_INVALID");
      if (value) {
        if (current && !sameConsumerProcess(current.owner, value.owner)) {
          if (!claim) throw new Error("FLEET_REQUALIFICATION_STATE_INVALID");
          const alive = await this.options.host.processIdentity(
            current.owner.pid,
          );
          if (alive && sameConsumerProcess(alive, current.owner))
            throw new Error("FLEET_REQUALIFICATION_BUSY");
        }
        const record = await new VaultFleetStore(
          this.options.host.native,
          value.sid,
        ).read();
        if (
          !record ||
          record.phase !== "complete" ||
          fleetRecordAuthority(record) !== value.authority
        )
          throw new Error("FLEET_REQUALIFICATION_STATE_INVALID");
        await this.options.host.native.vaultWrite(
          "fleet",
          KEY,
          Buffer.from(JSON.stringify(value)),
        );
      } else await this.options.host.native.vaultDelete("fleet", KEY);
    });
  }
  run(signal: AbortSignal): Promise<"none" | "current" | "requalified"> {
    if (this.closed)
      return Promise.reject(new Error("FLEET_REQUALIFICATION_CLOSED"));
    if (this.pending)
      return Promise.reject(new Error("FLEET_REQUALIFICATION_BUSY"));
    const task = this.perform(AbortSignal.any([signal, this.abort.signal]));
    this.pending = task;
    this.changed();
    void task.then(
      () => {
        this.pending = undefined;
        this.changed();
      },
      () => {
        this.pending = undefined;
        this.changed();
      },
    );
    return task;
  }
  private async perform(
    signal: AbortSignal,
  ): Promise<"none" | "current" | "requalified"> {
    const { host, operations, maintenance } = this.options;
    signal.throwIfAborted();
    const store = new VaultFleetStore(host.native, host.identity.sid),
      enrollment = await store.read(),
      previous = this.retained?.journal ?? (await this.journal());
    if (!previous && enrollment?.phase !== "complete") return "none";
    if (
      !enrollment ||
      enrollment.phase !== "complete" ||
      (previous && previous.authority !== fleetRecordAuthority(enrollment))
    )
      throw new Error("FLEET_REQUALIFICATION_STATE_INVALID");
    const ready = await operations.snapshotReady(signal),
      expected = {
        release: ready.release,
        manifestDigest: ready.manifestSha256,
        archiveDigest: ready.archiveSha256,
        modelDigest: ready.modelSha256,
      };
    if (!previous)
      try {
        const active = await readOperationalFleetIdentity(
          host.native,
          enrollment,
          expected,
        );
        if (fleetGpuReadyAligned(ready, active)) return "current";
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "FLEET_PREPARE_REQUIRED"
        )
          throw error;
      }
    const owner = await host.processIdentity(process.pid);
    if (
      !identity(owner, host.identity.sid) ||
      owner.pid !== process.pid ||
      owner.sessionId !== host.identity.sessionId
    )
      throw new Error("FLEET_REQUALIFICATION_STATE_INVALID");
    if (previous && !this.retained && this.reserved !== previous.transaction) {
      const alive = await host.processIdentity(previous.owner.pid);
      if (alive && sameConsumerProcess(alive, previous.owner))
        throw new Error("FLEET_REQUALIFICATION_BUSY");
    }
    const journal: Journal = previous ?? {
      version: 1,
      sid: host.identity.sid,
      transaction: randomUUID(),
      authority: fleetRecordAuthority(enrollment),
      runtimeIdentity: ready.release,
      bootIdentity: ready.bootIdentity,
      phase: "fencing",
      owner,
      session: null,
    };
    let held = this.retained;
    if (!held) {
      await this.save(
        { ...journal, owner },
        previous?.transaction ?? null,
        true,
      );
      journal.owner = owner;
      this.reserved = journal.transaction;
      const activity = await this.options.consumerActivity.acquire(
        journal.transaction,
        signal,
      );
      held = {
        journal,
        activity,
        session: null,
        prepare: null,
        journalCleared: false,
      };
      this.retained = held;
      this.changed();
    }
    try {
      if (held.journalCleared) {
        await held.activity.release();
        this.retained = undefined;
        this.reserved = undefined;
        return "requalified";
      }
      await held.activity.assertIdle(signal);
      if (
        journal.phase === "retired" &&
        !(await maintenance.retired(journal.session))
      )
        throw new Error("FLEET_REQUALIFICATION_RECOVERY_REQUIRED");
      if (
        journal.phase === "retired" ||
        (journal.phase === "retiring" &&
          (await maintenance.retired(journal.session)))
      ) {
        journal.phase = "retired";
        await this.save(journal, journal.transaction);
      } else {
        if (!held.session)
          held.session = await maintenance.acquire(journal.transaction, signal);
        journal.session = held.session.authority;
        await this.save(journal, journal.transaction);
      }
      const stale =
        journal.runtimeIdentity !== ready.release ||
        journal.bootIdentity !== ready.bootIdentity;
      if (!held.prepare) {
        const lease = await host.native.acquireMutex("prepare");
        if (
          !lease ||
          lease.scope !== "prepare" ||
          !sameConsumerProcess(lease.identity, host.identity)
        ) {
          if (lease) await host.native.releaseMutex(lease);
          throw new Error("FLEET_REQUALIFICATION_BUSY");
        }
        held.prepare = lease;
      }
      if (
        stale ||
        journal.phase === "fencing" ||
        journal.phase === "fencing-uncertain"
      ) {
        const alreadyRetired = journal.phase === "retired";
        if (!alreadyRetired) {
          journal.runtimeIdentity = ready.release;
          journal.bootIdentity = ready.bootIdentity;
          if (journal.phase !== "fencing-uncertain") journal.phase = "fencing";
          await this.save(journal, journal.transaction);
        }
        await refreshApprovedFleetRuntime(
          {
            host,
            operations,
            prepareLease: held.prepare,
            transaction: journal.transaction,
            runtimeIdentity: ready.release,
            ...this.options.qualification,
          },
          signal,
        );
        journal.runtimeIdentity = ready.release;
        journal.bootIdentity = ready.bootIdentity;
        if (!alreadyRetired) journal.phase = "qualified";
        await this.save(journal, journal.transaction);
      }
      await readOperationalFleetIdentity(host.native, enrollment, expected);
      await held.activity.assertIdle(signal);
      if (journal.phase !== "retired") {
        journal.phase = "retiring";
        await this.save(journal, journal.transaction);
        await held.session!.commit();
        journal.phase = "retired";
        await this.save(journal, journal.transaction);
      }
      await host.native.releaseMutex(held.prepare);
      held.prepare = null;
      await this.options.onSessionRetired();
      await this.save(null, journal.transaction);
      held.journalCleared = true;
      await held.activity.release();
      this.retained = undefined;
      this.reserved = undefined;
      return "requalified";
    } catch (error) {
      if (error instanceof QualificationCleanupUnconfirmed) {
        journal.phase = "fencing-uncertain";
        await this.save(journal, journal.transaction).catch(() => {});
        throw new Error("FLEET_REQUALIFICATION_RECOVERY_REQUIRED", {
          cause: error,
        });
      }
      if (journal.phase === "fencing-uncertain")
        throw new Error("FLEET_REQUALIFICATION_RECOVERY_REQUIRED", {
          cause: error,
        });
      if (journal.phase === "fencing") {
        try {
          if (held.prepare) {
            await host.native.releaseMutex(held.prepare);
            held.prepare = null;
          }
          if (held.session) await held.session.release();
          else
            await maintenance.cancel(
              journal.transaction,
              AbortSignal.timeout(10000),
            );
          await this.save(null, journal.transaction);
          await held.activity.release();
          this.retained = undefined;
          this.reserved = undefined;
        } catch {
          throw new Error("FLEET_REQUALIFICATION_RECOVERY_REQUIRED");
        }
      }
      throw error;
    }
  }
  async close() {
    this.closed = true;
    this.abort.abort();
    await this.pending?.catch(() => {});
    if (this.retained || this.reserved)
      throw new Error("FLEET_REQUALIFICATION_RECOVERY_REQUIRED");
    this.listeners.clear();
  }
}
export function createWindowsFleetRecovery(options: FleetRecoveryOptions) {
  return new WindowsFleetRecovery(options);
}
