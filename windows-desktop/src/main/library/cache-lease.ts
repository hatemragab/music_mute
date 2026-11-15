import { setTimeout as delay } from "node:timers/promises";
import type { HostContext } from "../host-context.js";
/** Retry only lock admission, never a mutation or uncertain write. No HTTP/status polling. */
export async function acquireLibraryCacheLease(
  host: HostContext,
  signal?: AbortSignal,
) {
  const deadline = performance.now() + 2000;
  for (;;) {
    signal?.throwIfAborted();
    const lease = await host.native.acquireMutex("cache");
    if (lease) return lease;
    if (performance.now() >= deadline) throw new Error("LIBRARY_BUSY");
    await delay(25, undefined, signal ? { signal } : undefined);
  }
}
