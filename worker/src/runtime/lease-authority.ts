export interface LocalClock {
  monotonicMs(): number;
  wallMs(): number;
}

const SYSTEM_CLOCK: LocalClock = {
  monotonicMs: () => performance.now(),
  wallMs: () => Date.now(),
};

interface WindowAnchor {
  monotonicMs: number;
  wallMs: number;
  durationMs: number;
}

export class OwnershipLostError extends Error {
  constructor(readonly reason: string) {
    super(`Worker attempt ownership is no longer certain (${reason})`);
    this.name = "OwnershipLostError";
  }
}

export class LeaseAuthority {
  private lease: WindowAnchor;
  private readonly deadline: WindowAnchor;
  private lostReason: string | null = null;

  constructor(
    serverTime: string,
    leaseExpiresAt: string,
    deadlineAt: string,
    private readonly safetyMarginMs = 5_000,
    private readonly clock: LocalClock = SYSTEM_CLOCK,
  ) {
    if (
      !Number.isSafeInteger(safetyMarginMs) ||
      safetyMarginMs < 100 ||
      safetyMarginMs > 30_000
    )
      throw new TypeError("Lease safety margin is invalid");
    const anchor = this.localAnchor();
    this.lease = this.window(serverTime, leaseExpiresAt, anchor);
    this.deadline = this.window(serverTime, deadlineAt, anchor);
    this.assertCurrent();
  }

  refresh(
    serverTime: string,
    leaseExpiresAt: string,
    requestStarted: { monotonicMs: number; wallMs: number },
  ): void {
    this.assertCurrent();
    const next = this.window(serverTime, leaseExpiresAt, requestStarted);
    if (next.durationMs <= this.safetyMarginMs)
      throw new OwnershipLostError("renewal-window-too-short");
    this.lease = next;
  }

  lose(reason: string): void {
    this.lostReason = reason.slice(0, 100);
  }

  assertCurrent(): void {
    if (this.lostReason) throw new OwnershipLostError(this.lostReason);
    if (this.remainingMs() <= 0) {
      this.lostReason = "lease-or-deadline-expired";
      throw new OwnershipLostError(this.lostReason);
    }
  }

  remainingMs(): number {
    if (this.lostReason) return 0;
    return Math.max(
      0,
      Math.min(this.remaining(this.lease), this.remaining(this.deadline)) -
        this.safetyMarginMs,
    );
  }

  deadlineRemainingMs(): number {
    if (this.lostReason) return 0;
    return Math.max(0, this.remaining(this.deadline) - this.safetyMarginMs);
  }

  sample(): { monotonicMs: number; wallMs: number } {
    return this.localAnchor();
  }

  private remaining(anchor: WindowAnchor): number {
    const monotonicElapsed = Math.max(
      0,
      this.clock.monotonicMs() - anchor.monotonicMs,
    );
    const wallElapsed = Math.max(0, this.clock.wallMs() - anchor.wallMs);
    return anchor.durationMs - Math.max(monotonicElapsed, wallElapsed);
  }

  private localAnchor(): { monotonicMs: number; wallMs: number } {
    return {
      monotonicMs: this.clock.monotonicMs(),
      wallMs: this.clock.wallMs(),
    };
  }

  private window(
    serverTime: string,
    expiresAt: string,
    anchor: { monotonicMs: number; wallMs: number },
  ): WindowAnchor {
    const server = Date.parse(serverTime);
    const expiry = Date.parse(expiresAt);
    const durationMs = expiry - server;
    if (!Number.isFinite(durationMs) || durationMs <= 0)
      throw new OwnershipLostError("invalid-server-window");
    return { ...anchor, durationMs };
  }
}
