import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import {
  processIdentityFromWire,
  processIdentityToWire,
  sameConsumerProcess,
  type ConsumerProcessIdentity,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import type { HostContext } from "../host-context.js";
import { StoreNativeAuthority } from "../browser/store-native.js";
import { StorePreparationOperations } from "../prepare/store-operations.js";
import { StorePrepareMaintenance } from "../prepare/store-maintenance.js";
import type { PrepareLease } from "../prepare/controller.js";
import {
  VaultFleetStore,
  fleetRecordAuthority,
  parseFleetRecord,
  type FleetEnrollmentRecord,
} from "./store.js";
import { readStoreFleetRuntimeIdentityForGui } from "./store-active-runtime.js";
import {
  refreshApprovedStoreFleetRuntime,
  repairApprovedLegacyStoreFleetRuntime,
} from "./store-update-preparation.js";

const TOKEN = Symbol("store-fleet-recovery");
const KEY = "requalification";
const HASH = /^[a-f0-9]{64}$/u;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
interface Journal {
  version: 2;
  distribution: "microsoft-store";
  sid: string;
  transaction: string;
  authority: string;
  target: string;
  owner: ConsumerProcessIdentity;
  phase: "fencing" | "qualified" | "settling";
}
interface Options {
  maintenance: StorePrepareMaintenance;
  /** Rebind the GUI after the original live Session ends/resumes maintenance. */
  rebind(): Promise<void>;
}
interface Owner {
  enrollment: FleetEnrollmentRecord;
  journal: Journal;
  setup: PrepareLease | null;
  mutation: PrepareLease | null;
  journalAttempted: boolean;
  maintenanceStarted: boolean;
  task: Promise<"requalified">;
  settling?: Promise<void> | undefined;
  originalSettlement?: Promise<void>;
}
function denied(): never {
  throw new Error("FLEET_REQUALIFICATION_RECOVERY_REQUIRED");
}
function decode(bytes: Uint8Array, sid: string): Journal {
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) denied();
  const value = parseStrictJson(text, 4096, 256) as Journal;
  if (
    !value ||
    Object.keys(value).sort().join() !==
      "authority,distribution,owner,phase,sid,target,transaction,version" ||
    value.version !== 2 ||
    value.distribution !== "microsoft-store" ||
    value.sid !== sid ||
    typeof value.transaction !== "string" ||
    !UUID.test(value.transaction) ||
    typeof value.authority !== "string" ||
    !HASH.test(value.authority) ||
    typeof value.target !== "string" ||
    !HASH.test(value.target) ||
    !["fencing", "qualified", "settling"].includes(value.phase)
  )
    denied();
  value.owner = processIdentityFromWire(processIdentityToWire(value.owner));
  if (value.owner.sid !== sid) denied();
  return value;
}
async function readJournal(host: Pick<HostContext, "native" | "identity">) {
  const bytes = await host.native.vaultRead("fleet", KEY);
  if (!bytes) return null;
  try {
    return decode(bytes, host.identity.sid);
  } finally {
    bytes.fill(0);
  }
}
/** Read-only startup fence; a legacy, malformed or unreadable journal is never
 * absence and is never promoted to a genuine Store cleanup acknowledgement. */
export async function inspectStoreFleetRecovery(
  host: Pick<HostContext, "native" | "identity">,
) {
  try {
    return {
      recoveryRequired: (await readJournal(host)) !== null,
      invalidState: false,
    };
  } catch {
    return { recoveryRequired: true, invalidState: true };
  }
}

/** Approved-fixture recovery borrows the genuine Store code/Prepare owner and
 * the existing live-Session maintenance fence. It cannot retire the Session,
 * replace enrollment, run a legacy archive, or mint authority from its WAL. */
