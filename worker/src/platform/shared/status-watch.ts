/** Shared CLI observation loops; adapters supply authoritative native snapshots. */
export interface ReadinessStatus {
  readiness: {
    phase: string;
    modelReady: boolean;
    blockers: readonly string[];
  };
}

export async function watchStatus<T>(
  read: () => Promise<T>,
  render: (status: T) => string,
  stdout: (value: string) => void,
  json: boolean,
  wait?: (milliseconds: number) => Promise<void>,
): Promise<void> {
  let stopped = false;
  let previous = "";
  let wakeStop: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  const stop = () => {
    stopped = true;
    wakeStop?.();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!stopped) {
      const status = await read();
      const rendered = render(status);
      if (json || rendered !== previous) stdout(rendered);
      previous = rendered;
      if (stopped) break;
      const pause = wait
        ? wait(2_000)
        : new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 2_000);
          });
      await Promise.race([
        pause,
        new Promise<void>((resolve) => {
          wakeStop = resolve;
        }),
      ]);
      if (timer) clearTimeout(timer);
      timer = undefined;
      wakeStop = undefined;
    }
  } finally {
    if (timer) clearTimeout(timer);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

export async function waitForReady<T extends ReadinessStatus>(
  read: () => Promise<T>,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  onPhase?: (status: T) => void,
  timeoutMs = 360_000,
  now: () => number = () => performance.now(),
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new TypeError("Readiness timeout must be positive");
  const deadline = now() + timeoutMs;
  let previousPhase = "";
  while (true) {
    const status = await read();
    if (status.readiness.phase !== previousPhase) {
      onPhase?.(status);
      previousPhase = status.readiness.phase;
    }
    if (status.readiness.modelReady) return status;
    if (now() >= deadline)
      throw new Error(
        `Worker did not become model-ready within ${timeoutMs / 1_000} seconds: ${status.readiness.blockers.join(", ")}`,
      );
    await wait(Math.min(2_000, deadline - now()));
  }
}
