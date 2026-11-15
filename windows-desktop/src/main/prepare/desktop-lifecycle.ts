import type { PrepareView } from "../../shared/prepare-contracts.js";

export interface DesktopAutomaticPrepareState {
  headless: boolean;
  closing: boolean;
  configured: boolean;
  updateBusy: boolean;
  fleetRecoveryBusy: boolean;
  updateBlocked: boolean;
  fleetRecoveryInvalid: boolean;
  maintenanceReserved: boolean;
  prepareBusy: boolean;
}
export function desktopAutomaticPreparationAllowed(
  state: DesktopAutomaticPrepareState,
): boolean {
  return (
    state.configured &&
    !state.headless &&
    !state.closing &&
    !state.updateBusy &&
    !state.fleetRecoveryBusy &&
    !state.updateBlocked &&
    !state.fleetRecoveryInvalid &&
    !state.maintenanceReserved &&
    !state.prepareBusy
  );
}

export interface DesktopPrepareOwner {
  /** Reuse this immutable owner only for the same controller, Host and maintenance pair. */
  current(): boolean;
  start(): Promise<PrepareView>;
  cancel(): Promise<void>;
  settle(
    task: Promise<PrepareView>,
    rebind: () => Promise<void>,
  ): Promise<void>;
  rebind: readonly (() => Promise<void>)[];
  ready(): void;
  failed(): void;
  setup(): void;
}

/** Actual Main startup/settlement owner. Ready presentation is not permission to
 * recover workers until the captured Prepare transaction and rebind settle. */
export class DesktopPreparationLifecycle {
  private automaticStarted = false;
  private automaticOwner: DesktopPrepareOwner | undefined;
  private automaticSetupShown = false;
  private closed = false;
  private readonly pending = new Map<Promise<void>, DesktopPrepareOwner>();
  private readonly retained = new Map<
    DesktopPrepareOwner,
    Promise<PrepareView>
  >();
  private readonly observed = new WeakMap<
    Promise<PrepareView>,
    Promise<void>
  >();
  private recovery: Promise<void> | undefined;
  suppressAutomatic(): void {
    this.automaticStarted = true;
  }
  activity() {
    return {
      pending: this.pending.size,
      retained: this.retained.size,
      idle: this.pending.size === 0 && this.retained.size === 0,
    };
  }
  startAutomatic(
    owner: DesktopPrepareOwner,
    allowed: () => boolean,
  ): Promise<void> | null {
    if (this.closed || this.automaticStarted || !allowed() || !owner.current())
      return null;
    this.automaticStarted = true;
    this.automaticOwner = owner;
    return this.observe(owner.start(), owner);
  }
  project(owner: DesktopPrepareOwner, view: PrepareView): void {
    if (
      this.closed ||
      this.automaticOwner !== owner ||
      this.automaticSetupShown ||
      !owner.current() ||
      view.state !== "preparing" ||
      !view.stage ||
      view.stage === "inspect"
    )
      return;
    this.automaticSetupShown = true;
    owner.setup();
  }
  observe(
    task: Promise<PrepareView>,
    owner: DesktopPrepareOwner,
  ): Promise<void> {
    const previous = this.observed.get(task);
    if (previous) return previous;
    if (this.closed) return Promise.reject(new Error("PREPARE_INTERRUPTED"));
    const completion = task
      .then(async (view) => {
        await owner.settle(task, () => this.rebind(owner));
        // A successful retry by the same exact controller/maintenance owner has
        // settled its retained lease too; never clear another owner's failure.
        this.retained.delete(owner);
        if (view.state === "ready" && !this.closed && owner.current())
          owner.ready();
      })
      .catch(() => {
        if (!this.retained.has(owner)) this.retained.set(owner, task);
        if (!this.closed && owner.current()) {
          try {
            owner.failed();
          } catch {
            /* Presentation cannot release cleanup authority. */
          }
        }
      })
      .finally(() => {
        this.pending.delete(completion);
        if (this.automaticOwner === owner) this.automaticOwner = undefined;
      });
    this.observed.set(task, completion);
    this.pending.set(completion, owner);
    return completion;
  }
  private async rebind(owner: DesktopPrepareOwner): Promise<void> {
    for (const step of owner.rebind) {
      if (this.closed || !owner.current()) return;
      await step();
    }
  }
  fence(): void {
    this.closed = true;
  }
  async cancel(): Promise<void> {
    const owners = new Set([...this.pending.values(), ...this.retained.keys()]);
    const results = await Promise.allSettled(
      [...owners].map((owner) => Promise.resolve().then(() => owner.cancel())),
    );
    if (results.some((result) => result.status === "rejected"))
      throw new Error("PREPARE_INTERRUPTED");
  }
  async wait(): Promise<void> {
    await Promise.all(this.pending.keys());
  }
  recoverCleanup(): Promise<void> {
    if (this.recovery) return this.recovery;
    const recovery = Promise.allSettled(
      [...this.retained].map(async ([owner, task]) => {
        await owner.cancel();
        await owner.settle(task, () => this.rebind(owner));
        this.retained.delete(owner);
      }),
    )
      .then((results) => {
        if (results.some((result) => result.status === "rejected"))
          throw new Error("PREPARE_INTERRUPTED");
      })
      .finally(() => {
        if (this.recovery === recovery) this.recovery = undefined;
      });
    this.recovery = recovery;
    return recovery;
  }
  async close(): Promise<void> {
    this.fence();
    await this.cancel();
    await this.wait();
    await this.recoverCleanup();
    if (!this.activity().idle) throw new Error("PREPARE_INTERRUPTED");
  }
}