export class StoreFleetRecovery {
  #host: HostContext;
  #operations: StorePreparationOperations;
  #options: Options;
  #owner: Owner | undefined;
  #pending: Promise<"none" | "current" | "requalified"> | undefined;
  #closed = false;
  #rebinding = false;
  #abort = new AbortController();
  #listeners = new Set<() => void>();
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
    options: Options,
  ) {
    if (
      arguments.length !== 3 ||
      !options ||
      Object.getPrototypeOf(options) !== Object.prototype ||
      Reflect.ownKeys(options).sort().join() !== "maintenance,rebind" ||
      Object.values(Object.getOwnPropertyDescriptors(options)).some(
        (descriptor) => !descriptor.enumerable || !("value" in descriptor),
      ) ||
      typeof options.rebind !== "function"
    )
      denied();
    StorePreparationOperations.prototype.assertHost.call(operations, host);
    StorePrepareMaintenance.prototype.assertHost.call(
      options.maintenance,
      host,
    );
    return new StoreFleetRecovery(TOKEN, host, operations, options);
  }
  assertHost(host: HostContext) {
    if (arguments.length !== 1 || host !== this.#host) denied();
    StorePreparationOperations.prototype.assertHost.call(
      this.#operations,
      host,
    );
    StorePrepareMaintenance.prototype.assertHost.call(
      this.#options.maintenance,
      host,
    );
  }
  authorizesRebind() {
    if (arguments.length !== 0) denied();
    this.assertHost(this.#host);
    return !!this.#owner && this.#rebinding;
  }
  ownsReservation() {
    this.assertHost(this.#host);
    return (
      !!this.#owner &&
      StorePrepareMaintenance.prototype.ownsReservation.call(
        this.#options.maintenance,
      )
    );
  }
  activity() {
    return {
      busy: !!this.#pending || !!this.#owner,
      idle: !this.#pending && !this.#owner,
    };
  }
  subscribeActivity(listener: () => void) {
    this.#listeners.add(listener);
    listener();
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #changed() {
    for (const listener of this.#listeners)
      try {
        listener();
      } catch {}
  }
  async #save(value: Journal | null, expected: string | null) {
    this.assertHost(this.#host);
    const lease = await this.#host.native.acquireMutex("cache");
    if (
      !lease ||
      lease.scope !== "cache" ||
      !sameConsumerProcess(lease.identity, this.#host.identity)
    ) {
      if (lease) await this.#host.native.releaseMutex(lease);
      denied();
    }
    try {
      const previous = await readJournal(this.#host);
      if ((previous?.transaction ?? null) !== expected) denied();
      const enrollment = await new VaultFleetStore(
        this.#host.native,
        this.#host.identity.sid,
      ).read();
      if (
        !this.#owner ||
        !enrollment ||
        !isDeepStrictEqual(
          this.#owner.enrollment,
          parseFleetRecord(enrollment, this.#host.identity.sid),
        )
      )
        denied();
      if (previous) {
        if (
          previous.authority !==
          (value?.authority ?? this.#owner?.journal.authority)
        )
          denied();
        if (
          !sameConsumerProcess(
            previous.owner,
            value?.owner ?? this.#owner!.journal.owner,
          )
        ) {
          if (!value) denied();
          const alive = await this.#host.processIdentity(previous.owner.pid);
          if (alive && sameConsumerProcess(alive, previous.owner)) denied();
        }
      }
      if (value)
        await this.#host.native.vaultWrite(
          "fleet",
          KEY,
          Buffer.from(JSON.stringify(value)),
        );
      else await this.#host.native.vaultDelete("fleet", KEY);
    } finally {
      await this.#host.native.releaseMutex(lease);
    }
  }
  run(signal: AbortSignal): Promise<"none" | "current" | "requalified"> {
    if (arguments.length !== 1)
      return Promise.reject(
        new Error("FLEET_REQUALIFICATION_RECOVERY_REQUIRED"),
      );
    return this.#start(signal, false);
  }
  /** Only the explicit existing Repair journey may qualify an old enrollment. */
  repair(
    signal: AbortSignal,
    originalApproval: string,
  ): Promise<"none" | "current" | "requalified"> {
    if (
      arguments.length !== 2 ||
      typeof originalApproval !== "string" ||
      !HASH.test(originalApproval)
    )
      return Promise.reject(
        new Error("FLEET_REQUALIFICATION_RECOVERY_REQUIRED"),
      );
    return this.#start(signal, true, originalApproval);
  }
  #start(
    signal: AbortSignal,
    legacyRepair: boolean,
    originalApproval?: string,
  ): Promise<"none" | "current" | "requalified"> {
    if (this.#closed)
      return Promise.reject(new Error("FLEET_REQUALIFICATION_CLOSED"));
    if (this.#pending)
      return Promise.reject(new Error("FLEET_REQUALIFICATION_BUSY"));
    const task = this.#perform(
      AbortSignal.any([signal, this.#abort.signal]),
      legacyRepair,
      originalApproval,
    );
    this.#pending = task;
    this.#changed();
    void task
      .finally(() => {
        if (this.#pending === task) this.#pending = undefined;
        this.#changed();
      })
      .catch(() => {});
    return task;
  }
  async #perform(
    signal: AbortSignal,
    legacyRepair: boolean,
    originalApproval?: string,
  ): Promise<"none" | "current" | "requalified"> {
    this.assertHost(this.#host);
    signal.throwIfAborted();
    const record = await new VaultFleetStore(
      this.#host.native,
      this.#host.identity.sid,
    ).read();
    if (
      legacyRepair &&
      (!record || fleetRecordAuthority(record) !== originalApproval)
    )
      denied();
    if (this.#owner) {
      const owner = this.#owner;
      if (
        !record ||
        !isDeepStrictEqual(
          owner.enrollment,
          parseFleetRecord(record, this.#host.identity.sid),
        )
      )
        denied();
      await this.#settle(owner);
      return owner.task;
    }
    const previous = await readJournal(this.#host);
    if (!previous && record?.phase !== "complete") return "none";
    if (
      !record ||
      record.phase !== "complete" ||
      (legacyRepair
        ? record.prepared.distribution !== undefined
        : record.prepared.distribution !== "microsoft-store" && !!previous) ||
      (previous && previous.authority !== fleetRecordAuthority(record))
    )
      denied();
    if (!previous && !legacyRepair) {
      try {
        await readStoreFleetRuntimeIdentityForGui(
          this.#host,
          this.#operations,
          record,
          signal,
        );
        return "current";
      } catch (error) {
        if (
          !(error instanceof Error) ||
          ![
            "FLEET_PREPARE_REQUIRED",
            "INTEGRITY_INVALID",
            "GPU_UNSUPPORTED",
          ].includes(error.message)
        )
          throw error;
        // A historical enrollment never starts Store qualification on startup.
        if (record.prepared.distribution !== "microsoft-store") denied();
      }
    }
    const gui = StoreNativeAuthority.prototype.creatorProof.call(
        this.#host.storeAuthority!,
      ).gui,
      actual = await this.#host.processIdentity(process.pid);
    if (!actual || !sameConsumerProcess(actual, gui)) denied();
    if (previous && !sameConsumerProcess(previous.owner, actual)) {
      const alive = await this.#host.processIdentity(previous.owner.pid);
      if (alive && sameConsumerProcess(alive, previous.owner))
        throw new Error("FLEET_REQUALIFICATION_BUSY");
    } else if (previous) {
      // A journal owned by this GUI must still have its original live owner in
      // this class. Losing that association is uncertainty, not authority.
      denied();
    }
    const target = await StorePreparationOperations.prototype.target.call(
        this.#operations,
        signal,
      ),
      journal: Journal = {
        version: 2,
        distribution: "microsoft-store",
        sid: actual.sid,
        transaction: previous?.transaction ?? randomUUID(),
        authority: fleetRecordAuthority(record),
        target: target.identity,
        owner: actual,
        phase: "fencing",
      };
    const owner: Owner = {
      enrollment: parseFleetRecord(record, this.#host.identity.sid),
      journal,
      setup: null,
      mutation: null,
      journalAttempted: false,
      maintenanceStarted: false,
      task: undefined as unknown as Promise<"requalified">,
    };
    this.#owner = owner;
    owner.task = Promise.resolve().then(async () => {
      owner.setup = await StorePreparationOperations.prototype.lock.call(
        this.#operations,
        target,
      );
      if (!owner.setup) throw new Error("FLEET_REQUALIFICATION_BUSY");
      owner.journalAttempted = true;
      await this.#save(journal, previous?.transaction ?? null);
      owner.maintenanceStarted = true;
      owner.mutation =
        await StorePrepareMaintenance.prototype.beforeMutation.call(
          this.#options.maintenance,
          target,
          signal,
        );
      await (
        legacyRepair
          ? repairApprovedLegacyStoreFleetRuntime
          : refreshApprovedStoreFleetRuntime
      )(
        {
          host: this.#host,
          operations: this.#operations,
          target,
          transaction: journal.transaction,
        },
        signal,
      );
      await readStoreFleetRuntimeIdentityForGui(
        this.#host,
        this.#operations,
        record,
        signal,
      );
      journal.phase = "qualified";
      await this.#save(journal, journal.transaction);
      return "requalified" as const;
    });
    this.#changed();
    let failure: unknown;
    try {
      await owner.task;
    } catch (error) {
      failure = error;
    }
    try {
      await this.#settle(owner);
    } catch (error) {
      if (failure !== undefined)
        throw new AggregateError(
          [failure, error],
          "FLEET_REQUALIFICATION_RECOVERY_REQUIRED",
        );
      throw error;
    }
    if (failure !== undefined) throw failure;
    return "requalified";
  }
  #settle(owner: Owner) {
    if (owner.settling) return owner.settling;
    const attempt = this.#finish(owner);
    owner.settling = attempt;
    owner.originalSettlement ??= attempt;
    void attempt.catch(() => {
      if (owner.settling === attempt) owner.settling = undefined;
    });
    return attempt;
  }
  async #finish(owner: Owner) {
    await owner.task.catch(() => undefined);
    if (this.#owner !== owner) denied();
    this.assertHost(this.#host);
    const maintenance = this.#options.maintenance;
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
    if (owner.setup) {
      await owner.setup.release();
      owner.setup = null;
    }
    if (owner.mutation) {
      await owner.mutation.release();
      owner.mutation = null;
    }
    if (owner.maintenanceStarted)
      await StorePrepareMaintenance.prototype.settle.call(
        maintenance,
        owner.task,
        async () => {
          this.#rebinding = true;
          try {
            await this.#options.rebind();
          } finally {
            this.#rebinding = false;
          }
        },
      );
    const current = owner.journalAttempted
      ? await readJournal(this.#host)
      : null;
    if (
      current &&
      (!sameConsumerProcess(current.owner, owner.journal.owner) ||
        current.target !== owner.journal.target)
    )
      denied();
    if (current) await this.#save(null, owner.journal.transaction);
    this.#owner = undefined;
    this.#changed();
  }
  async close() {
    this.#closed = true;
    this.#abort.abort();
    await this.#pending?.catch(() => undefined);
    if (this.#owner) denied();
    this.#listeners.clear();
  }
}
