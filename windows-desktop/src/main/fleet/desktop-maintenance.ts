import type { ConsumerUpdateActivityPort } from "../update/factory.js";
import {
  DesktopMaintenanceGate,
  type DesktopMaintenanceLease,
  type MaintenanceIntakeReservation,
} from "../maintenance-gate.js";
interface Reservation {
  transaction: string;
  lease: DesktopMaintenanceLease | null;
  acquiring: Promise<void>;
  committing: Promise<void> | null;
  commitAttempted: boolean;
  committed: boolean;
  coordinatorReleased: boolean;
  activity: Awaited<ReturnType<ConsumerUpdateActivityPort["acquire"]>>;
}
/** Keep a retired Browser authority fenced until fleet's command and protected journal settle. */
export function createDesktopFleetRecoveryActivity(
  gate: DesktopMaintenanceGate,
  retire: (reservation: MaintenanceIntakeReservation) => Promise<void>,
): {
  consumerActivity: ConsumerUpdateActivityPort;
  commit(): Promise<void>;
  finishCommitted(): void;
  ownsReservation(): boolean;
} {
  let held: Reservation | null = null;
  const owns = (entry: Reservation) =>
    held === entry && gate.matches(entry.transaction);
  const commit = (entry: Reservation): Promise<void> => {
    if (held !== entry)
      return Promise.reject(new Error("UPDATE_FINALIZE_UNCONFIRMED"));
    if (entry.committing) return entry.committing;
    if (entry.committed) return Promise.resolve();
    // Even a rejected native retirement can have consumed a pipe/process.
    entry.commitAttempted = true;
    const task = entry.acquiring.then(async () => {
      if (!owns(entry) || !entry.lease)
        throw new Error("UPDATE_FINALIZE_UNCONFIRMED");
      await entry.lease.commit();
      entry.committed = true;
    });
    entry.committing = task;
    void task.then(
      () => {
        if (entry.committing === task) entry.committing = null;
      },
      () => {
        if (entry.committing === task) entry.committing = null;
      },
    );
    return task;
  };
  const consumerActivity: ConsumerUpdateActivityPort = {
    acquire: async (transaction, signal) => {
      signal.throwIfAborted();
      if (held) {
        const entry = held;
        if (entry.transaction !== transaction) throw new Error("UPDATE_BUSY");
        await entry.acquiring;
        if (!owns(entry) || !entry.lease)
          throw new Error("UPDATE_FINALIZE_UNCONFIRMED");
        await entry.lease.assertIdle(signal);
        entry.coordinatorReleased = false;
        return entry.activity;
      }
      const entry: Reservation = {
        transaction,
        lease: null,
        acquiring: Promise.resolve(),
        committing: null,
        commitAttempted: false,
        committed: false,
        coordinatorReleased: false,
        activity: undefined as unknown as Reservation["activity"],
      };
      held = entry;
      entry.activity = {
        assertIdle: async (check) => {
          await entry.acquiring;
          if (!owns(entry) || !entry.lease)
            throw new Error("UPDATE_FINALIZE_UNCONFIRMED");
          await entry.lease.assertIdle(check);
        },
        commit: () => commit(entry),
        release: async () => {
          await entry.acquiring;
          if (held !== entry) return;
          if (!owns(entry) || !entry.lease)
            throw new Error("UPDATE_FINALIZE_UNCONFIRMED");
          if (entry.commitAttempted) {
            entry.coordinatorReleased = true;
            return;
          }
          await entry.lease.release();
          if (held === entry) held = null;
        },
      };
      entry.acquiring = gate
        .acquire(transaction, 1, signal, retire)
        .then((lease) => {
          entry.lease = lease;
        })
        .catch((error) => {
          if (held === entry && !gate.matches(transaction)) held = null;
          throw error;
        });
      await entry.acquiring;
      return entry.activity;
    },
  };
  return {
    consumerActivity,
    commit: () =>
      held
        ? commit(held)
        : Promise.reject(new Error("UPDATE_FINALIZE_UNCONFIRMED")),
    finishCommitted: () => {
      if (!held) return;
      if (
        !owns(held) ||
        held.committing ||
        !held.committed ||
        !held.coordinatorReleased
      )
        throw new Error("UPDATE_FINALIZE_UNCONFIRMED");
      gate.finishCommitted();
      if (gate.reserved()) throw new Error("UPDATE_FINALIZE_UNCONFIRMED");
      held = null;
    },
    ownsReservation: () => held !== null && owns(held),
  };
}
