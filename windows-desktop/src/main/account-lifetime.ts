export interface IdleAccountReservation {
  assertIdle(): void;
  release(): void;
}
/** Event-driven idle grace. Reserve synchronously before deciding that intake can retire. */
export class AccountAuthorityLifetime {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private retiring = false;
  private epoch = 0;
  constructor(
    private readonly options: {
      headless(): boolean;
      idle(): boolean;
      reserve(): IdleAccountReservation | null;
      retire(reservation: IdleAccountReservation): void;
      graceMs?: number;
    },
  ) {
    if (
      !Number.isSafeInteger(options.graceMs ?? 30000) ||
      (options.graceMs ?? 30000) < 1
    )
      throw new Error("LIFETIME_CONFIGURATION_INVALID");
  }
  changed(): void {
    if (this.closed || this.retiring) return;
    if (!this.options.headless() || !this.options.idle()) {
      this.cancelTimer();
      return;
    }
    if (this.timer) return;
    const epoch = ++this.epoch;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (
        this.closed ||
        epoch !== this.epoch ||
        !this.options.headless() ||
        !this.options.idle()
      )
        return;
      const reservation = this.options.reserve();
      if (!reservation) return;
      try {
        reservation.assertIdle();
        if (!this.options.headless() || !this.options.idle()) {
          reservation.release();
          return;
        }
        this.retiring = true;
        this.options.retire(reservation);
      } catch {
        this.retiring = false;
        reservation.release();
      }
    }, this.options.graceMs ?? 30000);
    this.timer.unref?.();
  }
  private cancelTimer(): void {
    ++this.epoch;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  close(): void {
    this.closed = true;
    this.cancelTimer();
  }
}
