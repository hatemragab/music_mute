import type { ConsumerOwnedProcess } from "../../../../worker/src/platform/windows/consumer-native.js";
import type { SessionSnapshot } from "../../shared/session-contracts.js";

export interface PersonalActivityConnection {
  notify(
    owner: ConsumerOwnedProcess,
    signal: AbortSignal,
  ): Promise<SessionSnapshot>;
  close(): Promise<void>;
}
export interface PersonalActivityNotifierOptions {
  owner: ConsumerOwnedProcess;
  subscribe(listener: () => void): () => void;
  open(): Promise<PersonalActivityConnection>;
  signal: AbortSignal;
  /** Transport retry delay only; no status reads or readiness claims. */
  delay?(milliseconds: number, signal: AbortSignal): Promise<void>;
}
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}
/** A bounded, coalesced wake-up. Parent verifies exact role ownership and queries
 * real child/GPU idle; the sender never supplies an idle or account assertion. */
export function createPersonalActivityNotifier(
  options: PersonalActivityNotifierOptions,
): { dispose(): Promise<void> } {
  if (options.owner.role !== "personal")
    throw new Error("PERSONAL_CONTEXT_INVALID");
  const lifetime = new AbortController(),
    abort = () => lifetime.abort(options.signal.reason);
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();
  let pending = true,
    connection: PersonalActivityConnection | undefined,
    closing = false,
    running: Promise<void> | undefined,
    disposing: Promise<void> | undefined;
  const pump = async () => {
    let retry = 50;
    while (pending && !lifetime.signal.aborted) {
      try {
        // Never open a replacement while an old helper's close is uncertain.
        if (closing && connection) {
          await connection.close();
          connection = undefined;
          closing = false;
        }
        connection ??= await options.open();
        lifetime.signal.throwIfAborted();
        pending = false;
        await connection.notify(options.owner, lifetime.signal);
        retry = 50;
      } catch {
        pending = true;
        closing = !!connection;
        if (lifetime.signal.aborted) return;
        try {
          await (options.delay ?? delay)(retry, lifetime.signal);
        } catch {
          return;
        }
        retry = Math.min(1000, retry * 2);
      }
    }
  };
  const wake = () => {
    pending = true;
    if (running || lifetime.signal.aborted) return;
    running = pump().finally(() => {
      running = undefined;
      if (pending && !lifetime.signal.aborted) wake();
    });
  };
  const unsubscribe = options.subscribe(wake);
  wake();
  return {
    dispose: () =>
      (disposing ??= (async () => {
        unsubscribe();
        lifetime.abort();
        options.signal.removeEventListener("abort", abort);
        await running;
        await connection?.close();
        connection = undefined;
      })()),
  };
}
