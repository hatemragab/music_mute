import { ControlPlaneError } from "../../runtime/control-plane-client.js";
export async function awaitUnpair(
  operation: (
    force: boolean,
  ) => Promise<{ confirmed: true; machineId: string }>,
  force: boolean,
  options: {
    wait?: (milliseconds: number) => Promise<void>;
    timeoutMs?: number;
    monotonicNow?: () => number;
  },
): Promise<{ confirmed: true; machineId: string }> {
  const wait =
    options.wait ??
    (async (milliseconds: number) =>
      await new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > 10 * 60_000
  )
    throw new TypeError("Unpair timeout is invalid");
  const now = options.monotonicNow ?? (() => performance.now());
  const started = now();
  while (true) {
    try {
      return await operation(force);
    } catch (error) {
      if (
        force ||
        !(error instanceof ControlPlaneError) ||
        error.code !== "WORKER_CONFLICT" ||
        now() - started >= timeoutMs
      )
        throw error;
      await wait(Math.max(0, Math.min(5_000, timeoutMs - (now() - started))));
      if (now() - started >= timeoutMs) throw error;
    }
  }
}
