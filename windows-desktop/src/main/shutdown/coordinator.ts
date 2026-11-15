export interface ShutdownView {
  phase:
    "open" | "settling" | "cleaning" | "releasing" | "pending" | "complete";
  attempt: number;
  errorCode: "SHUTDOWN_PENDING" | null;
}
export type ShutdownWork = () => void | Promise<void>;
export interface DesktopShutdownPorts {
  /** Synchronous intake fence. Idempotent; retry also attempts an incomplete fence. */
  fence(): void;
  /** Invoke cancellation/wake operations before awaiting the command/init barrier. */
  cancel(): readonly ShutdownWork[];
  /** Actual PendingOperations.close plus admitted initialization settlement. */
  settle(): Promise<void>;
  /** Re-read current services after settlement. Keep exact failed owners reachable. */
  cleanup(): readonly ShutdownWork[];
  /** Positive current activity/owned-cleanup proof; no Node/PID/abandoned-lock guess. */
  assertIdle(): void;
  /** Capture exact gate/Host/native release closures once, only after positive idle. */
  release(): readonly ShutdownWork[];
}
/** Shutdown is a retryable ownership transition, not a finally-block exit. */
export class DesktopShutdownCoordinator {
  private state: ShutdownView = { phase: "open", attempt: 0, errorCode: null };
  private current: Promise<ShutdownView> | undefined;
  private fenced = false;
  private releases: readonly ShutdownWork[] | undefined;
  private released = 0;
  private readonly listeners = new Set<(view: ShutdownView) => void>();
  constructor(private readonly ports: DesktopShutdownPorts) {}
  view(): ShutdownView {
    return { ...this.state };
  }
  activity() {
    return {
      pending: this.current ? 1 : 0,
      retained: this.state.phase === "pending" ? 1 : 0,
      idle: this.state.phase === "open" || this.state.phase === "complete",
    };
  }
  subscribe(listener: (view: ShutdownView) => void) {
    this.listeners.add(listener);
    this.notify(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify(listener: (view: ShutdownView) => void) {
    try {
      listener(this.view());
    } catch {}
  }
  private changed() {
    for (const listener of this.listeners) this.notify(listener);
  }
  private phase(phase: ShutdownView["phase"]) {
    this.state = {
      ...this.state,
      phase,
      errorCode: phase === "pending" ? "SHUTDOWN_PENDING" : null,
    };
    this.changed();
  }
  begin(): Promise<ShutdownView> {
    if (this.state.phase === "complete") return Promise.resolve(this.view());
    if (this.current) return this.current;
    let resolve!: (view: ShutdownView) => void;
    const current = new Promise<ShutdownView>((accept) => {
      resolve = accept;
    });
    this.current = current;
    this.state = {
      phase: "settling",
      attempt: this.state.attempt + 1,
      errorCode: null,
    };
    if (!this.fenced) {
      try {
        this.ports.fence();
        this.fenced = true;
      } catch {
        /* Retain all gates until the fence succeeds on retry. */
      }
    }
    // These calls run now, before settle can wait for commands blocked on children.
    let cancel: Promise<PromiseSettledResult<void>[]>;
    try {
      cancel = this.runAll(this.ports.cancel());
    } catch {
      cancel = Promise.resolve([{ status: "rejected", reason: undefined }]);
    }
    this.changed();
    void this.attempt(cancel).then(() => {
      this.current = undefined;
      this.changed();
      resolve(this.view());
    });
    return current;
  }
  retry(): Promise<ShutdownView> {
    return this.begin();
  }
  private runAll(stages: readonly ShutdownWork[]) {
    return Promise.allSettled(
      stages.map((run) => {
        try {
          return Promise.resolve(run());
        } catch (error) {
          return Promise.reject(error);
        }
      }),
    );
  }
  private async attempt(cancel: Promise<PromiseSettledResult<void>[]>) {
    try {
      let settled = false;
      try {
        await this.ports.settle();
        settled = true;
      } catch {
        /* No release without a confirmed barrier. */
      }
      await cancel;
      if (!settled) {
        this.phase("pending");
        return;
      }
      this.phase("cleaning");
      const results = await this.runAll(this.ports.cleanup());
      // Successful same-owner final cleanup/idle can supersede an earlier failed
      // cancellation ACK. A final cleanup rejection can never be swallowed.
      if (
        !this.fenced ||
        results.some((result) => result.status === "rejected")
      ) {
        this.phase("pending");
        return;
      }
      this.ports.assertIdle();
      this.releases ??= [...this.ports.release()];
      this.phase("releasing");
      while (this.released < this.releases.length) {
        this.ports.assertIdle();
        await this.releases[this.released]!();
        this.released++;
      }
      this.phase("complete");
    } catch {
      this.phase("pending");
    }
  }
}
