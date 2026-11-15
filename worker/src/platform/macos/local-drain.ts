import { loadLocalRuntimeStatus } from "../../runtime/local-runtime-status.js";

export async function waitForLocalDrain(options: {
  runtimeStatusPath: string;
  force: boolean;
  timeoutMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<{ forced: boolean; activeAttempts: number }> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > 10 * 60_000
  )
    throw new TypeError("Drain timeout is invalid");
  const wait =
    options.wait ??
    (async (milliseconds: number) =>
      await new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const started = Date.now();
  while (true) {
    let activeAttempts: number;
    try {
      activeAttempts = (await loadLocalRuntimeStatus(options.runtimeStatusPath))
        .activeAttemptIds.length;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (options.force) return { forced: true, activeAttempts: -1 };
      throw new Error(
        "Worker runtime status is unavailable; refuse to stop without --force",
      );
    }
    if (activeAttempts === 0) return { forced: false, activeAttempts: 0 };
    if (options.force) return { forced: true, activeAttempts };
    const elapsed = Date.now() - started;
    if (elapsed >= timeoutMs)
      throw new Error(
        `Worker drain timed out with ${activeAttempts} active attempt(s); retry later or use --force`,
      );
    await wait(Math.min(1_000, timeoutMs - elapsed));
  }
}
