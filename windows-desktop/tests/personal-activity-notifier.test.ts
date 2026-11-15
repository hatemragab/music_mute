import { expect, it, vi } from "vitest";
import {
  createPersonalActivityNotifier,
  type PersonalActivityConnection,
} from "../src/main/personal/activity-notifier.js";
import type { SessionSnapshot } from "../src/shared/session-contracts.js";

const owner = {
    role: "personal" as const,
    nonce: "a".repeat(64),
    identity: {
      sid: "S-1-5-21-1-2-3-1001",
      sessionId: 1,
      pid: 123,
      creationTime: "456",
    },
  },
  snapshot = {} as SessionSnapshot;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  let change!: () => void;
  const off = vi.fn(),
    abort = new AbortController(),
    notify = vi.fn<PersonalActivityConnection["notify"]>(async () => snapshot),
    close = vi.fn(async () => {}),
    connection: PersonalActivityConnection = { notify, close },
    open = vi.fn(async () => connection),
    wait = deferred(),
    delay = vi.fn(async (_milliseconds: number, signal: AbortSignal) => {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void wait.promise.then(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        });
      });
      signal.throwIfAborted();
    });
  return {
    abort,
    notify,
    close,
    open,
    delay,
    wait,
    off,
    change: () => change(),
    start: () =>
      createPersonalActivityNotifier({
        owner,
        signal: abort.signal,
        open,
        delay,
        subscribe: (listener) => {
          change = listener;
          return off;
        },
      }),
  };
}
it("actual change callbacks return synchronously and coalesce to one additional authenticated owner wake without idle/account payload", async () => {
  const f = fixture(),
    wait = deferred();
  f.notify.mockImplementationOnce(async () => {
    await wait.promise;
    return snapshot;
  });
  const notifier = f.start();
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledOnce());
  f.change();
  f.change();
  f.change();
  expect(f.notify).toHaveBeenCalledOnce();
  wait.resolve();
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledTimes(2));
  expect(f.notify.mock.calls[0]![0]).toEqual(owner);
  expect(f.delay).not.toHaveBeenCalled();
  await notifier.dispose();
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.off).toHaveBeenCalledOnce();
});
it("retains the final wake on transient transport failure and retries it without another controller change or status read", async () => {
  const f = fixture();
  f.notify.mockRejectedValueOnce(new Error("TICKET_BUSY"));
  const notifier = f.start();
  await vi.waitFor(() => expect(f.delay).toHaveBeenCalledOnce());
  expect(f.delay.mock.calls[0]![0]).toBe(50);
  expect(f.notify).toHaveBeenCalledOnce();
  f.wait.resolve();
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledTimes(2));
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.open).toHaveBeenCalledTimes(2);
  await notifier.dispose();
});
it("uncertain old helper close prevents replacement and keeps the wake pending until acknowledged close", async () => {
  const f = fixture(),
    confirmed = deferred();
  f.notify.mockRejectedValueOnce(new Error("HELPER_LOST"));
  f.close.mockRejectedValueOnce(new Error("CLOSE_ACK_LOST"));
  f.close.mockImplementationOnce(async () => {
    await confirmed.promise;
  });
  const notifier = f.start();
  await vi.waitFor(() => expect(f.delay).toHaveBeenCalledOnce());
  f.wait.resolve();
  await vi.waitFor(() => expect(f.delay).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(f.close).toHaveBeenCalledTimes(2));
  expect(f.open).toHaveBeenCalledOnce();
  expect(f.notify).toHaveBeenCalledOnce();
  confirmed.resolve();
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledTimes(2));
  expect(f.open).toHaveBeenCalledTimes(2);
  expect(f.close).toHaveBeenCalledTimes(2);
  expect(f.delay.mock.calls[1]![0]).toBe(100);
  await notifier.dispose();
});
it("role lifetime closure interrupts retry and disposal detaches the listener instead of emitting repeated status requests", async () => {
  const f = fixture();
  f.open.mockRejectedValueOnce(new Error("SESSION_STARTING"));
  const notifier = f.start();
  await vi.waitFor(() => expect(f.delay).toHaveBeenCalledOnce());
  f.abort.abort();
  await notifier.dispose();
  f.change();
  expect(f.open).toHaveBeenCalledOnce();
  expect(f.notify).not.toHaveBeenCalled();
  expect(f.off).toHaveBeenCalledOnce();
});
it("disposal awaits an in-flight signal-aware RPC and closes the exact helper once", async () => {
  const f = fixture();
  let signal!: AbortSignal;
  f.notify.mockImplementationOnce(
    async (_owner?: unknown, current?: AbortSignal) => {
      signal = current!;
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
      return snapshot;
    },
  );
  const notifier = f.start();
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledOnce());
  await notifier.dispose();
  await notifier.dispose();
  expect(signal.aborted).toBe(true);
  expect(f.notify).toHaveBeenCalledOnce();
  expect(f.close).toHaveBeenCalledOnce();
});
