/** One transfer budget, including redirects and waiting for response headers. */
export class TransferBudget {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly totalTimer: ReturnType<typeof setTimeout>;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    timeoutMs = 10 * 60_000,
    private readonly idleTimeoutMs = 30_000,
    signal?: AbortSignal,
  ) {
    for (const value of [timeoutMs, idleTimeoutMs]) {
      if (!Number.isSafeInteger(value) || value < 1_000 || value > 60 * 60_000)
        throw new TypeError("Transfer timeout is invalid");
    }
    this.signal = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal;
    this.totalTimer = setTimeout(() => {
      this.controller.abort(new Error("Transfer total timeout"));
    }, timeoutMs);
    this.totalTimer.unref();
    this.progress();
  }

  progress(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.controller.abort(new Error("Transfer inactivity timeout"));
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  dispose(): void {
    clearTimeout(this.totalTimer);
    clearTimeout(this.idleTimer);
  }
}
