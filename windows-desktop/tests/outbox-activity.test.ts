import { expect, it, vi } from "vitest";
import { PersonalCompletionProducer } from "../src/main/outbox/completion-producer.js";
import type { VerifiedPersonalPair } from "../src/main/reuse/pair.js";
function deferred() {
  let resolve!: (pairs: VerifiedPersonalPair[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<VerifiedPersonalPair[]>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(
  read: (signal: AbortSignal) => Promise<VerifiedPersonalPair[]>,
  consumersAllowed?: () => boolean,
) {
  return new PersonalCompletionProducer({
    ...(consumersAllowed ? { consumersAllowed } : {}),
    source: { read },
    store: { rememberPersonal: vi.fn(async () => "local:fixture") },
    cache: {
      local: vi.fn(async () => {
        throw new Error("UNEXPECTED_ARTIFACT");
      }),
      verify: vi.fn(async () => {}),
    },
    pins: {
      pin: vi.fn(async () => {
        throw new Error("UNEXPECTED_PIN");
      }),
    },
    outbox: {
      stageCaptured: vi.fn(async () => {
        throw new Error("UNEXPECTED_CAPTURE");
      }),
    },
    scope: () => null,
    assertScope: () => {
      throw new Error("UNEXPECTED_ACCOUNT");
    },
  });
}
it("coalesces paused directory events without new reads, and retains accepted read activity until explicit resume", async () => {
  let allowed = false;
  const first = deferred(),
    read = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue([]),
    producer = fixture(read, () => allowed);
  await producer.reconcile();
  await producer.resume();
  expect(read).not.toHaveBeenCalled();
  expect(producer.activity()).toEqual({
    pending: 0,
    queued: 1,
    accepting: false,
    idle: true,
  });
  allowed = true;
  const run = producer.resume();
  expect(producer.activity().pending).toBe(1);
  allowed = false;
  expect(producer.reconcile()).toBe(run);
  expect(producer.activity().idle).toBe(false);
  first.resolve([]);
  await run;
  expect(read).toHaveBeenCalledOnce();
  expect(producer.activity()).toEqual({
    pending: 0,
    queued: 1,
    accepting: false,
    idle: true,
  });
  allowed = true;
  await producer.resume();
  expect(read).toHaveBeenCalledTimes(2);
  expect(producer.activity().queued).toBe(0);
  await producer.dispose();
});
it("truthful activity remains pending across coalesced directory changes with no false idle boundary", async () => {
  const first = deferred(),
    second = deferred(),
    read = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise),
    producer = fixture(read),
    seen: ReturnType<PersonalCompletionProducer["activity"]>[] = [];
  producer.subscribeActivity(() => seen.push(producer.activity()));
  const run = producer.reconcile();
  expect(producer.activity()).toEqual({
    pending: 1,
    queued: 0,
    accepting: true,
    idle: false,
  });
  expect(producer.reconcile()).toBe(run);
  expect(producer.activity().queued).toBe(1);
  first.resolve([]);
  await run;
  expect(producer.activity().idle).toBe(false);
  expect(read).toHaveBeenCalledTimes(2);
  expect(seen.slice(1).every((value) => !value.idle)).toBe(true);
  second.resolve([]);
  await producer.dispose();
  expect(producer.activity()).toEqual({
    pending: 0,
    queued: 0,
    accepting: false,
    idle: true,
  });
});
it("dispose retains the active source/Host promise until actual teardown completes", async () => {
  const pending = deferred(),
    producer = fixture(() => pending.promise);
  const run = producer.reconcile();
  let closed = false;
  const disposing = producer.dispose().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(producer.activity()).toMatchObject({
    pending: 1,
    accepting: false,
    idle: false,
  });
  pending.resolve([]);
  await run;
  await disposing;
  expect(closed).toBe(true);
  expect(producer.activity().idle).toBe(true);
});
it("failed reconciliation clears activity and observer errors cannot alter authority", async () => {
  const pending = deferred(),
    producer = fixture(() => pending.promise),
    listener = vi.fn(() => {
      throw new Error("VIEW_ERROR");
    });
  const off = producer.subscribeActivity(listener),
    run = producer.reconcile();
  pending.reject(new Error("PERSONAL_COMPLETION_FAILED"));
  await expect(run).rejects.toThrow("PERSONAL_COMPLETION_FAILED");
  expect(producer.activity().pending).toBe(0);
  off();
  await producer.dispose();
});
