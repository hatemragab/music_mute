/** Serialize update commands through their subsequent native-handle settlement.
 * Durable journal/maintenance state separately decides whether consumer intake is safe. */
export class ConsumerUpdateLifecycle {
  private reserved = false;
  private command: Promise<unknown> | undefined;
  private settlement: Promise<void> | undefined;
  constructor(private readonly options: { changed?(): void } = {}) {}

  busy(): boolean {
    return this.reserved;
  }
  commandActive(): boolean {
    return this.command !== undefined;
  }
  private changed(): void {
    try {
      this.options.changed?.();
    } catch {
      // Observers cannot release or corrupt the native-handle reservation.
    }
  }
  execute<T>(work: () => Promise<T>): Promise<T> {
    if (this.reserved) return Promise.reject(new Error("UPDATE_BUSY"));
    this.reserved = true;
    const command = Promise.resolve().then(work);
    this.command = command;
    const finished = () => {
      if (this.command === command) {
        this.command = undefined;
        this.changed();
      }
    };
    // Register completion before exposing the promise; keep busy until settle().
    void command.then(finished, finished);
    this.changed();
    return command;
  }
  settle(work: () => Promise<void>): Promise<void> {
    if (this.settlement) return this.settlement;
    const command = this.command;
    this.reserved = true;
    const settlement = Promise.resolve()
      .then(async () => {
        // Failed work still owns its handles until it has fully settled.
        if (command) await command.catch(() => undefined);
        await work();
      })
      .finally(() => {
        if (this.settlement === settlement) {
          this.settlement = undefined;
          this.reserved = false;
          this.changed();
        }
      });
    this.settlement = settlement;
    this.changed();
    return settlement;
  }
}
