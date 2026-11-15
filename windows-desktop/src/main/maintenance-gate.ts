export interface MaintenanceIntakeReservation {
  assertIdle(): void;
  release(): void;
}
export interface DesktopMaintenanceLease {
  assertIdle(signal: AbortSignal): Promise<void>;
  release(): Promise<void>;
  commit(): Promise<void>;
}
/** Reserve browser and UI intake together before asynchronous maintenance work.
 * Failed/uncertain commits keep the fence held until explicit recovery. */
export class DesktopMaintenanceGate {
  private held:
    | {
        transaction: string;
        lease: DesktopMaintenanceLease;
        committed: boolean;
      }
    | undefined;
  constructor(
    private readonly ports: {
      idle(allowedPending: number): boolean;
      reserve(): MaintenanceIntakeReservation | null;
      changed(): void;
    },
  ) {}
  reserved(): boolean {
    return !!this.held;
  }
  matches(transaction: string): boolean {
    return this.held?.transaction === transaction;
  }
  async acquire(
    transaction: string,
    allowedPending: number,
    signal: AbortSignal,
    retire: (reservation: MaintenanceIntakeReservation) => Promise<void>,
  ): Promise<DesktopMaintenanceLease> {
    signal.throwIfAborted();
    if (this.held) {
      if (this.held.transaction !== transaction) throw new Error("UPDATE_BUSY");
      await this.held.lease.assertIdle(signal);
      return this.held.lease;
    }
    // Publish the intake fence before invoking any callbacks that may reenter.
    const held = {
      transaction,
      committed: false,
      lease: undefined as unknown as DesktopMaintenanceLease,
    };
    this.held = held;
    this.ports.changed();
    let reservation: MaintenanceIntakeReservation | null = null;
    try {
      reservation = this.ports.reserve();
      if (!reservation) throw new Error("UPDATE_BUSY");
      const reserved = reservation;
      let retired = false;
      const assertIdle = async (check: AbortSignal) => {
        check.throwIfAborted();
        if (this.held !== held || !this.ports.idle(allowedPending))
          throw new Error("UPDATE_BUSY");
        reserved.assertIdle();
        check.throwIfAborted();
      };
      const lease: DesktopMaintenanceLease = {
        assertIdle,
        release: async () => {
          if (this.held !== held) return;
          if (retired || held.committed)
            throw new Error("UPDATE_FINALIZE_UNCONFIRMED");
          reserved.release();
          this.held = undefined;
          this.ports.changed();
        },
        commit: async () => {
          if (held.committed) return;
          await assertIdle(AbortSignal.timeout(30000));
          // Even a rejected retirement can have consumed a process or pipe.
          retired = true;
          await retire(reserved);
          held.committed = true;
          this.ports.changed();
        },
      };
      held.lease = lease;
      await assertIdle(signal);
      return lease;
    } catch (error) {
      reservation?.release();
      if (this.held === held) this.held = undefined;
      this.ports.changed();
      throw error;
    }
  }
  /** Called after the update command and its Prepare lock have actually settled. */
  finishCommitted(): void {
    if (!this.held?.committed) return;
    this.held = undefined;
    this.ports.changed();
  }
}
