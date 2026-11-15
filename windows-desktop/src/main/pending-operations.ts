/** Keep native/file resources alive until every admitted UI command has finished. */
export class PendingOperations {
  private accepting = true;
  private readonly pending = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  private readonly listeners = new Set<() => void>();

  activity(): { pending: number; accepting: boolean } {
    return { pending: this.pending.size, accepting: this.accepting };
  }
  subscribeActivity(listener: () => void): () => void {
    this.listeners.add(listener);
    listener();
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {}
    }
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting)
      return Promise.reject(new Error("DESKTOP_SHUTTING_DOWN"));
    const promise = Promise.resolve().then(operation);
    this.pending.add(promise);
    this.changed();
    void promise.then(
      () => {
        this.pending.delete(promise);
        this.changed();
      },
      () => {
        this.pending.delete(promise);
        this.changed();
      },
    );
    return promise;
  }

  /** A failed cleanup must not release the barrier while another owner is settling. */
  runCleanup(
    operations: readonly (() => void | Promise<unknown>)[],
  ): Promise<void> {
    return this.run(async () => {
      const results = await Promise.allSettled(
        operations.map((operation) => Promise.resolve().then(operation)),
      );
      if (results.some((result) => result.status === "rejected"))
        throw new Error("DESKTOP_CLEANUP_PENDING");
    });
  }

  close(): Promise<void> {
    this.accepting = false;
    this.changed();
    this.closing ??= (async () => {
      while (this.pending.size) await Promise.allSettled(this.pending);
    })();
    return this.closing;
  }
}

/** A late dialog result has no authority after shutdown; never create its file. */
export async function waitForDialog<T>(
  result: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) void result.catch(() => {});
  signal.throwIfAborted();
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("DIALOG_CANCELLED"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const value = await Promise.race([result, cancelled]);
    signal.throwIfAborted();
    return value;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
