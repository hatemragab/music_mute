import { describe, expect, it, vi } from "vitest";
import { ConsumerUpdateLifecycle } from "../src/main/update/desktop-lifecycle.js";
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void,
    reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
describe("consumer updater command and handle settlement lifetime", () => {
  it("keeps intake reserved after successful command completion until real settlement finishes", async () => {
    const command = deferred<string>(),
      close = deferred<void>(),
      events: { busy: boolean; active: boolean }[] = [],
      lifecycle = new ConsumerUpdateLifecycle({
        changed: () =>
          events.push({
            busy: lifecycle.busy(),
            active: lifecycle.commandActive(),
          }),
      });
    const running = lifecycle.execute(() => command.promise);
    expect(lifecycle.busy()).toBe(true);
    expect(lifecycle.commandActive()).toBe(true);
    command.resolve("prepared");
    await expect(running).resolves.toBe("prepared");
    expect(lifecycle.busy()).toBe(true);
    expect(lifecycle.commandActive()).toBe(false);
    const settlement = lifecycle.settle(() => close.promise);
    await Promise.resolve();
    expect(lifecycle.busy()).toBe(true);
    expect(lifecycle.commandActive()).toBe(false);
    close.resolve();
    await settlement;
    expect(lifecycle.busy()).toBe(false);
    expect(events).toContainEqual({ busy: true, active: false });
    expect(events.at(-1)).toEqual({ busy: false, active: false });
    await expect(lifecycle.execute(async () => "new owner")).resolves.toBe(
      "new owner",
    );
    await lifecycle.settle(async () => {});
  });
  it("rejects a second command during actual execution, the awaiting-settlement gap and asynchronous rebind", async () => {
    const command = deferred<void>(),
      rebind = deferred<void>(),
      lifecycle = new ConsumerUpdateLifecycle(),
      other = vi.fn(async () => {});
    const running = lifecycle.execute(() => command.promise);
    await expect(lifecycle.execute(other)).rejects.toThrow("UPDATE_BUSY");
    command.resolve();
    await running;
    await expect(lifecycle.execute(other)).rejects.toThrow("UPDATE_BUSY");
    const settlement = lifecycle.settle(() => rebind.promise);
    await Promise.resolve();
    await expect(lifecycle.execute(other)).rejects.toThrow("UPDATE_BUSY");
    expect(other).not.toHaveBeenCalled();
    rebind.resolve();
    await settlement;
    await lifecycle.execute(other);
    expect(other).toHaveBeenCalledOnce();
    await lifecycle.settle(async () => {});
  });
  it.each([false, true])(
    "waits for the complete active command before handle close, including failure=%s",
    async (failure) => {
      const command = deferred<void>(),
        lifecycle = new ConsumerUpdateLifecycle(),
        events: string[] = [],
        close = vi.fn(async () => {
          events.push("close");
          expect(lifecycle.commandActive()).toBe(false);
        });
      const running = lifecycle.execute(async () => {
        events.push("working");
        try {
          await command.promise;
        } finally {
          events.push("command finally");
        }
      });
      const outcome = running.catch((error) => error),
        settlement = lifecycle.settle(close);
      await Promise.resolve();
      await Promise.resolve();
      expect(close).not.toHaveBeenCalled();
      expect(lifecycle.busy()).toBe(true);
      if (failure) command.reject(new Error("COMMAND_FAILED"));
      else command.resolve();
      await outcome;
      await settlement;
      expect(events).toEqual(["working", "command finally", "close"]);
      expect(close).toHaveBeenCalledOnce();
      expect(lifecycle.busy()).toBe(false);
    },
  );
  it("deduplicates queued/running settlement and ignores a second rebind callback", async () => {
    const command = deferred<void>(),
      close = deferred<void>(),
      lifecycle = new ConsumerUpdateLifecycle(),
      first = vi.fn(() => close.promise),
      second = vi.fn(async () => {});
    const running = lifecycle.execute(() => command.promise),
      settlement = lifecycle.settle(first);
    expect(lifecycle.settle(second)).toBe(settlement);
    command.resolve();
    await running;
    await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
    expect(lifecycle.settle(second)).toBe(settlement);
    close.resolve();
    await settlement;
    expect(second).not.toHaveBeenCalled();
    expect(lifecycle.busy()).toBe(false);
  });
  it("retains a failed command reservation before settlement and releases it even when rebind fails", async () => {
    const lifecycle = new ConsumerUpdateLifecycle(),
      close = deferred<void>();
    await expect(
      lifecycle.execute(async () => {
        throw new Error("COMMAND_FAILED");
      }),
    ).rejects.toThrow("COMMAND_FAILED");
    expect(lifecycle.busy()).toBe(true);
    expect(lifecycle.commandActive()).toBe(false);
    const settlement = lifecycle.settle(() => close.promise),
      outcome = settlement.catch((error) => error);
    await Promise.resolve();
    expect(lifecycle.busy()).toBe(true);
    close.reject(new Error("SETTLEMENT_FAILED"));
    await expect(outcome).resolves.toMatchObject({
      message: "SETTLEMENT_FAILED",
    });
    expect(lifecycle.busy()).toBe(false);
    await lifecycle.execute(async () => {});
    await lifecycle.settle(async () => {});
    expect(lifecycle.busy()).toBe(false);
  });
  it("reserves before command-less startup settlement can reenter command intake", async () => {
    const rebind = deferred<void>(),
      lifecycle = new ConsumerUpdateLifecycle(),
      other = vi.fn(async () => {});
    const settlement = lifecycle.settle(() => rebind.promise);
    expect(lifecycle.busy()).toBe(true);
    expect(lifecycle.commandActive()).toBe(false);
    await expect(lifecycle.execute(other)).rejects.toThrow("UPDATE_BUSY");
    rebind.resolve();
    await settlement;
    expect(other).not.toHaveBeenCalled();
    expect(lifecycle.busy()).toBe(false);
  });
  it("isolates observer errors and publishes complete state before callbacks can reenter", async () => {
    const states: { busy: boolean; active: boolean }[] = [],
      attempts: Promise<unknown>[] = [],
      lifecycle = new ConsumerUpdateLifecycle({
        changed: () => {
          states.push({
            busy: lifecycle.busy(),
            active: lifecycle.commandActive(),
          });
          if (lifecycle.busy())
            attempts.push(
              lifecycle
                .execute(async () => "forbidden")
                .catch((error) => error),
            );
          throw new Error("OBSERVER_FAILED");
        },
      });
    await expect(lifecycle.execute(async () => "accepted")).resolves.toBe(
      "accepted",
    );
    await lifecycle.settle(async () => {});
    for (const attempt of attempts)
      await expect(attempt).resolves.toMatchObject({ message: "UPDATE_BUSY" });
    expect(states[0]).toEqual({ busy: true, active: true });
    expect(states.at(-1)).toEqual({ busy: false, active: false });
  });
  it("converts a synchronous callback throw into failed command settlement without losing the reservation", async () => {
    const lifecycle = new ConsumerUpdateLifecycle();
    await expect(
      lifecycle.execute(() => {
        throw new Error("SYNCHRONOUS_FAILURE");
      }),
    ).rejects.toThrow("SYNCHRONOUS_FAILURE");
    expect(lifecycle.busy()).toBe(true);
    expect(lifecycle.commandActive()).toBe(false);
    await lifecycle.settle(async () => {});
    expect(lifecycle.busy()).toBe(false);
  });
});
